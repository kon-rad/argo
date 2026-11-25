import { ingestLaunch, launchSchema } from './provenance.js';
import { buildRedactor } from '../archive/redact.js';
import { eventTime, latest } from './sourceHealth.js';
import { splitJsonLines } from './lines.js';
import { createHash } from 'node:crypto';
import { query, withTransaction } from '../db.js';
import { recordHealth } from './health.js';
import { healthSchema } from './health-wire.js';
import type { Host } from '../archive/types.js';
import * as store from './store.js';
import { ingestTranscript, ingestCodex, ingestZenTrace } from './sync.js';
import type { WireLine } from './wire.js';

export interface ImportCounts { lines: number; calls: number; sessions: number; messages: number; plan: number; errors: string[]; accepted: number[]; rejected: number[]; quarantined: number[] }

/** Each line in its own transaction. A malformed line is reported and skipped; a database error rejects. */
export async function importLines(input: AsyncIterable<string> | Iterable<string>, host: Host, opts: { quarantine?: boolean } = {}): Promise<ImportCounts> {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(host)) throw new Error('invalid usage host');
  const c: ImportCounts = { lines: 0, calls: 0, sessions: 0, messages: 0, plan: 0, errors: [], accepted: [], rejected: [], quarantined: [] };
  let sawCodex = false;
  const failedPaths = new Set<string>();
  const acceptedEvents = new Map<string, string | null>();
  const redact = buildRedactor({ env: process.env });
  const reject = async (raw: string, reason: string, path: string | null = null) => {
    failedPaths.add(path ?? '');
    c.errors.push(`line ${c.lines}: ${reason}`);
    c.rejected.push(c.lines);
    if (opts.quarantine) {
      await query(`INSERT INTO usage_import_quarantine (host, digest, wire, reason, origin_path) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (host,digest) DO NOTHING`,
        [host, createHash('sha256').update(raw).digest('hex'), redact.text(raw), reason, path]);
      c.quarantined.push(c.lines);
    }
  };
  for await (const raw of input) {
    if (!raw.trim()) continue;
    c.lines++;
    let w: WireLine;
    try {
      w = JSON.parse(raw) as WireLine;
    } catch (err) {
      await reject(raw, 'invalid-json');
      continue;
    }
    // Only malformed input is a skippable bad line. A database failure below propagates so the
    // CLI exits 1 and the client keeps its cursor and resends.
    try {
      if (w?.t === 'launch') {
        const parsed = launchSchema.safeParse(w.launch);
        if (!parsed.success) { await reject(raw, 'invalid launch envelope'); continue; }
        await withTransaction(tx => ingestLaunch(tx, host, parsed.data));
      } else if (w?.t === 'health') {
        // Validate before reading any nested fields so poison health cannot block the batch.
        const health = healthSchema.parse(w.health);
        const path = health.path;
        const affected = [...failedPaths].some(p => !p || p === path || p.startsWith(path + '/'));
        const q = await query(`SELECT count(*) n FROM usage_import_quarantine WHERE host=$1
          AND (origin_path=$2 OR left(origin_path,length($2)+1)=$2||'/')`, [host, path]);
        const quarantined = Number(q.rows[0]!.n);
        const imported = [...acceptedEvents].filter(([p]) => p === path || p.startsWith(path + '/'))
          .reduce<string | null>((best, [, time]) => latest(best, time), null);
        await recordHealth(host, { ...health,
          importedAt: affected || quarantined ? imported : health.importedAt,
          quarantined, rejected: Math.max(health.rejected ?? 0, quarantined),
          outcome: affected || quarantined ? 'retry' : health.outcome,
          reason: affected || quarantined ? 'rejected' : health.reason });
      } else if (w?.t === 'transcript' && typeof w.path === 'string' && typeof w.text === 'string') {
        await withTransaction(async (tx) => {
          await tx.query('INSERT INTO usage_hosts (slug, display, kind) VALUES ($1,$1,\'laptop\') ON CONFLICT DO NOTHING', [host]);
          const r = await ingestTranscript(tx, host, w.path, Buffer.from(w.text, 'utf8'), Number(w.startLine) || 0);
          c.calls += r.calls; c.sessions += r.sessions; c.messages += r.messages;
        });
      } else if (w?.t === 'codex' && typeof w.text === 'string') {
        await withTransaction(async tx => {
          await tx.query('INSERT INTO usage_hosts (slug, display, kind) VALUES ($1,$1,\'laptop\') ON CONFLICT DO NOTHING', [host]);
          const r = await ingestCodex(tx, host, Buffer.from(w.text));
          c.calls += r.calls; c.sessions += r.sessions; c.messages += r.messages;
        });
        sawCodex = true;
      } else if (w?.t === 'zen' && typeof w.path === 'string' && typeof w.text === 'string') {
        await withTransaction(async (tx) => {
          await tx.query('INSERT INTO usage_hosts (slug, display, kind) VALUES ($1,$1,\'laptop\') ON CONFLICT DO NOTHING', [host]);
          const mtime = new Date(Number(w.mtimeMs) || Date.now());
          const r = await ingestZenTrace(tx, host, w.path, Buffer.from(w.text, 'utf8'), mtime, { wakeRunsOnly: true });
          c.calls += r.calls; c.sessions += r.sessions; c.messages += r.messages;
        });
      } else if (w?.t === 'plan' && w.snap && typeof w.snap === 'object') {
        await withTransaction(async (tx) => {
          await tx.query('INSERT INTO usage_hosts (slug, display, kind) VALUES ($1,$1,\'laptop\') ON CONFLICT DO NOTHING', [host]);
          c.plan += await store.insertPlanSnapshots(tx, [{ ...w.snap, host,
            resetsAt: w.snap.resetsAt ? new Date(w.snap.resetsAt) : null, observedAt: new Date(w.snap.observedAt) }]);
        });
      } else if (w?.t === 'calls' && Array.isArray(w.calls)) {
        await withTransaction(async (tx) => {
          await tx.query('INSERT INTO usage_hosts (slug, display, kind) VALUES ($1,$1,\'laptop\') ON CONFLICT DO NOTHING', [host]);
          c.calls += await store.upsertCalls(tx, w.calls.map((x) => ({ ...x, host, ts: new Date(x.ts) })));
        });
      } else {
        const p = (w as unknown as { path?: unknown })?.path;
        await reject(raw, 'invalid-wire', typeof p === 'string' ? p : null);
        continue;
      }
      if ('text' in w && typeof w.text === 'string' && 'path' in w && typeof w.path === 'string') {
        const time = splitJsonLines(Buffer.from(w.text)).records.reduce<string | null>((best, r) => latest(best, eventTime(r)), null);
        acceptedEvents.set(w.path, latest(acceptedEvents.get(w.path), time));
      }
      c.accepted.push(c.lines);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if ((code && /^2[23]/.test(code)) || err instanceof RangeError || (err as Error).name === 'ZodError') {
        await reject(raw, 'invalid-item', 'path' in w && typeof w.path === 'string' ? w.path : null);
      } else throw err; // interrupted imports and operational failures always retain the cursor
    }
  }
  // Laptop pushes and dispatcher logs arrive independently. Reconcile once per
  // batch, before acknowledgement, so an operational failure keeps the cursor.
  if (sawCodex) await withTransaction((tx) => store.attachCallsToRuns(tx, host));
  return c;
}
