import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { query, withTransaction } from '../db.js';
import { snapshotSqlite } from '../archive/collect.js';
import { readHermes } from '../archive/hermes.js';
import * as store from '../archive/store.js';
import type { Host } from '../archive/types.js';
import { readHermesCounters } from '../usage/hermesCounters.js';
import { findHomes, hermesTimezone, type HermesHome } from './homes.js';
import { recordHermesCounters } from '../usage/store.js';

/**
 * Copies what Hermes knows about its conversations and cron jobs into
 * Postgres, for the Agents and Cron pages. Runs where Hermes runs (a systemd
 * timer on the droplet, as the hermes user) because Hermes holds its SQLite
 * files open: each one is snapshotted with SQLite's backup API first, never
 * read in place. Every write is an idempotent upsert, so a run with nothing
 * new changes nothing and a failed run is safe to repeat.
 */

export { findHomes, hermesTimezone, type HermesHome } from './homes.js';

export interface SyncCounts {
  homes: number;
  sessions: number;
  messages: number;
  jobs: number;
  runs: number;
  outputs: number;
  usage: number;
  errors: string[];
}

/** Milliseconds `tz` is ahead of UTC at instant `ms`. */
function tzOffset(ms: number, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  return asUtc - ms;
}

/** `2026-10-11_07-17-37.md`, written in Hermes's local time → the UTC instant. */
export function outputRunAt(fileName: string, tz: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/.exec(fileName);
  if (!m) return null;
  const guess = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
  // Two passes settle the offset even right next to a DST change.
  let ms = guess - tzOffset(guess, tz);
  ms = guess - tzOffset(ms, tz);
  return new Date(ms);
}

