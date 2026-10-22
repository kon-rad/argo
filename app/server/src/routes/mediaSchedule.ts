import { Router } from 'express';
import { z } from 'zod';
import { BrandLoadError, brandCalendar, loadBrands } from '../media-schedule.js';
import { HttpError, parseOr400, wrap } from './http.js';

const Range = z.object({ from: z.coerce.date(), to: z.coerce.date() }).refine((r) => r.to > r.from, 'to must be after from');
const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/);

/**
 * /api/media/brands: the media schedule page's data (social module). Mounted
 * ahead of the media gallery's router so `/brands` is not read as a file path.
 * Approve and cancel stay on /api/social/posts; the page calls those.
 */
export function mediaScheduleRouter(vaultRoot: string): Router {
  const router = Router();

  router.get(
    '/',
    wrap(async (_req, res) => {
      res.json({ brands: await loadBrands(vaultRoot) });
    }),
  );

  router.get(
    '/:slug/calendar',
    wrap(async (req, res) => {
      const slug = parseOr400(Slug, req.params.slug);
      const { from, to } = parseOr400(Range, req.query);
      if (to.getTime() - from.getTime() > 120 * 86_400_000) throw new HttpError(400, 'ask for 120 days or fewer');
      try {
        const cal = await brandCalendar(vaultRoot, slug, from, to);
        if (!cal) throw new HttpError(404, `no brand "${slug}"`);
        res.json(cal);
      } catch (err) {
        if (err instanceof BrandLoadError) throw new HttpError(422, err.message, { error: err.detail });
        throw err;
      }
    }),
  );

  return router;
}
