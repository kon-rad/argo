import { execFile } from 'node:child_process';
import { query, withTransaction } from './db.js';

/**
 * Ultrahuman ring data, as the cyberdeck Pi pushes it to the droplet's
 * ring-ingest service (ops/ring-ingest in this repo). The server's
 * tables are the source of truth; the Mac keeps a mirror via pullRing().
 */

export const RING_TABLES = ['ring_raw', 'ring_daily', 'ring_samples', 'ring_sleep_stages'] as const;

const NIGHT_COLUMNS = `day::text AS day, sleep_score, total_sleep_min, time_in_bed_min, deep_min, rem_min,
  light_min, awake_min, sleep_efficiency_pct, restorative_pct, temp_deviation_c, spo2_pct,
  bedtime_start, bedtime_end, steps_total, hrv_avg, sleep_hrv, sleep_rhr, recovery_index,
  movement_index, active_min, vo2_max`;

export async function ringOverview(days = 30): Promise<{
  days: Record<string, unknown>[];
  total_days: number;
  last_received: string | null;
}> {
  const { rows } = await query(
    `SELECT ${NIGHT_COLUMNS} FROM ring_daily ORDER BY day DESC LIMIT $1`,
    [days],
  );
  const meta = await query<{ n: number; last: string | null }>(
    `SELECT count(*)::int AS n, max(received_at)::text AS last FROM ring_raw`,
  );
  return { days: rows, total_days: meta.rows[0]?.n ?? 0, last_received: meta.rows[0]?.last ?? null };
}

/** One night in full: the daily row, its hypnogram, and the in-bed heart rate. */
export async function ringNight(day: string): Promise<{
  day: Record<string, unknown> | null;
  stages: { start: number; end: number; stage: string }[];
  heart_rate: { ts: number; value: number }[];
  hrv: { ts: number; value: number }[];
}> {
  const daily = await query(`SELECT ${NIGHT_COLUMNS} FROM ring_daily WHERE day = $1`, [day]);
  const stages = await query<{ start: number; end: number; stage: string }>(
    `SELECT start, "end", stage FROM ring_sleep_stages WHERE day = $1 ORDER BY start`,
    [day],
  );
  const series = async (metric: string) =>
    (
      await query<{ ts: number; value: number }>(
        `SELECT ts, value FROM ring_samples WHERE day = $1 AND metric = $2 AND value IS NOT NULL ORDER BY ts`,
        [day, metric],
      )
    ).rows;
  return {
    day: daily.rows[0] ?? null,
    stages: stages.rows,
    heart_rate: await series('sleep_hr'),
    hrv: await series('sleep_hrv'),
  };
}

export type RingDump = Record<(typeof RING_TABLES)[number], unknown[]>;

/** The SQL the droplet runs: every ring table as one JSON document on stdout. */
export const DUMP_SQL = `SELECT json_build_object(${RING_TABLES.map(
  (t) => `'${t}', (SELECT coalesce(json_agg(x), '[]'::json) FROM ${t} x)`,
).join(', ')});`;

/** Reads the droplet's ring tables over ssh (psql reads the SQL from stdin, so nothing needs shell quoting). */
export function fetchRemoteDump(host: string, db: string, timeoutMs = 60_000): Promise<RingDump> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', host, `sudo -u postgres psql -d ${db} -At -v ON_ERROR_STOP=1`],
      { timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`ssh ${host} failed: ${(stderr || err.message).trim().slice(0, 300)}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout) as RingDump);
        } catch {
          reject(new Error(`ssh ${host} returned something that is not the ring dump`));
        }
      },
    );
    child.stdin?.end(DUMP_SQL);
  });
}

/**
 * Replaces the local ring tables with the dump, in one transaction: a failed
 * pull leaves the old mirror intact. Rows are matched by column name, so the
 * two schemas only have to agree on names, not order.
 */
export async function replaceRing(dump: RingDump): Promise<Record<string, number>> {
  for (const t of RING_TABLES) {
    if (!Array.isArray(dump[t])) throw new Error(`the dump has no ${t} array`);
  }
  return withTransaction(async (tx) => {
    const counts: Record<string, number> = {};
    // Children first is not needed (no foreign keys), but keep a fixed order.
    for (const t of RING_TABLES) {
      await tx.query(`DELETE FROM ${t}`);
      const res = await tx.query(
        `INSERT INTO ${t} SELECT * FROM json_populate_recordset(NULL::${t}, $1::json)`,
        [JSON.stringify(dump[t])],
      );
      counts[t] = res.rowCount ?? 0;
    }
    return counts;
  });
}

export async function pullRing(
  host: string,
  db: string,
  fetchDump: (host: string, db: string) => Promise<RingDump> = fetchRemoteDump,
): Promise<Record<string, number>> {
  return replaceRing(await fetchDump(host, db));
}
