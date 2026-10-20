import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { redactor } from '../archive/redact.js';
import { expandSteps, hermesResponse, type StepPart } from '../archive/steps.js';
import { hermesMatchKey } from '../usage/hermesCalls.js';
import { HttpError, parseOr400, wrap } from './http.js';

/**
 * Agent sessions on /usage (vault: agent-sessions-viewer-design.md): every archived
 * session from every harness and host, listed from archive_sessions (so a session with
 * no token rows still shows), and one session read as steps. Read-only.
 */
const TEXT_LIMIT = 20000;
const HOST_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

const iso = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'not a date');
const csv = z.string().optional().transform((s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined));
const flag = z.enum(['0', '1']).optional().transform((v) => v === '1');

const listQuery = z.object({
  from: iso.optional(), to: iso.optional(),
  harness: csv, host: csv, profile: csv, provider: csv, tool: csv,
  q: z.string().trim().max(200).optional(), errors: flag, subagents: flag,
  offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type ListQuery = z.infer<typeof listQuery>;

interface Only { id: number }

/** `c` is a Claude Code subagent of `p`. */
const CHILD_OF = (c: string, p: string) => `${c}.harness = 'claude-code' AND ${c}.host = ${p}.host AND ${c}.source = ${p}.source
  AND ${c}.parent_external_id = ${p}.external_id AND ${c}.id <> ${p}.id`;
/** `a` is a Claude Code subagent whose parent is archived (so it shows inside the parent, not as a row). */
const IS_CHILD = (a: string) => `${a}.harness = 'claude-code' AND ${a}.parent_external_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM archive_sessions pa WHERE pa.host = ${a}.host AND pa.source = ${a}.source AND pa.external_id = ${a}.parent_external_id)`;

/**
 * One row per session. Without `subagents`, a Claude Code session's subagents are folded
 * into their parent (tokens, steps, tool calls) and only top-level sessions are listed.
 * Tokens: Claude Code from usage_calls; Hermes from the session's own counters (state.db).
 */
async function listSessions(q: ListQuery, only: Only | null = null): Promise<{ rows: Record<string, unknown>[]; total: number }> {
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 7 * 86400_000);
  // $3 = list subagents as their own rows; when false, each session folds its subagents in.
  const params: unknown[] = [from, to, q.subagents, q.limit, q.offset];
  const where: string[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replaceAll('$?', `$${params.length}`)); };
  // One session: no range, but $1 and $2 still need a type.
  if (only) { add(`a.id = $?`, only.id); where.push(`$1::timestamptz IS NOT NULL AND $2::timestamptz IS NOT NULL`); }
  else where.push(`coalesce(a.started_at, a.first_seen_at) < $2`, `coalesce(a.ended_at, a.started_at, a.updated_at) >= $1`);
  // Only Claude Code subagents fold into their parent (one level: they live under the parent's file). A Hermes
  // parent_session_id marks a compression continuation, so every Hermes session is listed on its own. A
  // subagent whose parent was never archived is listed too.
  if (!only && !q.subagents) where.push(`NOT (${IS_CHILD('a')})`);
  if (q.harness) add(`a.harness = ANY ($?::text[])`, q.harness);
  if (q.host) add(`a.host = ANY ($?::text[])`, q.host);
  if (q.profile) add(`coalesce(a.profile, 'none') = ANY ($?::text[])`, q.profile);
  if (q.provider) add(`coalesce(a.provider, 'unknown') = ANY ($?::text[])`, q.provider);
  // Content filters look at the session and, when folded, its subagents.
  const famOf = `SELECT c.id FROM archive_sessions c WHERE c.id = a.id OR (NOT $3 AND ${CHILD_OF('c', 'a')})`;
  if (q.tool) add(`EXISTS (SELECT 1 FROM archive_messages m WHERE m.session_id IN (${famOf}) AND m.tool_names && $?::text[])`, q.tool);
  if (q.errors) where.push(`EXISTS (SELECT 1 FROM archive_messages m WHERE m.session_id IN (${famOf}) AND m.is_error)`);
  if (q.q) add(`(a.title ILIKE '%' || $? || '%' OR EXISTS (SELECT 1 FROM archive_messages m WHERE m.session_id IN (${famOf})
    AND m.tsv @@ plainto_tsquery('simple', $?)))`, q.q);

  const { rows } = await query<Record<string, unknown> & { total?: string }>(
    `WITH page AS (
       SELECT a.*, count(*) OVER () AS total FROM archive_sessions a
       WHERE ${where.join(' AND ')}
       ORDER BY coalesce(a.started_at, a.first_seen_at) DESC, a.id DESC LIMIT $4 OFFSET $5),
     fam AS (
       SELECT p.id AS root, c.id, c.host, c.source, c.external_id FROM page p
       JOIN archive_sessions c ON c.id = p.id OR (NOT $3 AND ${CHILD_OF('c', 'p')})),
     st AS (
       SELECT f.root, count(m.id)::int AS steps,
              coalesce(sum(cardinality(m.tool_names)) FILTER (WHERE m.step = 'tool_call'), 0)::int AS tool_calls,
              count(m.id) FILTER (WHERE m.is_error)::int AS errors, (count(DISTINCT f.id) - 1)::int AS subagents
       FROM fam f LEFT JOIN archive_messages m ON m.session_id = f.id AND m.step IS DISTINCT FROM 'meta' GROUP BY f.root),
     ca AS (
       SELECT f.root, count(*)::int AS calls, sum(u.input_tokens)::bigint AS input, sum(u.cache_write_tokens)::bigint AS cache_write,
              sum(u.cache_read_tokens)::bigint AS cache_read, sum(u.output_tokens)::bigint AS output,
              sum(u.thinking_tokens)::bigint AS reasoning, array_agg(DISTINCT u.model) AS models
       FROM fam f JOIN usage_calls u ON u.host = f.host AND u.session_external_id = f.external_id AND f.source = 'claude-code'
       GROUP BY f.root)
     SELECT p.id, p.source, p.harness, p.profile, p.provider, p.host, p.external_id, p.parent_external_id, p.project, p.title,
            (SELECT left(m.content_text, 160) FROM archive_messages m WHERE m.session_id = p.id AND m.step = 'prompt'
               AND m.content_text <> '' ORDER BY m.seq LIMIT 1) AS first_prompt,
            p.started_at, p.ended_at, p.total,
            st.steps, st.tool_calls, st.errors, st.subagents,
            CASE WHEN p.harness = 'claude-code' THEN coalesce(ca.models, CASE WHEN p.model IS NULL THEN '{}'::text[] ELSE ARRAY[p.model] END)
                 ELSE CASE WHEN p.model IS NULL THEN '{}'::text[] ELSE ARRAY[p.model] END END AS models,
            CASE WHEN p.harness = 'claude-code' THEN coalesce(ca.calls, 0) ELSE coalesce((p.meta ->> 'api_call_count')::int, 0) END AS calls,
            CASE WHEN p.harness = 'claude-code' THEN coalesce(ca.input, 0) ELSE coalesce(p.input_tokens, 0) END AS input,
            CASE WHEN p.harness = 'claude-code' THEN coalesce(ca.cache_write, 0) ELSE coalesce((p.meta ->> 'cache_write_tokens')::bigint, 0) END AS cache_write,
            CASE WHEN p.harness = 'claude-code' THEN coalesce(ca.cache_read, 0) ELSE coalesce((p.meta ->> 'cache_read_tokens')::bigint, 0) END AS cache_read,
            CASE WHEN p.harness = 'claude-code' THEN coalesce(ca.output, 0) ELSE coalesce(p.output_tokens, 0) END AS output,
            CASE WHEN p.harness = 'claude-code' THEN coalesce(ca.reasoning, 0) ELSE coalesce((p.meta ->> 'reasoning_tokens')::bigint, 0) END AS reasoning,
            -- Hermes's own estimate in USD; Claude Code never shows dollars.
            CASE WHEN p.harness = 'claude-code' THEN NULL ELSE p.cost_usd END AS cost_usd
     FROM page p LEFT JOIN st ON st.root = p.id LEFT JOIN ca ON ca.root = p.id
     ORDER BY coalesce(p.started_at, p.first_seen_at) DESC, p.id DESC`, params);
  const total = rows[0] ? Number(rows[0].total) : 0;
  for (const r of rows) {
    delete r.total;
    for (const k of ['calls', 'input', 'cache_write', 'cache_read', 'output', 'reasoning']) r[k] = Number(r[k] ?? 0);
    if (r.harness === 'claude-code') delete r.cost_usd;   // no dollar field at all for Claude Code
  }
  return { rows, total };
}