const date = (v: unknown): Date | null => {
  if (typeof v !== 'string' || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' && v !== 'None' ? v : null);
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

async function syncSessions(home: HermesHome, host: Host, tz: string | null, tmp: string, c: SyncCounts): Promise<void> {
  const src = join(home.dir, 'state.db');
  if (!existsSync(src)) return;
  const copy = join(tmp, `${home.profile}-state.db`);
  await snapshotSqlite(src, copy);
  const { sessions, messages } = readHermes(copy, host);
  const counters = readHermesCounters(copy, host, home.profile);
  // The main home keeps the archive's source name, so its rows line up with `secondbrain archive`.
  const source = home.profile === 'main' ? ('hermes' as const) : (`hermes:${home.profile}` as const);
  await withTransaction(async (tx) => {
    const ids = new Map<string, number>();
    for (const s of sessions) {
      const r = await store.upsertSession(tx, {
        ...s, source, meta: { ...s.meta, profile: home.profile, timezone: tz },
      });
      ids.set(s.externalId, r.id);
      if (r.changed) c.sessions++;
    }
    const bySession = new Map<string, typeof messages>();
    for (const m of messages) {
      if (!ids.has(m.sessionExternalId)) continue;
      (bySession.get(m.sessionExternalId) ?? bySession.set(m.sessionExternalId, []).get(m.sessionExternalId)!).push(m);
    }
    for (const [sid, msgs] of bySession) c.messages += await store.upsertMessages(tx, ids.get(sid)!, msgs);
    c.usage += await recordHermesCounters(tx, counters, new Date());
  });
}

async function syncCron(home: HermesHome, tz: string | null, tmp: string, c: SyncCounts): Promise<void> {
  const cron = join(home.dir, 'cron');
  if (!existsSync(cron)) return;

  const jobsFile = join(cron, 'jobs.json');
  const parsed: unknown = existsSync(jobsFile) ? JSON.parse(readFileSync(jobsFile, 'utf8')) : [];
  const jobs = (Array.isArray(parsed) ? parsed : ((parsed as { jobs?: unknown[] }).jobs ?? [])) as Record<string, unknown>[];

  let runs: Record<string, unknown>[] = [];
  const execDb = join(cron, 'executions.db');
  if (existsSync(execDb)) {
    const copy = join(tmp, `${home.profile}-executions.db`);
    await snapshotSqlite(execDb, copy);
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      runs = db.prepare('SELECT * FROM executions').all() as Record<string, unknown>[];
    } finally {
      db.close();
    }
  }

  const outputs: { job: string; file: string; content: string }[] = [];
  const outDir = join(cron, 'output');
  if (existsSync(outDir)) {
    for (const job of readdirSync(outDir)) {
      const dir = join(outDir, job);
      if (!statSync(dir).isDirectory()) continue;
      for (const file of readdirSync(dir)) {
        if (!/\.(md|txt)$/.test(file)) continue;
        outputs.push({ job, file, content: readFileSync(join(dir, file), 'utf8') });
      }
    }
  }

  await withTransaction(async (tx) => {
    for (const j of jobs) {
      const id = text(j.id);
      if (!id) continue;
      const schedule = j.schedule as { display?: string; expr?: string; run_at?: string } | null;
      const r = await tx.query(
        `INSERT INTO cron_jobs AS c (profile, job_id, name, schedule, state, enabled, next_run_at, last_run_at,
           last_status, last_error, deliver, skill, script, prompt, timezone, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
         ON CONFLICT (profile, job_id) DO UPDATE SET name=EXCLUDED.name, schedule=EXCLUDED.schedule,
           state=EXCLUDED.state, enabled=EXCLUDED.enabled, next_run_at=EXCLUDED.next_run_at,
           last_run_at=EXCLUDED.last_run_at, last_status=EXCLUDED.last_status, last_error=EXCLUDED.last_error,
           deliver=EXCLUDED.deliver, skill=EXCLUDED.skill, script=EXCLUDED.script, prompt=EXCLUDED.prompt,
           timezone=EXCLUDED.timezone, raw=EXCLUDED.raw, last_seen_at=now(), removed_at=NULL
         WHERE c.raw IS DISTINCT FROM EXCLUDED.raw OR c.removed_at IS NOT NULL OR c.timezone IS DISTINCT FROM EXCLUDED.timezone`,
        [home.profile, id, text(j.name) ?? id,
          text(j.schedule_display) ?? schedule?.display ?? schedule?.expr ?? schedule?.run_at ?? null,
          text(j.state), j.enabled !== false, date(j.next_run_at), date(j.last_run_at), text(j.last_status),
          text(j.last_error), text(j.deliver), text(j.skill), text(j.script), text(j.prompt), tz, JSON.stringify(j)],
      );
      c.jobs += r.rowCount ?? 0;
    }
    // A job deleted in Hermes stays here with its history, marked as removed.
    await tx.query(
      `UPDATE cron_jobs SET removed_at=now() WHERE profile=$1 AND removed_at IS NULL AND NOT (job_id = ANY($2::text[]))`,
      [home.profile, jobs.map((j) => text(j.id)).filter(Boolean)],
    );

    for (const r of runs) {
      const res = await tx.query(
        `INSERT INTO cron_runs AS c (profile, id, job_id, status, claimed_at, started_at, finished_at, error, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
         ON CONFLICT (profile, id) DO UPDATE SET status=EXCLUDED.status, started_at=EXCLUDED.started_at,
           finished_at=EXCLUDED.finished_at, error=EXCLUDED.error, raw=EXCLUDED.raw
         WHERE c.raw IS DISTINCT FROM EXCLUDED.raw`,
        [home.profile, String(r.id), String(r.job_id), String(r.status), date(r.claimed_at), date(r.started_at),
          date(r.finished_at), text(r.error), JSON.stringify(r)],
      );
      c.runs += res.rowCount ?? 0;
    }

    for (const o of outputs) {
      const res = await tx.query(
        `INSERT INTO cron_outputs AS c (profile, job_id, file_name, run_at, content, content_sha)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (profile, job_id, file_name) DO UPDATE SET run_at=EXCLUDED.run_at, content=EXCLUDED.content,
           content_sha=EXCLUDED.content_sha, synced_at=now()
         WHERE c.content_sha IS DISTINCT FROM EXCLUDED.content_sha OR c.run_at IS DISTINCT FROM EXCLUDED.run_at`,
        [home.profile, o.job, o.file, outputRunAt(o.file, tz ?? 'UTC'), o.content, sha(o.content)],
      );
      c.outputs += res.rowCount ?? 0;
    }
  });
}

export async function syncAgents(root: string, host: Host): Promise<SyncCounts> {
  const counts: SyncCounts = { homes: 0, sessions: 0, messages: 0, jobs: 0, runs: 0, outputs: 0, usage: 0, errors: [] };
  const tz = hermesTimezone(root);
  const tmp = mkdtempSync(join(tmpdir(), 'agents-sync-'));
  try {
    for (const home of findHomes(root)) {
      counts.homes++;
      // One broken profile must not stop the others.
      try {
        await syncSessions(home, host, tz, tmp, counts);
      } catch (err) {
        counts.errors.push(`${home.profile} sessions: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        await syncCron(home, tz, tmp, counts);
      } catch (err) {
        counts.errors.push(`${home.profile} cron: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    // The snapshots hold plaintext conversations; never leave them behind.
    rmSync(tmp, { recursive: true, force: true });
  }
  await query(`INSERT INTO agents_sync_runs (host, counts) VALUES ($1, $2::jsonb)`, [host, JSON.stringify(counts)]);
  return counts;
}
