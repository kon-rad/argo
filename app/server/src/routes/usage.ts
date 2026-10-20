import { Router } from 'express';
import { z } from 'zod';
import { creditHistory, latestCredits } from '../credits.js';
import { query } from '../db.js';
import { expandSteps } from '../archive/steps.js';
import { agentSessionsRouter } from './agentSessions.js';
import { HttpError, parseOr400, wrap } from './http.js';

/**
 * The Usage board: the ledger written by usage-sync, usage-import and agents-sync
 * (Projects/secondbrain-app/usage-ledger-plan.md), labelled per call by the
 * usage_facts view (usage-attribution-plan.md). Read-only.
 */
const TEXT_LIMIT = 20000;
const HOST_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

// Validated against Postgres so only names the database accepts (no '+09:00' offset forms) get through.
const tzCache = new Map<string, boolean>();
async function assertTz(tz: string): Promise<void> {
  let ok = tzCache.get(tz);
  if (ok === undefined) {
    ok = ((await query(`SELECT 1 FROM pg_timezone_names WHERE name = $1`, [tz])).rowCount ?? 0) > 0;
    tzCache.set(tz, ok);
  }
  if (!ok) throw new HttpError(400, 'invalid request', { issues: [{ path: 'tz', message: 'unknown time zone' }] });
}

/** Any key mentioning cost, at any depth: Claude Code usage never shows dollars. */
function stripCost(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripCost);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).filter(([k]) => !/cost/i.test(k)).map(([k, x]) => [k, stripCost(x)]));
  }
  return v;
}

// ---- dimensions and filters -------------------------------------------------

/** The labels a call carries (usage_facts columns), by the name the API and the page use. */
export const DIMENSIONS = {
  host: 'host', source: 'source', surface: 'surface', headless: 'headless', model: 'model',
  agent: 'agent_name', team: 'team_slug', reason: 'reason', action: 'action', work_type: 'work_type',
  project: 'project_slug', feature: 'feature_slug', task: 'task_id', lane: 'lane',
} as const;
export type Dimension = keyof typeof DIMENSIONS;
export const DIMENSION_NAMES = Object.keys(DIMENSIONS) as Dimension[];
/** What a missing label is called in groups and filters. */
export const UNLABELLED = 'unlabelled';

const list = z.string().optional().transform((s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined));
const filterSchema = z.object(Object.fromEntries(DIMENSION_NAMES.map((d) => [d, list])) as Record<Dimension, typeof list>);
export type Filters = Partial<Record<Dimension, string[]>>;

/** `AND coalesce(col::text, 'unlabelled') = ANY($n)` per dimension present; params are appended in place. */
export function filterSql(f: Filters, params: unknown[], alias = ''): string {
  const parts: string[] = [];
  for (const d of DIMENSION_NAMES) {
    const values = f[d];
    if (!values?.length) continue;
    params.push(values);
    parts.push(`coalesce(${alias}${DIMENSIONS[d]}::text, '${UNLABELLED}') = ANY ($${params.length}::text[])`);
  }
  return parts.length ? ` AND ${parts.join(' AND ')}` : '';
}

const iso = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'not a date');
const range = z.object({ from: iso.optional(), to: iso.optional() }).merge(filterSchema);
const groupName = z.enum(['type', ...DIMENSION_NAMES] as [string, ...string[]]);
const seriesQuery = z.object({
  from: iso, to: iso, bucket: z.enum(['hour', 'day']), tz: z.string().min(1), group: groupName.default('type'),
}).merge(filterSchema)
  .refine((q) => Date.parse(q.to) > Date.parse(q.from), 'to must be after from')
  .refine((q) => Date.parse(q.to) - Date.parse(q.from) <= (q.bucket === 'hour' ? 31 : 400) * 86400_000, 'range too long for this bucket');

function span(q: { from?: string; to?: string }, days: number): [Date, Date] {
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - days * 86400_000);
  return [from, to];
}

function pickFilters(q: Record<string, unknown>): Filters {
  const f: Filters = {};
  for (const d of DIMENSION_NAMES) {
    const v = q[d];
    if (Array.isArray(v) && v.length) f[d] = v as string[];
  }
  return f;
}

