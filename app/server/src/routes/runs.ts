import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { parseOr400, wrap } from './http.js';

const Q = z.object({
  active: z.enum(['0', '1']).optional(),
  source_id: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function runsRouter(): Router {
  const router = Router();

  router.get(
    '/',
    wrap(async (req, res) => {
      const q = parseOr400(Q, req.query);
      const { rows } = await query(
        `SELECT id, source_id, status, started_at, finished_at, stats, progress, error
         FROM ingest_runs
         WHERE ($1::boolean IS NOT TRUE OR status IN ('queued','running'))
           AND ($2::int IS NULL OR source_id = $2)
         ORDER BY started_at DESC, id DESC
         LIMIT $3`,
        [q.active === '1', q.source_id ?? null, q.limit],
      );
      res.json({ runs: rows });
    }),
  );

  return router;
}
