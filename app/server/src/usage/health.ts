import { query, withTransaction } from '../db.js';
import { healthSchema, streamState, type ExpectedStream } from './health-wire.js';

/** The authenticated transport supplies host. Never take it from the body. */
export async function recordHealth(host: string, input: unknown): Promise<void> {
  const h = healthSchema.parse(input);
  const now = Date.now();
  for (const t of [h.startedAt, h.endedAt, h.observedAt, h.importedAt, h.oldestPendingAt]) {
    if (t && Date.parse(t) > now + 300_000) throw new Error('health clock ahead');
  }
  await withTransaction(async tx => {
    await tx.query(`INSERT INTO usage_hosts (slug,display,kind) VALUES ($1,$1,'laptop') ON CONFLICT DO NOTHING`, [host]);
    const values = [host, h.collectorInstance, h.runtime, h.path, h.attemptSeq, h.collectorVersion, h.startedAt, h.endedAt,
      h.outcome, h.observedAt, h.importedAt, h.backlog, h.oldestPendingAt, h.rejected, h.quarantined, h.reason, h.capabilities, h.backlogUnit ?? null];
    const cols = 'host,collector_instance,runtime,path,attempt_seq,collector_version,started_at,ended_at,outcome,observed_at,imported_at,backlog,oldest_pending_at,rejected,quarantined,reason,capabilities,backlog_unit';
    const params = values.map((_, i) => `$${i + 1}`).join(',');
    await tx.query(`INSERT INTO collection_attempts (${cols}) VALUES (${params}) ON CONFLICT DO NOTHING`, values);
    await tx.query(`INSERT INTO collection_streams (${cols},last_success_at) VALUES (${params},CASE WHEN $9='ok' THEN now() END)
      ON CONFLICT (host,collector_instance,runtime,path) DO UPDATE SET
      attempt_seq=excluded.attempt_seq,collector_version=excluded.collector_version,started_at=excluded.started_at,
      ended_at=excluded.ended_at,received_at=excluded.received_at,outcome=excluded.outcome,
      observed_at=greatest(collection_streams.observed_at,excluded.observed_at),
      imported_at=greatest(collection_streams.imported_at,excluded.imported_at),backlog=excluded.backlog,
      oldest_pending_at=excluded.oldest_pending_at,rejected=excluded.rejected,quarantined=excluded.quarantined,
      reason=excluded.reason,capabilities=excluded.capabilities,backlog_unit=excluded.backlog_unit,
      last_success_at=coalesce(excluded.last_success_at,collection_streams.last_success_at)
      WHERE excluded.attempt_seq > collection_streams.attempt_seq`, values);
    // At most 30 days and 1000 attempts per stream; latest state survives pruning.
    await tx.query(`DELETE FROM collection_attempts WHERE host=$1 AND collector_instance=$2 AND runtime=$3 AND path=$4
      AND (received_at < now()-interval '30 days' OR attempt_seq < $5-999)`, values.slice(0, 5));
  });
  await cleanupAttempts();
}

export async function collectionHealth(expected: ExpectedStream[]) {
  const { rows } = await query<{ host: string; collector_instance: string; runtime: string; path: string; received_at: Date; outcome: string; backlog: string | null }>(`SELECT * FROM collection_streams ORDER BY host,runtime,path,collector_instance`);
  const key = (x: { host: string; collectorInstance: string; runtime: string; path: string }) => JSON.stringify([x.host, x.collectorInstance, x.runtime, x.path]);
  const pending = new Map(expected.map(x => [key(x), x]));
  const streams: Record<string, unknown>[] = rows.map(row => {
    const k = key({ host: row.host, collectorInstance: row.collector_instance, runtime: row.runtime, path: row.path });
    const e = pending.get(k); pending.delete(k);
    return { ...row, state: e && e.state !== 'enabled' ? e.state : streamState(row, e?.intervalSec), expected: !!e };
  });
  for (const e of pending.values()) streams.push({ host: e.host, collector_instance: e.collectorInstance, runtime: e.runtime,
    path: e.path, state: e.state === 'enabled' ? 'unknown' : e.state, expected: true });
  return { streams };
}

/** Bounded global expiry also covers hosts/paths that never report again. */
export async function cleanupAttempts(limit = 1000): Promise<number> {
  const result = await query(`DELETE FROM collection_attempts WHERE ctid IN
    (SELECT ctid FROM collection_attempts WHERE received_at < now()-interval '30 days'
     ORDER BY received_at LIMIT $1)`, [Math.max(1, Math.min(10000, limit))]);
  return result.rowCount ?? 0;
}
