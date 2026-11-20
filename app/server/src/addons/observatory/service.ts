import type { EvidenceEvent, ExecutionInterval, ReplayWindow, SourceTable } from '@secondbrain/contracts/observatory';
import { withTransaction, type TxClient } from '../../db.js';
import { HttpError } from '../../routes/http.js';
import { archiveEvents, envelope, instant, makeWindow, type ArchiveRow } from './adapters.js';

export interface Range { from: number; to: number; host?: string; session?: number }
export interface Diagnostics {
  sessionsWithoutIntervals?: number; untimed: number; unknownIntervals: number; ambiguousSessions: number; unpairedResults: number;
  humanOrigin: 'unknown'; liveExecutions: 'unsupported'; historicalCompleteness: 'unknown'; truncated: number;
}
export interface ExportData { window: ReplayWindow; diagnostics: Diagnostics; refs: Partial<Record<SourceTable, string[]>> }
const LIMIT = 5000;
const sources: Record<SourceTable, string> = { archive_messages: 'usage', usage_calls: 'usage', usage_runs: 'usage', card_events: 'board', org_messages: 'org' };
export const sourceEnabled = (table: SourceTable, modules: ReadonlySet<string>): boolean => modules.has(sources[table]);
function bounded<T>(rows: T[]): T[] {
  if (rows.length > LIMIT) throw new HttpError(413, 'evidence exceeds 5000 records; narrow range or select a session');
  return rows;
}
/** No SET ROLE or security-definer function. Same pool/role as the source viewers. */
export async function readSnapshot<T>(fn: (db: TxClient) => Promise<T>): Promise<T> {
  try {
    return await withTransaction(async db => {
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await db.query("SET LOCAL statement_timeout = '3000ms'");
      return fn(db);
    });
  } catch (error) {
    if ((error as { code?: string }).code === '42501') throw new HttpError(403, 'source permission denied');
    if ((error as { code?: string }).code === '57014') throw new HttpError(503, 'source query budget exceeded; narrow range');
    throw error;
  }
}

