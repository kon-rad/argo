import { createHash, timingSafeEqual } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  addVerification,
  AreaPatch,
  buildReport,
  getBoard,
  kioskSummary,
  listProjects,
  ProjectPatch,
  setAreaArchived,
  setProjectArchived,
  STAGES,
  TrackerError,
  upsertArea,
  upsertProject,
  VerificationInput,
} from './service/index.js';
import { config } from '../../config.js';
import { renderMarkdown, renderStandup, renderTelegram } from './service/report.js';
import { HttpError, parseOr400, wrap } from '../../routes/http.js';
import type { FeatureRoutes } from '../types.js';
import { ArchiveRequestSchema } from '@secondbrain/contracts/projects';
import type { ArchivedResponse, StageChangedResponse, TrackerMarkdownResponse, TrackerReport, VerificationCreatedResponse } from '@secondbrain/contracts/projects';

const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const AreaParams = z.object({ area: Slug });
const ProjectParams = z.object({ area: Slug, project: Slug });
const Format = z.object({ format: z.enum(['json', 'markdown', 'standup', 'telegram']).default('json') });
const Flag = z.enum(['1', 'true']).optional();
const BoardQuery = z.object({ archived: Flag });
const ListQuery = z.object({
  area: Slug.optional(),
  stage: z.enum(STAGES).optional(),
  due_before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  archived: Flag,
});

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

/**
 * `/api/areas`: what you run. The board (areas with their projects), the report, and the
 * writes that act on a whole area.
 */
export function areasRouter(vaultRoot: string): Router {
  const router = Router();

  router.get(
    '/',
    wrap(async (req, res) => {
      const { archived } = parseOr400(BoardQuery, req.query);
      res.json(await getBoard(vaultRoot, new Date(), { archived: Boolean(archived) }));
    }),
  );

  router.get(
    '/report',
    wrap(async (req, res) => {
      const { format } = parseOr400(Format, req.query);
      const report = await buildReport(vaultRoot);
      if (format === 'json') return void res.json(report satisfies TrackerReport);
      const text = format === 'markdown' ? renderMarkdown(report) : format === 'standup' ? renderStandup(report) : renderTelegram(report);
      const response = { format, text, as_of: report.as_of } satisfies TrackerMarkdownResponse;
      res.json(response);
    }),
  );

  router.patch(
    '/:area',
    wrap(async (req, res) => {
      const { area } = parseOr400(AreaParams, req.params);
      const patch = parseOr400(AreaPatch, req.body);
      const response = await tracked(() => upsertArea(area, patch, BY_APP));
      res.json(response satisfies StageChangedResponse);
    }),
  );

  router.get(
    '/:area/projects',
    wrap(async (req, res) => {
      const { area } = parseOr400(AreaParams, req.params);
      const { archived } = parseOr400(BoardQuery, req.query);
      res.json({ projects: await listProjects({ area, archived: Boolean(archived) }) });
    }),
  );

  router.post(
    '/:area/projects',
    wrap(async (req, res) => {
      const { area } = parseOr400(AreaParams, req.params);
      const body = parseOr400(ProjectPatch.extend({ slug: Slug, title: z.string().trim().min(1).max(200) }), req.body);
      const { slug: project, ...patch } = body;
      res.status(201).json(await tracked(() => upsertProject(area, project, patch, BY_APP, { create: true })));
    }),
  );

  for (const verb of ['archive', 'unarchive'] as const) {
    router.post(
      `/:area/${verb}`,
      wrap(async (req, res) => {
        const { area } = parseOr400(AreaParams, req.params);
        const { note } = parseOr400(ArchiveRequestSchema, req.body ?? {});
        const response = await tracked(() => setAreaArchived(area, verb === 'archive', BY_APP, note));
        res.json(response satisfies ArchivedResponse);
      }),
    );
  }

  return router;
}

/**
 * `/api/projects`: what you finish. Projects across areas, and the writes that act on one
 * project, addressed as `/:area/:project`.
 */
export function projectsRouter(): Router {
  const router = Router();

  router.get(
    '/',
    wrap(async (req, res) => {
      const q = parseOr400(ListQuery, req.query);
      res.json({ projects: await listProjects({ area: q.area, stage: q.stage, dueBefore: q.due_before, archived: Boolean(q.archived) }) });
    }),
  );

  // The report lived here before the PARA rename. A reader that still asks here (a kiosk, a
  // script) is sent to the new path for good, query string and all.
  router.get('/report', (req, res) => {
    const q = req.originalUrl.indexOf('?');
    res.redirect(308, `/api/areas/report${q >= 0 ? req.originalUrl.slice(q) : ''}`);
  });

  router.patch(
    '/:area/:project',
    wrap(async (req, res) => {
      const { area, project } = parseOr400(ProjectParams, req.params);
      const patch = parseOr400(ProjectPatch, req.body);
      const response = await tracked(() => upsertProject(area, project, patch, BY_APP));
      res.json(response satisfies StageChangedResponse);
    }),
  );

  router.post(
    '/:area/:project/verifications',
    wrap(async (req, res) => {
      const { area, project } = parseOr400(ProjectParams, req.params);
      const v = parseOr400(VerificationInput, req.body);
      const response = { id: await tracked(() => addVerification(area, project, v, BY_APP)) } satisfies VerificationCreatedResponse;
      res.status(201).json(response);
    }),
  );

  for (const verb of ['archive', 'unarchive'] as const) {
    router.post(
      `/:area/:project/${verb}`,
      wrap(async (req, res) => {
        const { area, project } = parseOr400(ProjectParams, req.params);
        const { note } = parseOr400(ArchiveRequestSchema, req.body ?? {});
        const response = await tracked(() => setProjectArchived(area, project, verb === 'archive', BY_APP, note));
        res.json(response satisfies ArchivedResponse);
      }),
    );
  }

  return router;
}

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

/**
 * Read-only summary for a kiosk, mounted before the session check. The kiosk has no
 * browser session, so it sends `Authorization: Bearer <token>` (PROJECTS_FEED_TOKEN).
 * Without a configured token the route doesn't exist. The path and the payload keep the
 * names they had before the PARA rename (see kioskSummary): the kiosk is a separate device.
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

export const routes: FeatureRoutes = ({ vaultRoot, opts }) => [
  { path: '/api/feed', router: projectsFeedRouter(vaultRoot, opts.projectsFeedToken ?? config.projectsFeedToken), mount: 'public' },
  { path: '/api/areas', router: areasRouter(vaultRoot) },
  { path: '/api/projects', router: projectsRouter() },
];
