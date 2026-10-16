import { createHash, timingSafeEqual } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  addVerification,
  buildReport,
  FeaturePatch,
  getBoard,
  kioskSummary,
  ProjectPatch,
  TrackerError,
  upsertFeature,
  upsertProject,
  VerificationInput,
} from '../projects.js';
import { config } from '../config.js';
import { renderMarkdown, renderStandup, renderTelegram } from '../projects-report.js';
import { HttpError, parseOr400, wrap } from './http.js';

const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const Params = z.object({ slug: Slug, feature: Slug.optional() });
const Format = z.object({ format: z.enum(['json', 'markdown', 'standup', 'telegram']).default('json') });

/** Everything written from the browser is attributed to the owner. */
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

export function projectsRouter(vaultRoot: string): Router {
  const router = Router();

  router.get(
    '/',
    wrap(async (_req, res) => {
      res.json(await getBoard(vaultRoot));
    }),
  );

  router.get(
    '/report',
    wrap(async (req, res) => {
      const { format } = parseOr400(Format, req.query);
      const report = await buildReport(vaultRoot);
      if (format === 'json') return void res.json(report);
      const text = format === 'markdown' ? renderMarkdown(report) : format === 'standup' ? renderStandup(report) : renderTelegram(report);
      res.json({ format, text, as_of: report.as_of });
    }),
  );

  router.patch(
    '/:slug',
    wrap(async (req, res) => {
      const { slug } = parseOr400(Params, req.params);
      const patch = parseOr400(ProjectPatch, req.body);
      res.json(await tracked(() => upsertProject(slug, patch, BY_APP)));
    }),
  );

  router.post(
    '/:slug/features',
    wrap(async (req, res) => {
      const { slug } = parseOr400(Params, req.params);
      const body = parseOr400(FeaturePatch.extend({ slug: Slug, title: z.string().trim().min(1).max(200) }), req.body);
      const { slug: feature, ...patch } = body;
      res.status(201).json(await tracked(() => upsertFeature(slug, feature, patch, BY_APP, { create: true })));
    }),
  );

  router.patch(
    '/:slug/features/:feature',
    wrap(async (req, res) => {
      const { slug, feature } = parseOr400(Params, req.params);
      const patch = parseOr400(FeaturePatch, req.body);
      res.json(await tracked(() => upsertFeature(slug, feature!, patch, BY_APP)));
    }),
  );

  router.post(
    '/:slug/features/:feature/verifications',
    wrap(async (req, res) => {
      const { slug, feature } = parseOr400(Params, req.params);
      const v = parseOr400(VerificationInput, req.body);
      res.status(201).json({ id: await tracked(() => addVerification(slug, feature!, v, BY_APP)) });
    }),
  );

  return router;
}

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

/**
 * Read-only summary for the Exo kiosk, mounted before the session check. The
 * kiosk has no browser session, so it sends `Authorization: Bearer <token>`
 * (PROJECTS_FEED_TOKEN). Without a configured token the route doesn't exist.
 */
export function projectsFeedRouter(vaultRoot: string, token: string | undefined): Router {
  const router = Router();
  if (!token) return router;
  const want = digest(token);
  const authorized = (req: Request): boolean => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    return Boolean(m && timingSafeEqual(digest(m[1]!), want));
  };
  router.get(
    '/projects',
    wrap(async (req, res) => {
      if (!authorized(req)) throw new HttpError(401, 'bad or missing token');
      res.setHeader('Cache-Control', 'no-store');
      res.json(kioskSummary(await buildReport(vaultRoot)));
    }),
  );
  return router;
}
