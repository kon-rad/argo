import { Router } from 'express';
import { config } from '../../config.js';
import type { FeatureRoutes } from '../../features/types.js';
import { HttpError, wrap } from '../../routes/http.js';
import { connectorViews, dataPaths, listDashboards, listJobs, listTables, overview, renderDashboard, tableDetail } from './catalog.js';
import { loadConnectors } from './connectors.js';

/** /api/data: read-only views of the vault's tables, connectors, jobs and dashboards. */
export function dataRouter(vaultRoot: string, modules: ReadonlySet<string>): Router {
  const router = Router();
  const load = () => {
    const paths = dataPaths(vaultRoot);
    return { paths, ...loadConnectors(paths.dir) };
  };

  router.get('/overview', wrap(async (_req, res) => {
    const { defs, errors, paths } = load();
    res.json({ ...(await overview(defs, errors)), dataDir: paths.dir });
  }));

  router.get('/tables', wrap(async (_req, res) => {
    res.json({ tables: await listTables(load().defs, modules) });
  }));

  router.get('/tables/:schema/:table', wrap(async (req, res) => {
    const detail = await tableDetail(String(req.params.schema), String(req.params.table));
    if (!detail) throw new HttpError(404, 'no such table');
    res.json(detail);
  }));

  router.get('/connectors', wrap(async (_req, res) => {
    const { defs, errors } = load();
    res.json({ connectors: await connectorViews(defs), errors });
  }));

  router.get('/jobs', wrap(async (_req, res) => {
    res.json({ jobs: listJobs(load().defs, modules) });
  }));

  router.get('/dashboards', wrap(async (_req, res) => {
    res.json({ dashboards: listDashboards(load().paths.dashboards) });
  }));

  router.get('/dashboards/:name', wrap(async (req, res) => {
    let d;
    try {
      d = await renderDashboard(load().paths.dashboards, String(req.params.name));
    } catch (err) {
      throw new HttpError(400, `dashboard file is invalid: ${(err as Error).message.slice(0, 300)}`);
    }
    if (!d) throw new HttpError(404, 'no such dashboard');
    res.json(d);
  }));

  return router;
}

export const routes: FeatureRoutes = ({ vaultRoot, opts }) => [
  { path: '/api/data', router: dataRouter(vaultRoot, opts.modules ?? config.modules) },
];
