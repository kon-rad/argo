import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { getVenture, listVentures, scaffoldVenture, upsertVenture, VenturePatch, ventureKinds } from '../ventures.js';
import { TrackerError } from '../projects.js';
import { HttpError, parseOr400, wrap } from './http.js';

const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/);
const BY_APP = `${config.orgOwner}@app`;

async function tracked<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof TrackerError) throw new HttpError(err.status, err.message);
    if (err instanceof z.ZodError) {
      throw new HttpError(400, 'invalid request', { issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    throw err;
  }
}

/** Ventures: the things the owner runs, each with a vault home folder and a brand kit. Mounted with the `projects` module. */
export function venturesRouter(vaultRoot: string): Router {
  const router = Router();

  router.get('/', wrap(async (_req, res) => {
    res.json({ kinds: ventureKinds(), ventures: await listVentures(vaultRoot) });
  }));

  router.get('/:slug', wrap(async (req, res) => {
    const { slug } = parseOr400(z.object({ slug: Slug }), req.params);
    res.json(await tracked(() => getVenture(vaultRoot, slug)));
  }));

  router.put('/:slug', wrap(async (req, res) => {
    const { slug } = parseOr400(z.object({ slug: Slug }), req.params);
    const patch = parseOr400(VenturePatch, req.body);
    const r = await tracked(() => upsertVenture(slug, patch, BY_APP, { create: true }));
    res.status(r.created ? 201 : 200).json(r);
  }));

  router.post('/:slug/scaffold', wrap(async (req, res) => {
    const { slug } = parseOr400(z.object({ slug: Slug }), req.params);
    res.json(await tracked(() => scaffoldVenture(vaultRoot, slug)));
  }));

  return router;
}
