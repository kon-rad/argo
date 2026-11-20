import { query, withTransaction } from '../db.js';
import { deriveMessage } from './store.js';
import { RESULT_PARSER_VERSION, toolResult } from './toolResult.js';
import type { ParsedMessage } from './types.js';

export interface ResultScope {
  runtime: 'codex' | 'hermes';
  sessionId?: number;
  seq?: number;
  from?: string;
  to?: string;
  dryRun: boolean;
  batch?: number;
}

/** Supported derived-only importer replay. No session, raw, identity or token writes. */
export async function replayResults(scope: ResultScope): Promise<{ scanned: number; changed: number; failures: number; successes: number; unknown: number }> {
  if (typeof scope.dryRun !== 'boolean') throw new Error('dryRun must be explicit');
  if (!['codex', 'hermes'].includes(scope.runtime)) throw new Error('runtime must be codex or hermes');
  if (scope.sessionId === undefined && (!scope.from || !scope.to)) throw new Error('select a session or a bounded from/to window');
  if (scope.sessionId !== undefined && (!Number.isSafeInteger(scope.sessionId) || scope.sessionId < 1)) throw new Error('invalid session id');
  if (scope.seq !== undefined && (scope.sessionId === undefined || !Number.isSafeInteger(scope.seq) || scope.seq < 0)) throw new Error('seq requires a session and a nonnegative integer');
  if ((scope.from && !Number.isFinite(Date.parse(scope.from))) || (scope.to && !Number.isFinite(Date.parse(scope.to))) || (scope.from && scope.to && Date.parse(scope.from) >= Date.parse(scope.to))) throw new Error('invalid date window');
  const batch = scope.batch ?? 500;
  if (!Number.isSafeInteger(batch) || batch < 1 || batch > 10000) throw new Error('invalid batch');
  const stats = { scanned: 0, changed: 0, failures: 0, successes: 0, unknown: 0 };
  let after = 0;
  for (;;) {
    const { rows } = await query<ParsedMessage & { id: number; sessionId: number; version: number | null; storedError: boolean | null }>(
      `SELECT m.id, m.session_id AS "sessionId", m.seq, m.external_id AS "externalId", m.parent_external_id AS "parentExternalId",
        m.role, m.kind, m.ts, m.content_text AS "contentText", m.raw, m.raw_sha AS "rawSha", m.is_sidechain AS "isSidechain",
        m.result_parser_version AS version, m.is_error AS "storedError"
       FROM archive_messages m JOIN archive_sessions s ON s.id=m.session_id
       WHERE s.harness=$1 AND m.id>$2 AND ($3::bigint IS NULL OR s.id=$3) AND ($4::bigint IS NULL OR m.seq=$4)
         AND ($5::timestamptz IS NULL OR m.ts >= $5) AND ($6::timestamptz IS NULL OR m.ts < $6)
       ORDER BY m.id LIMIT $7`, [scope.runtime, after, scope.sessionId ?? null, scope.seq ?? null, scope.from ?? null, scope.to ?? null, batch]);
    if (!rows.length) break;
    for (const row of rows) {
      after = row.id;
      const result = toolResult(row.raw);
      if (!result) continue;
      stats.scanned++;
      stats[result.isError === true ? 'failures' : result.isError === false ? 'successes' : 'unknown']++;
      const d = deriveMessage(row.raw, row.contentText);
      if (row.version === RESULT_PARSER_VERSION && row.contentText === d.contentText && row.storedError === d.isError) continue;
      if (scope.dryRun) stats.changed++;
      else {
        // Same importer as live ingestion, but raw/identity are deliberately kept
        // out of this derived-only UPDATE, including JSON integers and timestamps.
        stats.changed += await withTransaction(async tx => {
          const snapshot = await tx.query('SELECT id FROM archive_messages WHERE id=$1 AND raw_sha=$2 FOR UPDATE', [row.id, row.rawSha]);
          if (!snapshot.rowCount) throw new Error('source changed during replay; retry scope');
          await tx.query(`UPDATE archive_messages SET content_text=$2, step=$3, tool_names=$4, tool_call_id=$5, is_error=$6, result_parser_version=$7 WHERE id=$1`,
            [row.id, d.contentText, d.step, d.toolNames.length ? d.toolNames : null, d.toolCallId, d.isError, d.version]);
          return 1;
        });
      }
    }
  }
  return stats;
}