const detailQuery = z.object({
  source: z.string().regex(/^[a-z][a-z0-9:-]{0,40}$/).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
  meta: flag,
});

export interface StepOut extends Omit<StepPart, 'text'> {
  id: number; ts: string | null; text: string; length: number; truncated: boolean;
  subagent: string | null;
  call: { model: string; input: number; cache_write: number; cache_read: number; output: number; reasoning: number } | null;
}

type CallJson = NonNullable<StepOut['call']>;

/**
 * Hermes calls come from the usage-ledger plugin, keyed by the response's tool-call ids or a hash of its
 * text (hermesMatchKey). Matching runs over the whole session, not the page, so a call lands on one response
 * only: each stored assistant row takes the call with its key, nearest in time when the key repeats; a row
 * with no keyed call (text Hermes rewrote, or redaction changed) takes the nearest unused main call that ended
 * within two minutes before it. Calls left over (side tasks) only count in the totals.
 */
async function attachHermesCalls(rootId: number, rows: Array<{ id: number; call: StepOut['call'] }>): Promise<void> {
  const { rows: calls } = await query<{ id: number; ts: Date; match_key: string | null; aux: boolean } & CallJson>(
    `SELECT u.id, u.ts, u.match_key, coalesce(u.entrypoint LIKE 'aux:%', false) AS aux, u.model,
            u.input_tokens::float8 AS input, u.cache_write_tokens::float8 AS cache_write, u.cache_read_tokens::float8 AS cache_read,
            u.output_tokens::float8 AS output, u.thinking_tokens::float8 AS reasoning
     FROM archive_sessions a JOIN usage_calls u ON u.host = a.host AND u.source = a.source AND u.session_external_id = a.external_id
     WHERE a.id = $1 ORDER BY u.ts`, [rootId]);
  if (!calls.length) return;
  // Only what matching needs from each assistant row, never the whole raw JSON.
  const { rows: answers } = await query<{ id: number; ts: Date | null; raw: unknown }>(
    `SELECT m.id, m.ts, jsonb_build_object('role', m.raw -> 'role', 'session_id', m.raw -> 'session_id',
              'content', m.raw -> 'content', 'tool_calls', m.raw -> 'tool_calls') AS raw
     FROM archive_messages m WHERE m.session_id = $1 AND m.raw ->> 'role' = 'assistant' ORDER BY m.ts, m.seq`, [rootId]);
  const used = new Set<number>();
  const byRow = new Map<number, CallJson>();
  const chip = (c: (typeof calls)[number]): CallJson =>
    ({ model: c.model, input: c.input, cache_write: c.cache_write, cache_read: c.cache_read, output: c.output, reasoning: c.reasoning });
  const nearest = (list: typeof calls, at: number) =>
    list.reduce<(typeof calls)[number] | null>((best, c) => (!best || Math.abs(c.ts.getTime() - at) < Math.abs(best.ts.getTime() - at) ? c : best), null);
  const pending: Array<{ id: number; at: number }> = [];
  for (const a of answers) {
    const resp = hermesResponse(a.raw);
    if (!resp || !a.ts) continue;
    const at = new Date(a.ts).getTime();
    const key = hermesMatchKey(resp.toolCallIds, resp.content);
    const hit = key ? nearest(calls.filter((c) => c.match_key === key && !used.has(c.id)), at) : null;
    if (hit) { used.add(hit.id); byRow.set(a.id, chip(hit)); } else pending.push({ id: a.id, at });
  }
  for (const { id, at } of pending) {
    const hit = nearest(calls.filter((c) => !c.aux && !used.has(c.id) && c.ts.getTime() <= at + 5_000 && at - c.ts.getTime() <= 120_000), at);
    if (hit) { used.add(hit.id); byRow.set(id, chip(hit)); }
  }
  for (const r of rows) { const c = byRow.get(r.id); if (c) r.call = c; }
}

