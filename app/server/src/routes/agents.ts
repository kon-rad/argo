import { execFile } from 'node:child_process';
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { HttpError, intParam, parseOr400, wrap } from './http.js';

/**
 * The Agents and Cron pages. Everything here reads what `secondbrain
 * agents-sync` copied into Postgres; nothing touches Hermes's own files, so
 * the server's sandbox (read-only home) is never a problem. The one live read
 * is systemd's timer list.
 */

const ChatList = z.object({
  platform: z.string().regex(/^[a-z_]+$/).optional(),
  profile: z.string().regex(/^[A-Za-z0-9_.-]+$/).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

const SESSION_COLUMNS = `s.id, s.source, s.host, s.external_id, s.parent_external_id, s.title, s.model,
  s.started_at, s.ended_at, s.message_count,
  COALESCE(s.meta->>'profile', 'main') AS profile, s.meta->>'source' AS platform,
  s.meta->>'display_name' AS display_name, s.meta->>'chat_type' AS chat_type, s.meta->>'chat_id' AS chat_id,
  s.meta->>'user_id' AS user_id, s.meta->>'timezone' AS timezone`;

/** systemd's timers, live. Absent on the Mac (no systemctl) and harmless if it fails. */
export function listSystemdTimers(): Promise<{ available: boolean; timers: unknown[] }> {
  return new Promise((resolve) => {
    execFile('systemctl', ['list-timers', '--all', '--output=json', '--no-pager'], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve({ available: false, timers: [] });
      try {
        const rows = JSON.parse(stdout) as { unit: string; activates: string; next: number | null; last: number | null }[];
        // systemd reports microseconds since the epoch; 0 or null means "never".
        const iso = (us: number | null) => (us ? new Date(us / 1000).toISOString() : null);
        resolve({
          available: true,
          timers: rows.map((r) => ({ unit: r.unit, activates: r.activates, next: iso(r.next), last: iso(r.last) })),
        });
      } catch {
        resolve({ available: false, timers: [] });
      }
    });
  });
}

export function agentsRouter(timers: () => Promise<{ available: boolean; timers: unknown[] }> = listSystemdTimers): Router {
  const router = Router();

  router.get(
    '/chats',
    wrap(async (req, res) => {
      const q = parseOr400(ChatList, req.query);
      const where = [`s.source LIKE 'hermes%'`];
      const params: unknown[] = [];
      if (q.platform) where.push(`s.meta->>'source' = $${params.push(q.platform)}`);
      if (q.profile) where.push(`COALESCE(s.meta->>'profile','main') = $${params.push(q.profile)}`);
      const sessions = await query(
        `SELECT ${SESSION_COLUMNS} FROM archive_sessions s WHERE ${where.join(' AND ')}
         ORDER BY s.started_at DESC NULLS LAST, s.id DESC LIMIT ${q.limit} OFFSET ${q.offset}`,
        params,
      );
      const facets = await query<{ platform: string | null; profile: string; n: number }>(
        `SELECT s.meta->>'source' AS platform, COALESCE(s.meta->>'profile','main') AS profile, count(*)::int AS n
           FROM archive_sessions s WHERE s.source LIKE 'hermes%' GROUP BY 1, 2 ORDER BY 3 DESC`,
      );
      const sync = await query<{ ran_at: string; host: string }>(
        `SELECT ran_at, host FROM agents_sync_runs ORDER BY id DESC LIMIT 1`,
      );
      res.json({ sessions: sessions.rows, facets: facets.rows, last_sync: sync.rows[0] ?? null });
    }),
  );

  router.get(
    '/chats/:id',
    wrap(async (req, res) => {
      const id = intParam(req.params.id, 'chat id');
      const s = await query(`SELECT ${SESSION_COLUMNS} FROM archive_sessions s WHERE s.id = $1 AND s.source LIKE 'hermes%'`, [id]);
      if (!s.rows[0]) throw new HttpError(404, 'no such chat');
      const messages = await query(
        `SELECT m.seq, m.role, m.ts, m.raw->>'content' AS content, m.raw->>'reasoning' AS reasoning,
                m.raw->>'tool_calls' AS tool_calls, m.raw->>'tool_name' AS tool_name, m.raw->>'finish_reason' AS finish_reason
           FROM archive_messages m WHERE m.session_id = $1 ORDER BY m.seq LIMIT 5000`,
        [id],
      );
      res.json({ session: s.rows[0], messages: messages.rows });
    }),
  );

  router.get(
    '/cron/jobs',
    wrap(async (_req, res) => {
      const jobs = await query(
        `SELECT j.profile, j.job_id, j.name, j.schedule, j.state, j.enabled, j.next_run_at, j.last_run_at,
                j.last_status, j.last_error, j.deliver, j.skill, j.timezone, j.removed_at,
                (SELECT count(*)::int FROM cron_runs r WHERE r.profile = j.profile AND r.job_id = j.job_id) AS runs,
                (SELECT count(*)::int FROM cron_outputs o WHERE o.profile = j.profile AND o.job_id = j.job_id) AS outputs
           FROM cron_jobs j
          ORDER BY (j.removed_at IS NOT NULL), (j.state = 'scheduled' AND j.enabled) DESC, j.name`,
      );
      const sync = await query(`SELECT ran_at, host, counts FROM agents_sync_runs ORDER BY id DESC LIMIT 1`);
      res.json({ jobs: jobs.rows, last_sync: sync.rows[0] ?? null });
    }),
  );

  router.get(
    '/cron/jobs/:profile/:jobId',
    wrap(async (req, res) => {
      const { profile, jobId } = req.params as { profile: string; jobId: string };
      const job = await query(`SELECT * FROM cron_jobs WHERE profile = $1 AND job_id = $2`, [profile, jobId]);
      if (!job.rows[0]) throw new HttpError(404, 'no such cron job');
      const runs = await query(
        `SELECT id, status, claimed_at, started_at, finished_at, error FROM cron_runs
          WHERE profile = $1 AND job_id = $2 ORDER BY COALESCE(started_at, claimed_at) DESC`,
        [profile, jobId],
      );
      const outputs = await query(
        `SELECT file_name, run_at, length(content) AS chars,
                -- Hermes writes the whole prompt first; the preview is what the job answered.
                left(btrim(CASE WHEN strpos(content, E'\n## Response') > 0
                           THEN substr(content, strpos(content, E'\n## Response') + 12) ELSE content END), 280) AS preview
           FROM cron_outputs
          WHERE profile = $1 AND job_id = $2 ORDER BY run_at DESC NULLS LAST, file_name DESC`,
        [profile, jobId],
      );
      // Each run's agent transcript: Hermes names cron sessions cron_<job id>_<local time>.
      const source = profile === 'main' ? 'hermes' : `hermes:${profile}`;
      const sessions = await query(
        `SELECT id, external_id, started_at, message_count FROM archive_sessions
          WHERE source = $1 AND external_id LIKE $2 ORDER BY started_at DESC NULLS LAST`,
        [source, `cron\\_${jobId.replace(/[%_\\]/g, '\\$&')}\\_%`],
      );
      res.json({ job: job.rows[0], runs: runs.rows, outputs: outputs.rows, sessions: sessions.rows });
    }),
  );

  router.get(
    '/cron/jobs/:profile/:jobId/outputs/:file',
    wrap(async (req, res) => {
      const { profile, jobId, file } = req.params as { profile: string; jobId: string; file: string };
      const r = await query(
        `SELECT file_name, run_at, content FROM cron_outputs WHERE profile = $1 AND job_id = $2 AND file_name = $3`,
        [profile, jobId, file],
      );
      if (!r.rows[0]) throw new HttpError(404, 'no such output');
      res.json(r.rows[0]);
    }),
  );

  router.get(
    '/cron/timers',
    wrap(async (_req, res) => {
      res.json(await timers());
    }),
  );

  return router;
}