export async function loadWindow(db: TxClient, range: Range, modules: ReadonlySet<string>, vaultRoot?: string): Promise<ExportData> {
  const { from, to, host, session } = range;
  const args = [new Date(from), new Date(to), host ?? null, session ?? null];
  const events: EvidenceEvent[] = [];
  const intervals: ExecutionInterval[] = [];
  const diagnostics: Diagnostics = { untimed: 0, unknownIntervals: 0, ambiguousSessions: 0, unpairedResults: 0,
    humanOrigin: 'unknown', liveExecutions: 'unsupported', historicalCompleteness: 'unknown', truncated: 0 };
  if (modules.has('usage')) {
    // Read the complete bounded history of sessions touching the window for pairing and boundary state.
    // EXISTS prevents the archive x run x call multiplication found in a naive session join.
    const messages = bounded((await db.query<ArchiveRow>(`SELECT m.id, m.session_id, m.seq, m.ts, m.role, m.kind, CASE WHEN sum(octet_length(m.raw::text)) OVER () <= 4194304 THEN m.raw ELSE '{"observatory_oversized":true}'::jsonb END AS raw,
        ''::text AS text, a.host, a.source, a.external_id, a.harness, NULL::timestamptz AS observed_at
      FROM archive_messages m JOIN archive_sessions a ON a.id = m.session_id
      WHERE ($3::text IS NULL OR a.host = $3) AND ($4::bigint IS NULL OR a.id = $4)
        AND (m.ts < $2 OR m.ts IS NULL)
        AND (EXISTS (SELECT 1 FROM archive_messages w WHERE w.session_id = a.id AND w.ts >= $1 AND w.ts < $2)
          OR EXISTS (SELECT 1 FROM usage_runs r WHERE r.host = a.host AND r.session_id = a.external_id
            AND coalesce(r.runtime, 'claude-code') = a.source AND r.started_at < $2 AND r.ended_at > $1))
      ORDER BY m.session_id, m.seq, m.id LIMIT 5001`, args)).rows);
    if (messages.some(m => (m.raw as { observatory_oversized?: boolean })?.observatory_oversized)) throw new HttpError(413, 'archive source exceeds 4 MiB; narrow range or select a session');
    events.push(...archiveEvents(messages, vaultRoot));
    const runs = bounded((await db.query<{ host: string; run_id: string; session_id: string; runtime: string; agent_name: string | null; task_id: string | null; started_at: Date | null; ended_at: Date | null; archive_ids: number[] }>(
      `SELECT r.host, r.run_id, r.session_id, coalesce(r.runtime, 'claude-code') AS runtime, r.agent_name, r.task_id, r.started_at, r.ended_at,
        ARRAY(SELECT a.id FROM archive_sessions a WHERE a.host = r.host AND a.source = coalesce(r.runtime, 'claude-code') AND a.external_id = r.session_id) AS archive_ids
       FROM usage_runs r WHERE ($3::text IS NULL OR r.host = $3)
        AND ($4::bigint IS NULL OR EXISTS (SELECT 1 FROM archive_sessions a WHERE a.id = $4 AND a.host = r.host AND a.source = coalesce(r.runtime, 'claude-code') AND a.external_id = r.session_id))
        AND (r.started_at IS NULL OR r.started_at < $2) AND (r.ended_at IS NULL OR r.ended_at > $1)
       ORDER BY r.host, r.run_id LIMIT 5001`, args)).rows);
    for (const r of runs) {
      const start = instant(r.started_at), end = instant(r.ended_at);
      if (r.archive_ids.length > 1) diagnostics.ambiguousSessions++;
      if (start === null || end === null || end <= start) { diagnostics.unknownIntervals++; continue; }
      intervals.push({ id: `run:${encodeURIComponent(r.host)}:${encodeURIComponent(r.run_id)}`, session: r.archive_ids.length === 1 ? `archive:${r.archive_ids[0]}` : null,
        start, end, host: r.host, runtime: r.runtime, persona: r.agent_name, ticket: r.task_id, evidence: 'usage_runs' });
    }
    const calls = bounded((await db.query<{ id: number; ts: Date; model: string; input_tokens: number; output_tokens: number; thinking_tokens: number; archive_ids: number[]; host: string; run_id: string | null }>(
      `SELECT u.id, u.ts, u.model, u.input_tokens, u.output_tokens, u.thinking_tokens, u.host, u.run_id,
        ARRAY(SELECT a.id FROM archive_sessions a WHERE a.host = u.host AND a.source = u.source AND a.external_id = u.session_external_id) AS archive_ids
       FROM usage_calls u WHERE u.ts >= $1 AND u.ts < $2 AND ($3::text IS NULL OR u.host = $3)
        AND ($4::bigint IS NULL OR EXISTS (SELECT 1 FROM archive_sessions a WHERE a.id = $4 AND a.host = u.host AND a.source = u.source AND a.external_id = u.session_external_id))
       ORDER BY u.ts, u.id LIMIT 5001`, args)).rows);
    for (const u of calls) {
      const e = envelope('usage_calls', String(u.id), instant(u.ts), 'usage');
      e.session = u.archive_ids.length === 1 ? `archive:${u.archive_ids[0]}` : null;
      e.execution = u.run_id ? `run:${encodeURIComponent(u.host)}:${encodeURIComponent(u.run_id)}` : null;
      e.usage = { model: u.model, input: Number(u.input_tokens), output: Number(u.output_tokens), reasoning: Number(u.thinking_tokens) };
      events.push(e);
    }
  }
  // Host/session filters cannot be truthfully applied to board/org rows with no recorded host/session.
  if (!host && !session && modules.has('board')) {
    const rows = bounded((await db.query<{ id: number; card_id: string; kind: string; actor: string | null; at: Date; status: string | null }>(
      `WITH states AS (
         SELECT id, card_id, kind, actor, at,
           CASE WHEN kind = 'created' THEN payload->>'status' WHEN kind = 'moved' THEN payload->>'to'
             WHEN kind = 'claimed' THEN 'running' WHEN kind = 'blocked' THEN 'blocked'
             WHEN kind = 'finished' THEN CASE payload->>'outcome' WHEN 'done' THEN 'done' WHEN 'partial' THEN 'ready' ELSE 'unknown' END
             WHEN kind IN ('assigned', 'reclaimed', 'linked') THEN 'unknown' END AS status
         FROM card_events WHERE at < $2),
       previous AS (SELECT DISTINCT ON (card_id) * FROM states WHERE at < $1 AND status IS NOT NULL ORDER BY card_id, at DESC, id DESC)
       SELECT * FROM previous UNION ALL SELECT * FROM states WHERE at >= $1 ORDER BY at, id LIMIT 5001`, args.slice(0, 2))).rows);
    for (const row of rows) {
      const e = envelope('card_events', String(row.id), instant(row.at), 'ticket'); e.ticket = row.card_id;
      if (row.status) e.status = row.status;
      e.actor.sender = row.actor; e.actor.evidence = 'card-event-actor'; events.push(e);
    }
  }
  if (!host && !session && modules.has('org')) {
    const rows = bounded((await db.query<{ id: number; created_at: Date; author: string; channel_slug: string; thread_id: number | null; task_id: string | null }>(
      `SELECT id, created_at, author, channel_slug, thread_id, task_id FROM org_messages
       WHERE created_at >= $1 AND created_at < $2 ORDER BY created_at, id LIMIT 5001`, args.slice(0, 2))).rows);
    for (const row of rows) {
      const e = envelope('org_messages', String(row.id), instant(row.created_at), 'message');
      // Current roster runtime cannot prove historical human origin.
      e.actor = { kind: 'unknown', sender: row.author, channel: row.channel_slug, evidence: 'recorded-author; historical-kind-unknown' };
      if (row.thread_id) e.parent = `org_messages:${row.thread_id}`;
      if (row.task_id) e.ticket = row.task_id; events.push(e);
    }
  }
  bounded(events);
  diagnostics.sessionsWithoutIntervals = new Set(events.filter(e => e.session && !intervals.some(i => i.session === e.session)).map(e => e.session)).size;
  diagnostics.untimed = events.filter(e => e.at === null).length;
  diagnostics.unpairedResults = events.filter(e => e.kind === 'tool_result' && !e.parent).length;
  // Session execution is explicit only if exactly one recorded interval contains this event.
  for (const e of events) if (e.session && e.at !== null && !e.execution) {
    const matches = intervals.filter(i => i.session === e.session && i.start <= e.at! && e.at! < i.end);
    if (matches.length === 1) e.execution = matches[0]!.id;
  }
  const refs: ExportData['refs'] = {};
  for (const e of events) (refs[e.source.table] ??= []).push(e.source.id);
  for (const table of Object.keys(refs) as SourceTable[]) refs[table] = [...new Set(refs[table])];
  return { window: makeWindow(from, to, events, intervals), diagnostics, refs };
}

