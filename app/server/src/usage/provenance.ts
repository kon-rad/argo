import type { TxClient } from '../db.js';
import { INJECTED_PROMPT_RE } from '../archive/bot.js';
import { boardEnvelope, launchSchema, type LaunchEnvelope } from './launchContract.js';
export { launchSchema, type LaunchEnvelope } from './launchContract.js';

/** Immutable envelope, with one nullable-to-native identity binding. Conflicts roll back the ingest transaction. */
export async function ingestLaunch(tx: TxClient, host: string, input: LaunchEnvelope): Promise<void> {
  const l = launchSchema.parse(input);
  const { sessionId, ...envelope } = l;
  await tx.query(`INSERT INTO usage_hosts (slug,display,kind) VALUES ($1,$1,'laptop') ON CONFLICT DO NOTHING`, [host]);
  const r = await tx.query(`INSERT INTO usage_launches AS l
    (host,source,runtime,run_id,session_id,envelope,resolved_persona,persona_status,verified_task_ids)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb,
      (SELECT name FROM org_agents WHERE name=$7 AND runtime<>'human'),
      CASE WHEN $7::text IS NULL THEN 'absent' WHEN EXISTS (SELECT 1 FROM org_agents WHERE name=$7 AND runtime<>'human') THEN 'known' ELSE 'unknown' END,
      ARRAY(SELECT id FROM cards WHERE id=ANY($8::text[]) ORDER BY id))
    ON CONFLICT (host,source,runtime,run_id) DO UPDATE SET session_id=coalesce(l.session_id,EXCLUDED.session_id)
      WHERE l.envelope=EXCLUDED.envelope AND (l.session_id IS NULL OR EXCLUDED.session_id IS NULL OR l.session_id=EXCLUDED.session_id)
    RETURNING run_id`, [host,l.source,l.runtime,l.runId,sessionId,JSON.stringify(envelope),l.persona,l.taskIds]);
  if (!r.rowCount) throw new Error('launch identity/envelope conflict');
}

/** Replay only derived associations. No messages, counters, calls or wakes are written. */
export async function replayProvenance(tx: TxClient, ids: number[], dryRun = true) {
  const out = { scanned: 0, linked: 0, changed: 0, unresolved: [] as Array<{ id: number; reason: string }> };
  const { rows } = await tx.query<{ id: number; text: string | null }>(`SELECT s.id,
    (SELECT m.content_text FROM archive_messages m WHERE m.session_id=s.id AND m.role='user'
      AND m.content_text<>'' AND m.content_text !~ $2 ORDER BY m.seq LIMIT 1) AS text
    FROM archive_sessions s WHERE s.id=ANY($1::bigint[]) ORDER BY s.id`, [ids, INJECTED_PROMPT_RE]);
  for (const s of rows) {
    out.scanned++;
    const existing = await tx.query(`SELECT 1 FROM usage_session_tasks WHERE session_id=$1 LIMIT 1`, [s.id]);
    if (existing.rowCount) continue;
    const heading = boardEnvelope(s.text ?? '');
    const card = heading ? await tx.query(`SELECT 1 FROM cards WHERE id=$1 AND title=$2`, [heading.id, heading.title]) : null;
    if (!heading || !card?.rowCount) {
      out.unresolved.push({ id: s.id, reason: heading ? 'launch heading does not match an existing card and title' : 'producer gap: no trusted launch or validated leading board envelope' });
      continue;
    }
    out.linked++;
    if (!dryRun) {
      const r = await tx.query(`INSERT INTO archive_session_tasks (session_id,task_id,evidence_id,provenance,confidence,reason)
        VALUES ($1,$2,'opening-prompt-v1','board-envelope-v1','validated-envelope','first user launch envelope with exact existing card title')
        ON CONFLICT DO NOTHING`, [s.id, heading.id]);
      out.changed += r.rowCount ?? 0;
    }
  }
  return out;
}
