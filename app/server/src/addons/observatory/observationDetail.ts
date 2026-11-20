import type { EvidenceEvent } from '@secondbrain/contracts/observatory';
import { fileObservation, sameChange } from '../../archive/changeEvidence.js';
import { redactor } from '../../archive/redact.js';
import { expandSteps } from '../../archive/steps.js';
import type { TxClient } from '../../db.js';
import { HttpError } from '../../routes/http.js';
import { authorizeDetail, loadWindow } from './service.js';
import { capturedRequestBinding, capturePathMatches, recordedResultPath, resultPathMatches, inspectChangeRequest, fileTarget } from './adapters.js';
/** Authorized observed bytes, never proof of agent ownership of the transition. */
export async function observationDetail(db: TxClient, event: EvidenceEvent, modules: ReadonlySet<string>) {
  await authorizeDetail(db, event, modules);
  const observation = event.fileObservation;
  if (event.source.table !== 'archive_messages' || event.kind !== 'tool_result' || event.outcome !== 'success' || !event.parent || !observation)
    throw new HttpError(404, 'no file observation');
  const row = (await db.query<{ raw: unknown; session_id: number; seq: number; ts: Date | null; host: string }>('SELECT m.session_id, m.seq, m.ts, a.host, CASE WHEN octet_length(m.raw::text) <= 1048576 THEN m.raw ELSE NULL END AS raw FROM archive_messages m JOIN archive_sessions a ON a.id=m.session_id WHERE m.id=$1', [event.source.id])).rows[0];
  if (!row) throw new HttpError(404, 'source no longer visible');
  if (row.raw === null) throw new HttpError(413, 'observation source exceeds 1 MiB');
  if (event.session !== `archive:${row.session_id}` || event.context?.host !== row.host || row.ts === null || row.ts.getTime() !== event.at || row.seq !== event.sequence) throw new HttpError(409, 'observation source identity changed; restart window');
  const raw = redactor().deep(row.raw);
  if (!observation.detailDigest || !/^[a-f0-9]{64}$/.test(observation.detailDigest) || !sameChange(fileObservation(raw), observation)) throw new HttpError(409, 'observation source changed; restart window');
  const message = (raw as { message: { toolName: string; toolCallId: string; details: Record<string, any> } }).message;
  if (message.toolName !== event.tool) throw new HttpError(409, 'observation tool changed; restart window');
  const binding = capturedRequestBinding(raw);
  const parentId = /^archive_messages:(\d+):/.exec(event.parent)?.[1];
  if (!parentId) throw new HttpError(409, 'observation parent changed; restart window');
  const parent = (await db.query<{ id: number; session_id: number; seq: number; ts: Date | null; host: string; role: string; kind: string; raw: unknown }>('SELECT m.id, m.session_id, m.seq, m.ts, a.host, m.role, m.kind, CASE WHEN octet_length(m.raw::text) <= 1048576 THEN m.raw ELSE NULL END AS raw FROM archive_messages m JOIN archive_sessions a ON a.id=m.session_id WHERE m.id=$1', [parentId])).rows[0];
  if (!parent?.raw || parent.session_id !== row.session_id || parent.host !== row.host || parent.ts === null || parent.ts.getTime() > event.at! || parent.seq >= row.seq) throw new HttpError(409, 'observation parent unavailable or changed; restart window');
  const part = expandSteps({ ...parent, text: '' }).find(p => `archive_messages:${parent.id}:${p.key}` === event.parent);
  if (part?.step !== 'tool_call' || part.toolName !== event.tool || !part.toolCallId || part.toolCallId !== message.toolCallId) throw new HttpError(409, 'observation parent tool changed; restart window');
  if (event.tool === 'inspect_change_commit') {
    const request = inspectChangeRequest(part.toolName, part.text);
    if (binding.present || !observation.commitMatch || request?.capture !== observation.id || request?.commit !== observation.commitMatch.sha)
      throw new HttpError(409, 'observation commit request changed; restart window');
  } else {
    const currentTarget = fileTarget(part.toolName, part.text);
    if (!event.target || !currentTarget || currentTarget.path !== event.target.path || !capturePathMatches(currentTarget.path, observation, binding) ||
      !resultPathMatches(currentTarget.path, recordedResultPath(raw), binding, observation)) throw new HttpError(409, 'observation request binding changed; restart window');
  }
  // Re-run the canonical bounded session adapter, including intervening calls and current usage interval identities.
  // No truncated prefix can silently hide an ambiguity: loadWindow fails closed on its existing row/body budgets.
  const current = await loadWindow(db, { from: parent.ts.getTime(), to: event.at! + 1, host: row.host, session: row.session_id }, modules);
  const paired = current.window.events.find(candidate => candidate.id === event.id);
  if (!paired || paired.parent !== event.parent || !sameChange(paired.fileObservation, observation) ||
    paired.execution !== event.execution)
    throw new HttpError(409, 'observation current pairing changed; restart window');
  const diff = (observation.origin === 'runtime-observation' ? message.details.fileObservation : message.details.change).diff;
  const detail = diff.format === 'changed-lines' ? { ...observation.diff, ...(!diff.truncated ? { hunks: diff.hunks } : {}) }
    : { format: 'replacement', truncated: diff.truncated, ...(!diff.truncated ? { before: diff.before, after: diff.after } : {}) };
  return { source: event.source, representation: 'redacted-observation-source', ownership: 'unknown', origin: observation.origin,
    observedHashes: { before: observation.observedBefore, after: observation.observedAfter }, ...(observation.commitMatch ? { commitMatch: observation.commitMatch } : {}), diff: detail };
}
