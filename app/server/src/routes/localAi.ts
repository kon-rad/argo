import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { HttpError, parseOr400, wrap } from './http.js';

/**
 * Local model usage on the Usage board: the rows `local-ai-pull` copies from a home model host's
 * logging gateway (local_ai_* tables, migration 1756000013500). Read-only. Tokens, speed and energy;
 * there is no money here, a local call costs electricity only.
 */
const TEXT_LIMIT = 20000;
const iso = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'not a date');
const text = z.string().min(1).max(200);
const summaryQuery = z.object({
  from: iso, to: iso, bucket: z.enum(['hour', 'day']).default('hour'), tz: z.string().min(1).default('UTC'),
}).refine((q) => Date.parse(q.to) > Date.parse(q.from), 'to must be after from')
  .refine((q) => Date.parse(q.to) - Date.parse(q.from) <= (q.bucket === 'hour' ? 31 : 400) * 86400_000, 'range too long for this bucket');
const runsQuery = z.object({
  from: iso, to: iso, caller: text.optional(), model: text.optional(), state: z.enum(['running', 'ok', 'error', 'cancelled']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/** The caller a run is filed under: the label it sent, else the node it came from. */
const CALLER = `coalesce(caller_label, caller_node, 'unknown')`;

async function assertTz(tz: string): Promise<void> {
  const ok = ((await query(`SELECT 1 FROM pg_timezone_names WHERE name = $1`, [tz])).rowCount ?? 0) > 0;
  if (!ok) throw new HttpError(400, 'invalid request', { issues: [{ path: 'tz', message: 'unknown time zone' }] });
}

export function localAiRouter(): Router {
  const router = Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  router.get('/summary', wrap(async (req, res) => {
    const q = parseOr400(summaryQuery, req.query);
    await assertTz(q.tz);
    const span = [new Date(q.from), new Date(q.to)];
    const agg = `count(*)::int AS runs, count(*) FILTER (WHERE state = 'error')::int AS errors,
                 coalesce(sum(prompt_tokens), 0)::bigint AS prompt, coalesce(sum(cached_tokens), 0)::bigint AS cached,
                 coalesce(sum(output_tokens), 0)::bigint AS output,
                 round(avg(output_tps) FILTER (WHERE output_tps > 0)::numeric, 1)::float AS avg_output_tps,
                 round(avg(ttft_ms) FILTER (WHERE ttft_ms IS NOT NULL)::numeric)::int AS avg_ttft_ms,
                 round((coalesce(sum(energy_j), 0) / 3600)::numeric, 2)::float AS energy_wh,
                 coalesce(sum(audio_seconds), 0)::float AS audio_seconds`;
    const where = `started_at >= $1 AND started_at < $2`;
    const [total, byModel, byCaller, series, hosts] = await Promise.all([
      query(`SELECT ${agg} FROM local_ai_runs WHERE ${where}`, span),
      query(`SELECT host, coalesce(model, service) AS model, service, ${agg} FROM local_ai_runs WHERE ${where} GROUP BY 1, 2, 3 ORDER BY output DESC, runs DESC`, span),
      query(`SELECT ${CALLER} AS caller, ${agg} FROM local_ai_runs WHERE ${where} GROUP BY 1 ORDER BY output DESC, runs DESC`, span),
      query(`SELECT (date_trunc($3, started_at AT TIME ZONE $4) AT TIME ZONE $4) AS bucket, ${CALLER} AS key,
                    coalesce(sum(prompt_tokens), 0)::bigint AS prompt, coalesce(sum(output_tokens), 0)::bigint AS output, count(*)::int AS runs
             FROM local_ai_runs WHERE ${where} GROUP BY 1, 2 ORDER BY 1, 2`, [...span, q.bucket, q.tz]),
      query(`SELECT c.host, h.display, max(c.last_ok_at) AS last_ok_at, max(c.last_try_at) AS last_try_at,
                    string_agg(c.tbl || ': ' || c.last_error, '; ') FILTER (WHERE c.last_error IS NOT NULL) AS error,
                    (SELECT max(started_at) FROM local_ai_runs r WHERE r.host = c.host) AS last_run_at
             FROM local_ai_cursors c JOIN usage_hosts h ON h.slug = c.host GROUP BY c.host, h.display ORDER BY c.host`),
    ]);
    res.json({ bucket: q.bucket, tz: q.tz, total: total.rows[0], models: byModel.rows, callers: byCaller.rows, series: series.rows, hosts: hosts.rows });
  }));

  router.get('/runs', wrap(async (req, res) => {
    const q = parseOr400(runsQuery, req.query);
    const params: unknown[] = [new Date(q.from), new Date(q.to)];
    const conds = ['started_at >= $1', 'started_at < $2'];
    if (q.caller) { params.push(q.caller); conds.push(`${CALLER} = $${params.length}`); }
    if (q.model) { params.push(q.model); conds.push(`coalesce(model, service) = $${params.length}`); }
    if (q.state) { params.push(q.state); conds.push(`state = $${params.length}`); }
    params.push(q.limit);
    const { rows } = await query(
      `SELECT host, id, started_at, ended_at, state, service, route, coalesce(model, service) AS model, ${CALLER} AS caller,
              tool_names, message_count, prompt_tokens, cached_tokens, output_tokens, ttft_ms, total_ms, output_tps,
              cold_start, done_reason, audio_seconds, voice, energy_j, error
       FROM local_ai_runs WHERE ${conds.join(' AND ')} ORDER BY started_at DESC LIMIT $${params.length}`, params);
    res.json({ runs: rows });
  }));

  // One run with its texts in order, each cut at TEXT_LIMIT characters.
  router.get('/runs/:host/:id', wrap(async (req, res) => {
    const p = parseOr400(z.object({ host: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/), id: z.string().uuid() }), req.params);
    const run = await query(`SELECT *, ${CALLER} AS caller FROM local_ai_runs WHERE host = $1 AND id = $2`, [p.host, p.id]);
    if (!run.rows[0]) throw new HttpError(404, 'no such run');
    const texts = await query(
      `SELECT rt.seq, rt.role, rt.kind, t.chars, left(t.content, $3) AS content, (t.chars > $3) AS truncated
       FROM local_ai_run_texts rt LEFT JOIN local_ai_texts t ON t.host = rt.host AND t.sha256 = rt.text_sha256
       WHERE rt.host = $1 AND rt.run_id = $2 ORDER BY rt.seq`, [p.host, p.id, TEXT_LIMIT]);
    res.json({ run: run.rows[0], texts: texts.rows });
  }));

  return router;
}