// One union of labelled Claude calls and Hermes deltas. $1 and $2 are the range; filters follow.
function eventsSql(filters: Filters, params: unknown[]): string {
  const where = filterSql(filters, params);
  return `
  WITH claude AS (
    SELECT f.ts, f.model, f.host, f.sid, f.source, f.surface, f.headless, f.agent_name, f.team_slug, f.reason, f.action,
      f.work_type, f.project_slug, f.feature_slug, f.task_id, f.lane, f.run_id,
      f.input, f.cache_write, f.cache_read, f.output, 1 AS calls, NULL::double precision AS cost_usd
    FROM usage_facts f
    WHERE f.ts >= $1 AND f.ts < $2${where}),
  hermes_all AS (
    SELECT h.observed_at AS ts, h.model, h.host, h.session_id AS sid, 'hermes' AS source, 'hermes' AS surface, true AS headless,
      h.profile AS agent_name, NULL::text AS team_slug, NULL::text AS reason, NULL::text AS action, NULL::text AS work_type,
      NULL::text AS project_slug, NULL::text AS feature_slug, NULL::text AS task_id, NULL::text AS lane, NULL::text AS run_id,
      GREATEST(h.input_tokens - COALESCE(lag(h.input_tokens) OVER w, 0), 0) AS input,
      GREATEST(h.cache_write_tokens - COALESCE(lag(h.cache_write_tokens) OVER w, 0), 0) AS cache_write,
      GREATEST(h.cache_read_tokens - COALESCE(lag(h.cache_read_tokens) OVER w, 0), 0) AS cache_read,
      GREATEST(h.output_tokens - COALESCE(lag(h.output_tokens) OVER w, 0), 0) AS output,
      GREATEST(h.api_calls - COALESCE(lag(h.api_calls) OVER w, 0), 0) AS calls,
      -- first snapshot: its whole cost; later with an unknown cost on either side: unknown (NULL, never 0),
      -- so a session with no known cost sums to NULL instead of a made-up $0.00
      CASE WHEN row_number() OVER w = 1 THEN h.cost_usd
           WHEN h.cost_usd IS NULL OR lag(h.cost_usd) OVER w IS NULL THEN NULL
           ELSE GREATEST(h.cost_usd - lag(h.cost_usd) OVER w, 0) END AS cost_usd
    FROM hermes_usage_snapshots h
    WINDOW w AS (PARTITION BY h.host, h.profile, h.session_id ORDER BY h.observed_at)),
  events AS (
    SELECT * FROM claude
    UNION ALL SELECT * FROM hermes_all WHERE ts >= $1 AND ts < $2${where})`;
}

interface SessionFilter { host: string; sid: string; source: string }

/** One row per session: the list endpoint and the detail endpoint share this query. */
async function sessionRows(from: Date, to: Date, limit: number, only: SessionFilter | null, filters: Filters = {}): Promise<Record<string, unknown>[]> {
  const params: unknown[] = [from, to, limit, only?.host ?? null, only?.sid ?? null, only?.source ?? null];
  const events = eventsSql(filters, params);
  const { rows } = await query(
    `${events}
     SELECT e.source, e.host, e.sid AS external_id, min(e.surface) AS surface, min(e.ts) AS started_at, max(e.ts) AS ended_at,
            sum(e.calls)::bigint AS calls, sum(e.input)::bigint AS input, sum(e.cache_write)::bigint AS cache_write,
            sum(e.cache_read)::bigint AS cache_read, sum(e.output)::bigint AS output,
            sum(e.cost_usd) AS cost_usd,                -- Hermes only; Claude Code has no dollar figure
            max(e.agent_name) AS agent_name, max(e.task_id) AS task_id, max(e.lane) AS lane, max(e.project_slug) AS project_slug,
            max(e.work_type) AS work_type, count(DISTINCT e.run_id)::int AS runs,
            max(a.title) AS title, max(a.id) AS archive_id
     FROM events e
     LEFT JOIN archive_sessions a ON a.host = e.host AND a.external_id = e.sid
          AND (a.source = e.source OR (e.source = 'hermes' AND a.source LIKE 'hermes%'))
     WHERE ($4::text IS NULL OR (e.host = $4::text AND e.sid = $5::text AND e.source = $6::text))
     GROUP BY e.source, e.host, e.sid
     ORDER BY sum(e.input + e.cache_write + e.cache_read + e.output) DESC LIMIT $3`, params);
  return rows;
}

