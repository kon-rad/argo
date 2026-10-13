import { Router } from 'express';
import { z } from 'zod';
import { pullRing, ringNight, ringOverview, type RingDump } from '../ring.js';
import { HttpError, parseOr400, wrap } from './http.js';

export interface RingRouterOptions {
  /** The Mac pulls from the droplet; the server receives pushes and has no pull. */
  allowPull: boolean;
  /** ssh alias of the droplet. */
  host: string;
  db: string;
  /** Overridden in tests so no ssh happens. */
  fetchDump?: (host: string, db: string) => Promise<RingDump>;
}

const Day = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'day must be YYYY-MM-DD') });

export function ringRouter(opts: RingRouterOptions): Router {
  const router = Router();

  router.get(
    '/',
    wrap(async (_req, res) => {
      res.json({ ...(await ringOverview()), can_pull: opts.allowPull });
    }),
  );

  router.get(
    '/night/:day',
    wrap(async (req, res) => {
      const { day } = parseOr400(Day, req.params);
      const night = await ringNight(day);
      if (!night.day) throw new HttpError(404, `no ring data for ${day}`);
      res.json(night);
    }),
  );

  if (opts.allowPull) {
    let running = false;
    router.post(
      '/pull',
      wrap(async (_req, res) => {
        if (running) throw new HttpError(409, 'a pull is already running');
        running = true;
        try {
          res.json({ counts: await pullRing(opts.host, opts.db, opts.fetchDump) });
        } catch (err) {
          throw new HttpError(502, err instanceof Error ? err.message : String(err));
        } finally {
          running = false;
        }
      }),
    );
  }

  return router;
}
