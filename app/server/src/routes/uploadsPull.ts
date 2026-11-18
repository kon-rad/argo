import { createHash, timingSafeEqual } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { settings } from '../settings.js';
import { HttpError, parseOr400, wrap } from './http.js';

/**
 * What the second machine (the editing machine) calls to pick up working copies: a bearer token, no session, like the board's
 * per-device tokens. It can list the files waiting for it and report progress. It cannot read a file; the machine
 * fetches the bytes from the bucket with its own keys.
 */

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

function tokenGate(token: string | undefined): RequestHandler {
  const want = token ? digest(token) : null;
  return (req, _res, next) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    if (!want || !m || !timingSafeEqual(digest(m[1]!), want)) return next(new HttpError(401, 'pull token required'));
    next();
  };
}

const Done = z.object({ path: z.string().min(1).max(2000) });
const Fail = z.object({ error: z.string().min(1).max(500) });

interface PendingRow {
  id: string;
  filename: string;
  size_bytes: string;
  dest_dir: string;
  b2_path: string;
  description: string;
}

export function uploadsPullRouter(token: string | undefined): Router {
  const router = Router();
  router.use(tokenGate(token));

  router.get(
    '/pending',
    wrap(async (_req, res) => {
      // A pull that died halfway leaves 'pulling'; after two hours it is offered again.
      const { rows } = await query<PendingRow>(
        `SELECT id, filename, size_bytes, dest_dir, b2_path, description FROM uploads
         WHERE status = 'stored' AND to_m1 AND (m1_status = 'pending' OR (m1_status = 'pulling' AND updated_at < now() - interval '2 hours'))
         ORDER BY completed_at LIMIT 20`,
      );
      res.json({
        m1Dir: settings().uploads.m1Dir,
        uploads: rows.map((r) => ({ ...r, size_bytes: Number(r.size_bytes) })),
      });
    }),
  );

  const transition = (sql: string, params: (req: { params: Record<string, string | string[] | undefined>; body: unknown }) => unknown[]): RequestHandler =>
    wrap(async (req, res) => {
      const id = String(req.params['id'] ?? '');
      if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(404, 'no such upload');
      const { rowCount } = await query(sql, [id, ...params(req)]);
      if (!rowCount) throw new HttpError(409, 'upload is not waiting for the editing machine');
      res.json({ ok: true });
    });

  router.post(
    '/:id/start',
    transition(`UPDATE uploads SET m1_status = 'pulling', m1_error = NULL, updated_at = now() WHERE id = $1 AND to_m1 AND m1_status IN ('pending', 'pulling')`, () => []),
  );
  router.post(
    '/:id/done',
    transition(`UPDATE uploads SET m1_status = 'done', m1_path = $2, m1_error = NULL, updated_at = now() WHERE id = $1 AND m1_status = 'pulling'`, (req) => [parseOr400(Done, req.body).path]),
  );
  router.post(
    '/:id/fail',
    transition(`UPDATE uploads SET m1_status = 'failed', m1_error = $2, updated_at = now() WHERE id = $1 AND m1_status = 'pulling'`, (req) => [parseOr400(Fail, req.body).error]),
  );

  return router;
}
