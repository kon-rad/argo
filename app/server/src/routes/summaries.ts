import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import { buildDigest } from '../summaries/digest.js';
import { HttpError, parseOr400, wrap } from './http.js';

/**
 * Agent summaries (docs/summaries.md): one record per finished session, written by `secondbrain summarize`,
 * plus the facts a session proposed. Read-only except for deciding on a proposed fact.
 */
const iso = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'not a date');
const list = z.string().optional().transform((s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined));
const listQuery = z.object({
  from: iso.optional(), to: iso.optional(),
  harness: list, host: list, outcome: list, project: list, provider: list,
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export function summariesRouter(): Router {
  const router = Router();

  router.get('/', wrap(async (req, res) => {
    const q = parseOr400(listQuery, req.query);
    const params: unknown[] = [q.from ? new Date(q.from) : new Date(Date.now() - 2 * 86400_000), q.to ? new Date(q.to) : new Date(Date.now() + 86400_000)];
    const where: string[] = [`s.status = 'ok'`, `coalesce(s.ended_at, s.started_at, s.updated_at) >= $1`, `coalesce(s.ended_at, s.started_at, s.updated_at) < $2`];
    for (const [col, v] of [['s.harness', q.harness], ['s.host', q.host], ['s.outcome', q.outcome], ['s.project', q.project], ['s.writer_provider', q.provider]] as const) {
      if (v?.length) where.push(`${col} = ANY($${params.push(v)})`);
    }
    if (q.q) where.push(`(s.request || ' ' || s.done || ' ' || s.learned || ' ' || s.open_items) ILIKE $${params.push(`%${q.q.replace(/[%_\\]/g, '\\$&')}%`)}`);
    const { rows } = await query(
      `SELECT s.id, s.session_id, s.harness, s.host, s.profile, s.project, s.started_at, s.ended_at, s.request, s.done, s.learned, s.open_items,
              s.outcome, s.touched, s.metrics, s.writer_provider, s.writer_model, a.title, a.external_id, a.source,
              (SELECT count(*) FROM agent_summary_facts f WHERE f.summary_id = s.id AND f.status = 'proposed')::int AS proposed_facts
         FROM agent_summaries s JOIN archive_sessions a ON a.id = s.session_id
        WHERE ${where.join(' AND ')}
        ORDER BY coalesce(s.ended_at, s.started_at) DESC LIMIT $${params.push(q.limit)}`, params);
    res.json({ summaries: rows });
  }));

  // What the page shows above the list: outcomes, volume by day, who wrote the summaries, and how much was skipped or is waiting.
  router.get('/overview', wrap(async (req, res) => {
    const q = parseOr400(z.object({ from: iso.optional(), to: iso.optional(), tz: z.string().min(1).default('UTC') }), req.query);
    const tz = (await query(`SELECT 1 FROM pg_timezone_names WHERE name = $1`, [q.tz])).rowCount ? q.tz : null;
    if (!tz) throw new HttpError(400, 'invalid request', { issues: [{ path: 'tz', message: 'unknown time zone' }] });
    const from = q.from ? new Date(q.from) : new Date(Date.now() - 7 * 86400_000);
    const to = q.to ? new Date(q.to) : new Date(Date.now() + 86400_000);
    const when = `coalesce(ended_at, started_at, updated_at) >= $1 AND coalesce(ended_at, started_at, updated_at) < $2`;
    const [outcomes, days, writers, totals, pending] = await Promise.all([
      query(`SELECT outcome AS key, count(*)::int AS n FROM agent_summaries WHERE status='ok' AND ${when} GROUP BY 1 ORDER BY 2 DESC`, [from, to]),
      query(`SELECT (date_trunc('day', coalesce(ended_at, started_at, updated_at) AT TIME ZONE $3))::date AS day, count(*)::int AS sessions,
                    count(*) FILTER (WHERE outcome='finished')::int AS finished,
                    count(*) FILTER (WHERE outcome IN ('blocked','failed'))::int AS stuck,
                    coalesce(sum(((metrics->>'input_tokens')::bigint + (metrics->>'cache_write_tokens')::bigint + (metrics->>'cache_read_tokens')::bigint + (metrics->>'output_tokens')::bigint)), 0)::bigint AS tokens,
                    coalesce(avg(((metrics->>'error_steps')::numeric)), 0)::float AS errors_per_session
               FROM agent_summaries WHERE status='ok' AND ${when} GROUP BY 1 ORDER BY 1`, [from, to, tz]),
      query(`SELECT coalesce(writer_provider,'?') || '/' || coalesce(writer_model,'?') AS key, count(*)::int AS n,
                    coalesce(sum(writer_input_tokens),0)::bigint AS input, coalesce(sum(writer_output_tokens),0)::bigint AS output
               FROM agent_summaries WHERE status='ok' AND ${when} GROUP BY 1 ORDER BY 2 DESC`, [from, to]),
      query(`SELECT count(*) FILTER (WHERE status='ok')::int AS summarized, count(*) FILTER (WHERE status='skipped')::int AS skipped FROM agent_summaries WHERE ${when}`, [from, to]),
      query(`SELECT count(*)::int AS n FROM agent_summary_facts WHERE status='proposed'`),
    ]);
    res.json({ from, to, tz, outcomes: outcomes.rows, days: days.rows, writers: writers.rows, ...totals.rows[0], proposed_facts: pending.rows[0]!.n });
  }));

  router.get('/digest', wrap(async (req, res) => {
    const q = parseOr400(z.object({ hours: z.coerce.number().int().min(1).max(168).default(24), max: z.coerce.number().int().min(500).max(30000).default(6000) }), req.query);
    res.type('text/markdown').send(await buildDigest(q.hours, q.max));
  }));

  router.get('/facts', wrap(async (req, res) => {
    const q = parseOr400(z.object({ status: z.enum(['proposed', 'promoted', 'rejected']).default('proposed'), limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    const { rows } = await query(
      `SELECT f.id, f.summary_id, f.subject, f.claim, f.status, f.fact_id, f.decided_by, f.decided_at, f.created_at,
              s.project, s.harness, s.host, s.session_id, a.external_id, a.source, s.request
         FROM agent_summary_facts f JOIN agent_summaries s ON s.id = f.summary_id JOIN archive_sessions a ON a.id = s.session_id
        WHERE f.status = $1 ORDER BY f.id DESC LIMIT $2`, [q.status, q.limit]);
    res.json({ facts: rows });
  }));

  const decide = z.object({ subject: z.string().trim().min(1).max(200).optional(), claim: z.string().trim().min(1).max(1000).optional(), project: z.string().trim().max(100).optional() });

  router.post('/facts/:id/promote', wrap(async (req, res) => {
    const id = parseOr400(z.coerce.number().int().positive(), req.params.id);
    const body = parseOr400(decide, req.body ?? {});
    const out = await withTransaction(async (tx) => {
      const { rows } = await tx.query<{ id: number; subject: string; claim: string; status: string; summary_id: number; project: string | null; host: string; external_id: string }>(
        `SELECT f.id, f.subject, f.claim, f.status, f.summary_id, s.project, s.host, a.external_id
           FROM agent_summary_facts f JOIN agent_summaries s ON s.id = f.summary_id JOIN archive_sessions a ON a.id = s.session_id
          WHERE f.id = $1 FOR UPDATE OF f`, [id]);
      const f = rows[0];
      if (!f) throw new HttpError(404, 'no such candidate');
      if (f.status !== 'proposed') throw new HttpError(409, `already ${f.status}`);
      const slug = body.project ?? f.project;
      const known = slug ? (await tx.query(`SELECT 1 FROM projects WHERE slug = $1`, [slug])).rowCount : 0;
      const source = `agent-summary:${f.summary_id} (session ${f.host}/${f.external_id})`.slice(0, 500);
      const fact = await tx.query<{ id: number }>(
        `INSERT INTO memory_facts (subject, claim, source, author, via, project_slug, confidence)
         VALUES ($1,$2,$3,'summarizer','agent-summaries',$4,'inferred') RETURNING id`,
        [body.subject ?? f.subject, (body.claim ?? f.claim).replace(/\s+/g, ' '), source, known ? slug : null]);
      await tx.query(`UPDATE agent_summary_facts SET status='promoted', fact_id=$2, decided_by='owner', decided_at=now() WHERE id=$1`, [id, fact.rows[0]!.id]);
      return { id, status: 'promoted', fact_id: fact.rows[0]!.id };
    });
    res.json(out);
  }));

  router.post('/facts/:id/reject', wrap(async (req, res) => {
    const id = parseOr400(z.coerce.number().int().positive(), req.params.id);
    const r = await query(`UPDATE agent_summary_facts SET status='rejected', decided_by='owner', decided_at=now() WHERE id=$1 AND status='proposed' RETURNING id`, [id]);
    if (!r.rowCount) throw new HttpError(404, 'no such open candidate');
    res.json({ id, status: 'rejected' });
  }));

  router.get('/:id', wrap(async (req, res) => {
    const id = parseOr400(z.coerce.number().int().positive(), req.params.id);
    const s = (await query(
      `SELECT s.*, a.title, a.external_id, a.source FROM agent_summaries s JOIN archive_sessions a ON a.id = s.session_id WHERE s.id = $1`, [id])).rows[0];
    if (!s) throw new HttpError(404, 'no such summary');
    const facts = (await query(`SELECT id, subject, claim, status, fact_id FROM agent_summary_facts WHERE summary_id = $1 ORDER BY id`, [id])).rows;
    res.json({ summary: s, facts });
  }));

  return router;
}
