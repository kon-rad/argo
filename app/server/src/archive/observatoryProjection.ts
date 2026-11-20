import { expandSteps, type StepPart, type StepRow } from './steps.js';
import { fileTarget, recordedSender } from '../addons/observatory/adapters.js';
import { query, withTransaction, type TxClient } from '../db.js';

/** Rebuildable, content-free inputs to the existing adapter. Keys use 0 until a row ID is assigned. */
export function projectObservatory(row: Omit<StepRow, 'text'> & { text: string | null }) {
  return { version: 1, sender: recordedSender(row.raw), parts: expandSteps({ ...row, id: 0, text: row.text ?? '' }).map(part => {
    const target = part.step === 'tool_call' ? fileTarget(part.toolName, part.text) : undefined;
    // Keep this allowlist explicit: future parser detail must not enter the projection.
    return { key: part.key, step: part.step, toolName: part.toolName,
      toolCallId: part.toolCallId, isError: part.isError,
      text: target ? JSON.stringify({ path: target.path }) : '' };
  }) };
}
export interface ObservatoryProjection { version: number; sender: ReturnType<typeof recordedSender>; parts: StepPart[] }

export async function projectMessages(tx: TxClient, ids: number[]): Promise<number> {
  if (!ids.length) return 0;
  const { rows } = await tx.query<StepRow>("SELECT id, role, kind, ts, raw, coalesce(content_text, '') AS text FROM archive_messages WHERE id=ANY($1::bigint[]) FOR UPDATE", [ids]);
  const projections = rows.map(row => JSON.stringify(projectObservatory(row)));
  const result = await tx.query(`UPDATE archive_messages m SET observatory_projection=p.value::jsonb
    FROM unnest($1::bigint[], $2::text[]) p(id,value) WHERE m.id=p.id`, [rows.map(r => r.id), projections]);
  return result.rowCount ?? 0;
}
/** One bounded transaction per invocation. NULL is the durable resume queue, including concurrent edits. */
export async function backfillObservatory(batch = 100): Promise<number> {
  if (!Number.isSafeInteger(batch) || batch < 1 || batch > 200) throw new Error('observatory batch must be 1..200');
  return withTransaction(async tx => {
    const { rows } = await tx.query<{ id: number }>(`SELECT id FROM archive_messages WHERE observatory_projection IS NULL ORDER BY session_id, id LIMIT $1 FOR UPDATE SKIP LOCKED`, [batch]);
    return projectMessages(tx, rows.map(r => r.id));
  });
}
export async function observatoryCoverage() {
  return (await query(`SELECT count(*) AS records, count(*) FILTER (WHERE observatory_projection IS NULL) AS missing FROM archive_messages`)).rows[0];
}