export function agentSessionsRouter(): Router {
  const router = Router();

  router.get('/', wrap(async (req, res) => {
    const q = parseOr400(listQuery, req.query);
    const { rows, total } = await listSessions(q);
    res.json({ sessions: rows, total });
  }));

  router.get('/facets', wrap(async (req, res) => {
    const q = parseOr400(z.object({ from: iso.optional(), to: iso.optional() }), req.query);
    const to = q.to ? new Date(q.to) : new Date();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 7 * 86400_000);
    const range = `coalesce(a.started_at, a.first_seen_at) < $2 AND coalesce(a.ended_at, a.started_at, a.updated_at) >= $1`;
    const { rows } = await query<{ dimension: string; value: string; n: string }>(
      `SELECT 'harness' AS dimension, a.harness AS value, count(*) n FROM archive_sessions a WHERE ${range} GROUP BY 2
       UNION ALL SELECT 'host', a.host, count(*) FROM archive_sessions a WHERE ${range} GROUP BY 2
       UNION ALL SELECT 'profile', coalesce(a.profile, 'none'), count(*) FROM archive_sessions a WHERE ${range} GROUP BY 2
       UNION ALL SELECT 'provider', coalesce(a.provider, 'unknown'), count(*) FROM archive_sessions a WHERE ${range} GROUP BY 2
       UNION ALL SELECT * FROM (SELECT 'tool', t, count(*) FROM archive_sessions a JOIN archive_messages m ON m.session_id = a.id
         CROSS JOIN unnest(m.tool_names) t WHERE ${range} AND m.step = 'tool_call' GROUP BY 2 ORDER BY 3 DESC LIMIT 30) tools`, [from, to]);
    const facets: Record<string, Array<{ value: string; n: number }>> = { harness: [], host: [], profile: [], provider: [], tool: [] };
    for (const r of rows) facets[r.dimension]!.push({ value: r.value, n: Number(r.n) });
    for (const k of Object.keys(facets)) facets[k]!.sort((a, b) => b.n - a.n || a.value.localeCompare(b.value));
    res.json({ facets });
  }));

  router.get('/:host/:externalId', wrap(async (req, res) => {
    const host = parseOr400(z.string().regex(HOST_RE), req.params.host);
    const q = parseOr400(detailQuery, req.query);
    const sid = String(req.params.externalId);
    // 'hermes' in an old link means any Hermes home on that host.
    const found = await query<{ id: number }>(
      `SELECT id FROM archive_sessions WHERE host = $1 AND external_id = $2
         AND ($3::text IS NULL OR source = $3 OR ($3 = 'hermes' AND harness = 'hermes'))
       ORDER BY (source = coalesce($3, source)) DESC, id LIMIT 1`, [host, sid, q.source ?? null]);
    if (!found.rows[0]) throw new HttpError(404, 'no such session in the archive');
    const rootId = found.rows[0].id;
    // The header folds subagents in, like the list does.
    const session = (await listSessions(listQuery.parse({}), { id: rootId })).rows[0]!;

    const { rows } = await query<{
      id: number; role: string; kind: string; ts: Date | null; raw: unknown; text: string | null; own: boolean; label: string;
      call: StepOut['call'];
    }>(
      `WITH fam AS (
         SELECT c.id, c.host, c.source, c.external_id, c.id = $1 AS own, coalesce(c.title, c.external_id) AS label FROM archive_sessions r
         JOIN archive_sessions c ON c.id = r.id OR (${CHILD_OF('c', 'r')})
         WHERE r.id = $1)
       SELECT m.id, m.role, m.kind, m.ts, m.raw, m.content_text AS text, f.own, f.label,
              CASE WHEN u.id IS NULL THEN NULL ELSE json_build_object('model', u.model, 'input', u.input_tokens,
                'cache_write', u.cache_write_tokens, 'cache_read', u.cache_read_tokens, 'output', u.output_tokens,
                'reasoning', u.thinking_tokens) END AS call
       FROM fam f JOIN archive_messages m ON m.session_id = f.id
       LEFT JOIN usage_calls u ON f.source = 'claude-code' AND u.host = f.host AND u.session_external_id = f.external_id
         AND u.message_external_id = m.external_id
       WHERE ($2 OR m.step IS DISTINCT FROM 'meta')
       ORDER BY m.ts NULLS FIRST, f.own DESC, m.session_id, m.seq
       OFFSET $3 LIMIT $4`, [rootId, q.meta, q.offset, q.limit + 1]);
    const more = rows.length > q.limit;
    if (session.harness === 'hermes') await attachHermesCalls(rootId, rows);
    const steps: StepOut[] = [];
    for (const r of rows.slice(0, q.limit)) {
      const parts = expandSteps({ id: r.id, role: r.role, kind: r.kind, ts: r.ts, raw: r.raw, text: r.text ?? '' });
      // A response's tokens go on one part: the first that isn't thinking, which the page hides by default.
      const chipAt = Math.max(0, parts.findIndex((p) => p.step !== 'thinking'));
      parts.forEach((p, i) => steps.push({
        ...p, id: r.id, ts: r.ts ? new Date(r.ts).toISOString() : null,
        text: p.text.length > TEXT_LIMIT ? p.text.slice(0, TEXT_LIMIT) : p.text, length: p.text.length, truncated: p.text.length > TEXT_LIMIT,
        subagent: r.own ? null : r.label,
        call: i === chipAt ? r.call : null,
      }));
    }
    const runs = await query(
      `SELECT run_id, agent_name, task_id, lane, started_at, num_turns, subtype, verify_name, verify_passed, verify_metric, verify_output
       FROM usage_runs WHERE host = $1 AND session_id = $2 ORDER BY started_at`, [host, sid]);
    const red = redactor();
    for (const r of runs.rows as Array<{ verify_output: string | null }>) if (r.verify_output) r.verify_output = red.text(r.verify_output);
    res.json({ session, runs: runs.rows, steps, next: more ? q.offset + q.limit : null });
  }));

  return router;
}