// The same labels on a run: the runs table and its filters. $1, $2 = range.
const RUNS_CTE = `
  WITH runs AS (
    SELECT r.host, r.run_id, r.session_id, r.task_id, r.board, r.lane, r.model, r.started_at, r.ended_at, r.duration_ms,
           r.num_turns, r.subtype, r.is_error, r.resumed, r.agent_name, r.wakeup_ids,
           r.verify_name, r.verify_passed, r.verify_exit, r.verify_metric, r.verify_output,
           coalesce(r.team_slug, a.team_slug) AS team_slug,
           coalesce(r.reasons -> 0 ->> 'reason', w.reason) AS reason,
           r.reasons,
           coalesce(tl.work_type, r.work_type,
                    CASE r.lane WHEN 'cc-coder' THEN 'coding' WHEN 'cc-research' THEN 'research'
                                WHEN 'cc-writer' THEN 'writing' WHEN 'cc-reviewer' THEN 'coding' END,
                    a.work) AS work_type,
           tl.project_slug, tl.feature_slug, tl.title AS card_title,
           CASE WHEN r.agent_name IS NOT NULL THEN 'bot' ELSE 'cc-lane' END AS surface,
           'claude-code' AS source, true AS headless
    FROM usage_runs r
    LEFT JOIN org_agents a ON a.name = r.agent_name
    LEFT JOIN task_links tl ON tl.task_id = r.task_id
    LEFT JOIN LATERAL (SELECT reason FROM org_wakeups WHERE claimed_by = r.run_id ORDER BY id LIMIT 1) w ON true
    WHERE r.started_at >= $1 AND r.started_at < $2),
  tok AS (
    SELECT host, run_id, count(*)::int AS calls, sum(input_tokens)::bigint AS input, sum(cache_write_tokens)::bigint AS cache_write,
           sum(cache_read_tokens)::bigint AS cache_read, sum(output_tokens)::bigint AS output,
           array_agg(DISTINCT action) FILTER (WHERE action IS NOT NULL) AS actions
    FROM usage_calls WHERE ts >= $1 - interval '1 day' AND ts < $2 + interval '1 day' AND run_id IS NOT NULL GROUP BY 1, 2),
  rr AS (SELECT runs.*, tok.calls, tok.input, tok.cache_write, tok.cache_read, tok.output, tok.actions FROM runs LEFT JOIN tok USING (host, run_id))`;

/** Filters on a run: as on a call, except that an action filter keeps the runs that made such a call. */
function runsFilterSql(f: Filters, params: unknown[]): string {
  const rest: Filters = { ...f };
  delete rest.action;
  let sql = filterSql(rest, params, 'rr.');
  if (f.action?.length) {
    params.push(f.action);
    sql += ` AND coalesce(rr.actions, '{}') && $${params.length}::text[]`;
  }
  return sql;
}

