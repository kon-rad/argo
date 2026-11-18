import { query } from '../db.js';
import type { readHermes } from '../archive/hermes.js';
import type { HermesCounters, UsageCall } from './types.js';
import { latest, type SourceMeasurement } from './sourceHealth.js';

/** Count source message revisions, calls and session counters still absent at the destination.
 * Compare stable source keys/content, never synced_at or snapshot receipt time.
 */
export async function hermesMeasurement(host: string, source: string, profile: string,
  data: ReturnType<typeof readHermes>, counters: HermesCounters[], calls: UsageCall[]): Promise<SourceMeasurement> {
  const ids = data.sessions.map(s => s.externalId);
  const messages = (await query(`SELECT s.external_id sid,m.external_id id,m.raw_sha sha FROM archive_messages m
    JOIN archive_sessions s ON s.id=m.session_id WHERE s.host=$1 AND s.source=$2 AND s.external_id=ANY($3::text[])`,
  [host, source, ids])).rows;
  const existingMessages = new Map(messages.map(r => [`${r.sid}|${r.id}`, r.sha]));
  const existingCalls = new Map((await query(`SELECT call_id,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens
    FROM usage_calls WHERE host=$1 AND source=$2 AND call_id=ANY($3::text[])`, [host, source, calls.map(c => c.callId)])).rows.map(r => [r.call_id, r]));
  const existingCounters = new Map((await query(`SELECT DISTINCT ON (session_id) session_id,input_tokens,output_tokens,
    cache_read_tokens,cache_write_tokens,reasoning_tokens,api_calls FROM hermes_usage_snapshots
    WHERE host=$1 AND profile=$2 AND session_id=ANY($3::text[]) ORDER BY session_id,observed_at DESC`,
  [host, profile, ids])).rows.map(r => [r.session_id, r]));
  const pending: (string | null)[] = [], accepted: (string | null)[] = [];
  const add = (ok: boolean, ts: Date | null) => (ok ? accepted : pending).push(ts?.toISOString() ?? null);
  for (const m of data.messages) add(existingMessages.get(`${m.sessionExternalId}|${m.externalId}`) === m.rawSha, m.ts);
  for (const c of calls) {
    const prev = existingCalls.get(c.callId);
    add(!!prev && Number(prev.output_tokens) >= c.outputTokens, c.ts);
  }
  for (const c of counters) {
    const prev = existingCounters.get(c.sessionId);
    const fields = ['input_tokens','output_tokens','cache_read_tokens','cache_write_tokens','reasoning_tokens','api_calls'];
    const values = [c.inputTokens,c.outputTokens,c.cacheReadTokens,c.cacheWriteTokens,c.reasoningTokens,c.apiCalls];
    add(!!prev && fields.every((k, i) => Number(prev[k]) === values[i]), c.endedAt ?? c.startedAt);
  }
  return { observedAt: [...pending, ...accepted].reduce<string | null>((best, t) => latest(best, t), null),
    importedAt: accepted.reduce<string | null>((best, t) => latest(best, t), null), backlog: pending.length, backlogUnit: 'records',
    oldestPendingAt: pending.filter((v): v is string => !!v).sort()[0] ?? null, rejected: 0, quarantined: 0 };
}
