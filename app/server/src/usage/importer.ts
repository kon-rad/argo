import { withTransaction } from '../db.js';
import type { Host } from '../archive/types.js';
import * as store from './store.js';
import { ingestTranscript } from './sync.js';
import type { WireLine } from './wire.js';

export interface ImportCounts { lines: number; calls: number; sessions: number; messages: number; plan: number; errors: string[] }

/** Each line in its own transaction. A malformed line is reported and skipped; a database error rejects. */
export async function importLines(input: AsyncIterable<string> | Iterable<string>, host: Host): Promise<ImportCounts> {
  const c: ImportCounts = { lines: 0, calls: 0, sessions: 0, messages: 0, plan: 0, errors: [] };
  for await (const raw of input) {
    if (!raw.trim()) continue;
    c.lines++;
    let w: WireLine;
    try {
      w = JSON.parse(raw) as WireLine;
    } catch (err) {
      c.errors.push(`line ${c.lines}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    // Only malformed input is a skippable bad line. A database failure below propagates so the
    // CLI exits 1 and the Mac keeps its cursor and resends.
    if (w?.t === 'transcript' && typeof w.path === 'string' && typeof w.text === 'string') {
      await withTransaction(async (tx) => {
        const r = await ingestTranscript(tx, host, w.path, Buffer.from(w.text, 'utf8'), Number(w.startLine) || 0);
        c.calls += r.calls; c.sessions += r.sessions; c.messages += r.messages;
      });
    } else if (w?.t === 'plan' && w.snap && typeof w.snap === 'object') {
      await withTransaction(async (tx) => {
        c.plan += await store.insertPlanSnapshots(tx, [{ ...w.snap, host,
          resetsAt: w.snap.resetsAt ? new Date(w.snap.resetsAt) : null, observedAt: new Date(w.snap.observedAt) }]);
      });
    } else if (w?.t === 'calls' && Array.isArray(w.calls)) {
      await withTransaction(async (tx) => {
        c.calls += await store.upsertCalls(tx, w.calls.map((x) => ({ ...x, host, ts: new Date(x.ts) })));
      });
    } else {
      c.errors.push(`line ${c.lines}: unknown line type ${JSON.stringify((w as { t?: unknown } | null)?.t)}`);
    }
  }
  return c;
}
