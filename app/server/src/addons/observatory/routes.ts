import { config } from '../../config.js';
import { Router } from 'express';
import { z } from 'zod';
import type { FeatureRoutes } from '../../features/types.js';
import { HttpError, parseOr400, wrap } from '../../routes/http.js';
import { Exports } from './exports.js';
import { authorizeDetail, authorizeExport, coverage, loadWindow, readSnapshot } from './service.js';

const rangeQuery = z.object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }),
  host: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).optional(), session: z.coerce.number().int().positive().safe().optional() }).strict();
const pageQuery = z.object({ export: z.uuid(), offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(500).default(500) }).strict();
function range(input: unknown) {
  const q = parseOr400(rangeQuery, input); const from = Date.parse(q.from), to = Date.parse(q.to);
  if (to <= from || to - from > 86400_000) throw new HttpError(400, 'range must be positive and at most 24 hours');
  return { ...q, from, to };
}
export function observatoryRouter(modules: ReadonlySet<string>, vaultRoot?: string): Router {
  const router = Router(); const exports = new Exports();
  // Session middleware authenticates the sole owner on remote deployments. Local access is the local owner.
  const owner = (res: { locals: Record<string, unknown> }) => String(res.locals.sessionHash ?? 'local-owner');
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/coverage', wrap(async (req, res) => { const q = range(req.query); res.json(await readSnapshot(db => coverage(db, q, modules))); }));
  router.get('/window', wrap(async (req, res) => {
    if (req.query.export !== undefined) {
      const q = parseOr400(pageQuery, req.query);
      const data = exports.get(owner(res), q.export);
      await readSnapshot(db => authorizeExport(db, data, modules));
      const { refs: _refs, ...page } = exports.page(owner(res), q.export, q.offset, q.limit); res.json(page); return;
    }
    const q = range(req.query); const data = await readSnapshot(db => loadWindow(db, q, modules, vaultRoot));
    const token = exports.put(owner(res), data); const { refs: _refs, ...page } = exports.page(owner(res), token, 0, 500); res.json(page);
  }));
  router.get('/events/:id', wrap(async (req, res) => {
    const q = parseOr400(z.object({ export: z.uuid() }).strict(), req.query);
    const event = exports.event(owner(res), q.export, String(req.params.id));
    await readSnapshot(db => authorizeDetail(db, event, modules));
    // Return a verified source pointer and pinned metadata. No hidden thinking or transcript text.
    res.json({ event, detail: { source: event.source, availability: event.kind === 'thinking' ? 'availability-only' : 'source-pointer', content: 'not-included' } });
  }));
  return router;
}
export const routes: FeatureRoutes = ({ opts }) => [{ path: '/api/observatory', router: observatoryRouter(opts.modules ?? config.modules, opts.vaultRoot ?? config.vaultRoot) }];