export async function coverage(db: TxClient, range: Range, modules: ReadonlySet<string>) {
  const specs = [
    { table: 'archive_messages', time: 'ts', group: "a.host, a.harness AS runtime", join: 'JOIN archive_sessions a ON a.id = t.session_id', filter: 'a.host', session: 't.session_id', extra: 'count(*) FILTER (WHERE t.ts IS NULL)::int AS untimed, max(a.updated_at) AS session_updated_at' },
    { table: 'usage_calls', time: 'ts', group: 't.host, t.source AS runtime', join: '', filter: 't.host', session: `(SELECT a.id FROM archive_sessions a WHERE a.host=t.host AND a.source=t.source AND a.external_id=t.session_external_id)`, extra: '0 AS untimed' },
    { table: 'usage_runs', time: 'started_at', group: "t.host, coalesce(t.runtime, 'claude-code') AS runtime", join: '', filter: 't.host', session: `(SELECT a.id FROM archive_sessions a WHERE a.host=t.host AND a.source=coalesce(t.runtime, 'claude-code') AND a.external_id=t.session_id)`, extra: 'count(*) FILTER (WHERE t.ended_at IS NULL OR t.started_at IS NULL OR t.ended_at <= t.started_at)::int AS unknown_intervals' },
    { table: 'card_events', time: 'at', group: 'NULL::text AS host, NULL::text AS runtime', join: '', filter: 'NULL::text', session: 'NULL::bigint', extra: '0 AS untimed' },
    { table: 'org_messages', time: 'created_at', group: 'NULL::text AS host, NULL::text AS runtime', join: '', filter: 'NULL::text', session: 'NULL::bigint', extra: '0 AS untimed' },
  ] as const;
  const result = [];
  for (const s of specs) {
    if (!sourceEnabled(s.table, modules)) { result.push({ source: s.table, status: 'disabled' }); continue; }
    const rows = await db.query(`SELECT ${s.group}, count(*)::int AS records, min(t.${s.time}) AS first, max(t.${s.time}) AS last, ${s.extra}
      FROM ${s.table} t ${s.join} WHERE (t.${s.time} >= $1 OR t.${s.time} IS NULL) AND (t.${s.time} < $2 OR t.${s.time} IS NULL)
      AND ($3::text IS NULL OR ${s.filter} = $3) AND ($4::bigint IS NULL OR ${s.session} = $4)
      GROUP BY 1,2 ORDER BY 1,2 LIMIT 201`, [new Date(range.from), new Date(range.to), range.host ?? null, range.session ?? null]);
    const policy = (await db.query(`SELECT current_user AS role, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
      (c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)) AS owner,
      (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) AS bypass
      FROM pg_class c WHERE c.oid = $1::regclass`, [s.table])).rows[0];
    result.push({ source: s.table, status: 'authorized-visible-subset', groups: rows.rows.slice(0, 200), truncatedGroups: rows.rows.length > 200 ? null : 0, hasMoreGroups: rows.rows.length > 200, policy,
      ingestionFreshness: 'unknown', historicalCompleteness: 'unknown', senderProvenance: 'unknown' });
  }
  return { version: 1, from: range.from, to: range.to, sources: result, liveExecutions: 'unsupported', productionAudit: 'not-performed' };
}

