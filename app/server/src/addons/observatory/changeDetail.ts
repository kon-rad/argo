import type { EvidenceEvent } from '@secondbrain/contracts/observatory';
import { capturedChange, sameChange } from '../../archive/changeEvidence.js';
import { redactor } from '../../archive/redact.js';
import type { TxClient } from '../../db.js';
import { HttpError } from '../../routes/http.js';
import { authorizeDetail } from './service.js';
import { capturedRequestBinding, capturePathMatches } from './adapters.js';
/** A bounded current source representation. Original byte hashes predate redaction. */
export async function changeDetail(db: TxClient, event: EvidenceEvent, modules: ReadonlySet<string>) {
  await authorizeDetail(db, event, modules);
  if (event.source.table !== 'archive_messages' || event.outcome !== 'success' || !event.change) throw new HttpError(404, 'no captured change');
  const row = (await db.query<{ raw: unknown }>('SELECT CASE WHEN octet_length(raw::text) <= 1048576 THEN raw ELSE NULL END AS raw FROM archive_messages WHERE id=$1', [event.source.id])).rows[0];
  if (!row) throw new HttpError(404, 'source no longer visible');
  if (row.raw === null) throw new HttpError(413, 'captured source exceeds 1 MiB');
  const raw = redactor().deep(row.raw);
  if (!sameChange(capturedChange(raw), event.change)) throw new HttpError(409, 'captured source changed; restart window');
  const binding = capturedRequestBinding(raw);
  if ((raw as { message: { toolName: string } }).message.toolName !== event.tool) throw new HttpError(409, 'captured tool changed; restart window');
  if (event.tool === 'inspect_change_commit' ? binding.present :
    !event.target || !capturePathMatches(event.target.path, event.change, binding)) throw new HttpError(409, 'captured request binding changed; restart window');
  // capturedChange validated the bounded union above, including every hunk.
  const diff = (raw as { message: { details: { change: { diff: Record<string, unknown> & { format: string; truncated: boolean } } } } }).message.details.change.diff;
  const detail = diff.format === 'changed-lines'
    ? { ...event.change.diff, ...(!diff.truncated ? { hunks: diff.hunks } : {}) }
    : { format: 'replacement', truncated: diff.truncated, ...(!diff.truncated ? { before: diff.before, after: diff.after } : {}) };
  return { source: event.source, representation: 'redacted-source', originalHashes: { before: event.change.before, after: event.change.after },
    diff: detail };
}