export function usageRouter(): Router {
  const router = Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  // Prepaid API credits (OpenRouter, fal, Gemini): latest per provider plus the balance history.
  router.use('/agent-sessions', agentSessionsRouter());

  router.get('/credits', wrap(async (req, res) => {
    const [from, to] = span(parseOr400(range, req.query), 30);
    res.json({ providers: await latestCredits(), history: await creditHistory(from, to) });
  }));

  router.get('/plan', wrap(async (req, res) => {
    const [from, to] = span(parseOr400(range, req.query), 7);
    const latest = await query<{ window: string; used_pct: number; resets_at: Date | null; observed_at: Date; host: string; origin: string; passed: boolean }>(
      `SELECT DISTINCT ON ("window") "window", used_pct, resets_at, observed_at, host, origin,
              (resets_at IS NOT NULL AND resets_at <= now()) AS passed
       FROM plan_usage_snapshots ORDER BY "window", observed_at DESC`);
    const current: Record<string, unknown> = { five_hour: null, seven_day: null };
    for (const r of latest.rows) {
      const used = r.passed ? null : r.used_pct;
      current[r.window] = {
        used_pct: used, left_pct: used === null ? null : Math.round((100 - used) * 10) / 10,
        resets_at: r.resets_at, observed_at: r.observed_at, host: r.host, origin: r.origin,
        reset_since_reading: r.passed, last_pct: r.used_pct,
      };
    }
    const history = await query(
      `SELECT observed_at, "window", used_pct FROM plan_usage_snapshots
       WHERE observed_at >= $1 AND observed_at < $2 ORDER BY observed_at`, [from, to]);
    res.json({ current, history: history.rows });
  }));

  router.get('/hosts', wrap(async (_req, res) => {
    const { rows } = await query(`SELECT slug, display, kind, chip, notes FROM usage_hosts ORDER BY slug`);
    res.json({ hosts: rows });
  }));

  router.get('/series', wrap(async (req, res) => {
    const q = parseOr400(seriesQuery, req.query);
    await assertTz(q.tz);
    const params: unknown[] = [new Date(q.from), new Date(q.to), q.bucket, q.tz];
    const events = eventsSql(pickFilters(q), params);
    const group = q.group as 'type' | Dimension;
    const key = group === 'type' ? `'all'` : `coalesce(${DIMENSIONS[group]}::text, '${UNLABELLED}')`;
    const { rows } = await query(
      `${events}
       SELECT (date_trunc($3, ts AT TIME ZONE $4) AT TIME ZONE $4) AS bucket, ${key} AS key,
              sum(input)::bigint AS input, sum(cache_write)::bigint AS cache_write, sum(cache_read)::bigint AS cache_read,
              sum(output)::bigint AS output, sum(calls)::bigint AS calls
       FROM events GROUP BY 1, 2 ORDER BY 1, 2`, params);
    res.json({ bucket: q.bucket, tz: q.tz, group, rows });
  }));

  // Every dimension's values in range, with calls and tokens, under the other filters: the filter bar and the breakdown.
  router.get('/facets', wrap(async (req, res) => {
    const q = parseOr400(range, req.query);
    const [from, to] = span(q, 1);
    const params: unknown[] = [from, to];
    const events = eventsSql(pickFilters(q), params);
    const unions = DIMENSION_NAMES.map((d) =>
      `SELECT '${d}' AS dimension, coalesce(${DIMENSIONS[d]}::text, '${UNLABELLED}') AS value, sum(calls)::bigint AS calls,
              sum(input + cache_write + cache_read + output)::bigint AS tokens, sum(output)::bigint AS output
       FROM events GROUP BY 2`).join('\n UNION ALL ');
    const { rows } = await query<{ dimension: Dimension; value: string; calls: string; tokens: string; output: string }>(
      `${events}, ev AS MATERIALIZED (SELECT * FROM events)
       SELECT * FROM (${unions.replaceAll('FROM events', 'FROM ev')}) x ORDER BY dimension, tokens DESC, value`, params);
    const facets: Record<string, { value: string; calls: number; tokens: number; output: number }[]> = {};
    for (const d of DIMENSION_NAMES) facets[d] = [];
    for (const r of rows) facets[r.dimension]!.push({ value: r.value, calls: Number(r.calls), tokens: Number(r.tokens), output: Number(r.output) });
    // Every event has a host, so the host facet sums to the whole.
    const total = facets.host!.reduce((t, x) => ({ calls: t.calls + x.calls, tokens: t.tokens + x.tokens }), { calls: 0, tokens: 0 });
    res.json({ from, to, total, facets });
  }));

  router.get('/sessions', wrap(async (req, res) => {
    const q = parseOr400(range.extend({ limit: z.coerce.number().int().min(1).max(500).default(200) }), req.query);
    const [from, to] = span(q, 1);
    res.json({ sessions: await sessionRows(from, to, q.limit, null, pickFilters(q)) });
  }));

  router.get('/sessions/:host/:externalId', wrap(async (req, res) => {
    const host = parseOr400(z.string().regex(HOST_RE), req.params.host);
    const source = parseOr400(z.enum(['claude-code', 'hermes']).default('claude-code'), req.query.source);
    const sid = String(req.params.externalId);
    const a = await query<{ archive_id: number }>(
      `SELECT a.id AS archive_id FROM archive_sessions a WHERE a.host=$1 AND a.external_id=$2
         AND (a.source=$3 OR ($3='hermes' AND a.source LIKE 'hermes%')) LIMIT 1`, [host, sid, source]);
    // Same row shape as the list: the shared query over all time, narrowed to this session.
    const row = (await sessionRows(new Date(0), new Date('2999-01-01'), 1, { host, sid, source }))[0];
    if (!a.rows[0] && !row) throw new HttpError(404, 'no such session in the ledger');
    const session = row ?? {
      source, host, external_id: sid, title: null, surface: null, started_at: null, ended_at: null,
      calls: 0, input: 0, cache_write: 0, cache_read: 0, output: 0, cost_usd: null, task_id: null, lane: null,
      agent_name: null, project_slug: null, work_type: null, runs: 0, archive_id: a.rows[0]!.archive_id,
    };
    const runs = await query(
      `${RUNS_CTE}
       SELECT * FROM rr WHERE rr.host=$3 AND rr.session_id=$4 ORDER BY rr.started_at`, [new Date(0), new Date('2999-01-01'), host, sid]);   // no dollar figure for Claude Code
    const messages = a.rows[0] ? (await query(
      `SELECT m.id, m.seq, m.role, m.kind, m.ts, left(m.content_text, ${TEXT_LIMIT}) AS text,
              length(m.content_text) AS length, m.is_sidechain,
              CASE WHEN c.id IS NULL THEN NULL ELSE json_build_object('model', c.model, 'input', c.input_tokens,
                'cache_write', c.cache_write_tokens, 'cache_read', c.cache_read_tokens, 'output', c.output_tokens,
                'action', c.action, 'tool', c.tool, 'run_id', c.run_id) END AS call
       FROM archive_messages m
       LEFT JOIN usage_calls c ON c.host=$2 AND c.message_external_id=m.external_id
       WHERE m.session_id=$1 ORDER BY m.seq LIMIT 5000`, [a.rows[0].archive_id, host])).rows : [];
    res.json({
      session,
      run: runs.rows[runs.rows.length - 1] ?? null,
      runs: runs.rows,
      messages: messages.map((m) => ({ ...m, length: m.length ?? 0, truncated: (m.length ?? 0) > TEXT_LIMIT })),
    });
  }));

  router.get('/messages/:id', wrap(async (req, res) => {
    const id = parseOr400(z.coerce.number().int().positive(), req.params.id);
    const r = await query<{ id: number; raw: unknown; source: string | null; content_text: string | null }>(
      `SELECT m.id, m.raw, a.source, m.content_text FROM archive_messages m LEFT JOIN archive_sessions a ON a.id = m.session_id WHERE m.id=$1`, [id]);
    if (!r.rows[0]) throw new HttpError(404, 'no such message');
    const { source, raw } = r.rows[0];
    // ?full=1 adds the text uncapped (a step the session view cut at 20,000 characters); &part=<key> picks
    // that part of a row that holds several (a Hermes assistant row: thinking, response, tool calls).
    let text: string | undefined;
    if (req.query.full === '1') {
      const part = typeof req.query.part === 'string' ? req.query.part : null;
      const parts = part ? expandSteps({ id, role: '', kind: '', ts: null, raw, text: r.rows[0].content_text ?? '' }) : [];
      text = parts.find((p) => p.key === part)?.text ?? r.rows[0].content_text ?? '';
    }
    res.json({ id: r.rows[0].id, raw: source === 'claude-code' ? stripCost(raw) : raw, ...(text !== undefined ? { text } : {}) });
  }));

  // The agent company's wakes per agent (org_wakeups): how much of the shared
  // daily cap each agent spends, how long its runs take, and what they cost in tokens.
  router.get('/org-wakes', wrap(async (req, res) => {
    const [from, to] = span(parseOr400(range, req.query), 7);
    const { rows } = await query(
      `SELECT w.agent_name, a.team_slug, a.role,
              count(*)::int AS wakes,
              count(*) FILTER (WHERE w.done_at IS NOT NULL)::int AS done,
              count(*) FILTER (WHERE w.done_at IS NULL)::int AS open,
              count(*) FILTER (WHERE w.reason = 'routine')::int AS routine,
              count(*) FILTER (WHERE w.reason = 'dm')::int AS dm,
              count(*) FILTER (WHERE w.reason = 'mention')::int AS mention,
              count(*) FILTER (WHERE w.reason = 'task')::int AS task,
              round(avg(EXTRACT(EPOCH FROM (w.done_at - w.claimed_at)) / 60)::numeric, 1)::float AS avg_minutes,
              max(w.created_at) AS last_wake,
              (SELECT coalesce(sum(f.input + f.cache_write + f.cache_read + f.output), 0)::bigint FROM usage_facts f
                WHERE f.agent_name = w.agent_name AND f.ts >= $1 AND f.ts < $2) AS tokens,
              (SELECT coalesce(sum(f.output), 0)::bigint FROM usage_facts f
                WHERE f.agent_name = w.agent_name AND f.ts >= $1 AND f.ts < $2) AS output
         FROM org_wakeups w JOIN org_agents a ON a.name = w.agent_name
        WHERE w.created_at >= $1 AND w.created_at < $2
        GROUP BY w.agent_name, a.team_slug, a.role ORDER BY wakes DESC, w.agent_name`, [from, to]);
    res.json({ agents: rows });
  }));

  // One row per `claude -p` run (a bot's wake or a lane's card), with its labels and token sums.
  router.get('/runs', wrap(async (req, res) => {
    const q = parseOr400(range.extend({ limit: z.coerce.number().int().min(1).max(1000).default(500) }), req.query);
    const [from, to] = span(q, 7);
    const params: unknown[] = [from, to, q.limit];
    const where = runsFilterSql(pickFilters(q), params);
    const { rows } = await query(
      `${RUNS_CTE}
       SELECT * FROM rr WHERE true${where} ORDER BY rr.started_at DESC LIMIT $3`, params);
    res.json({ runs: rows });
  }));
  return router;
}