export async function authorizeDetail(db: TxClient, event: EvidenceEvent, modules: ReadonlySet<string>): Promise<void> {
  if (!sourceEnabled(event.source.table, modules)) throw new HttpError(403, 'source module disabled');
  // Table comes only from the pinned server-generated event, never from a request parameter.
  const result = await db.query(`SELECT 1 FROM ${event.source.table} WHERE id = $1`, [event.source.id]);
  if (!result.rows.length) throw new HttpError(404, 'source no longer visible');
}

/** Recheck every source row including boundary evidence before serving a pinned page. */
export async function authorizeExport(db: TxClient, data: ExportData, modules: ReadonlySet<string>): Promise<void> {
  for (const [table, ids] of Object.entries(data.refs) as [SourceTable, string[]][]) {
    if (!sourceEnabled(table, modules)) throw new HttpError(403, 'source module disabled');
    const found = await db.query(`SELECT id FROM ${table} WHERE id = ANY($1::bigint[])`, [ids]);
    if (found.rows.length !== ids.length) throw new HttpError(403, 'export source visibility changed; restart window');
  }
  if (data.window.intervals.length) {
    if (!modules.has('usage')) throw new HttpError(403, 'source module disabled');
    const keys = data.window.intervals.map(i => i.id.split(':').slice(1).map(decodeURIComponent));
    const found = await db.query(`SELECT r.run_id FROM usage_runs r JOIN unnest($1::text[], $2::text[]) k(host, run_id)
      ON r.host = k.host AND r.run_id = k.run_id`, [keys.map(k => k[0]), keys.map(k => k[1])]);
    if (found.rows.length !== keys.length) throw new HttpError(403, 'execution visibility changed; restart window');
  }
}
