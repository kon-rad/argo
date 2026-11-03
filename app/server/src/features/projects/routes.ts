import { config } from '../../config.js';
import { projectsFeedRouter, projectsRouter } from '../../routes/projects.js';
import type { FeatureRoutes } from '../types.js';

export const routes: FeatureRoutes = ({ vaultRoot, opts }) => [
  // A kiosk's read-only summary: a bearer token, no session.
  { path: '/api/feed', router: projectsFeedRouter(vaultRoot, opts.projectsFeedToken ?? config.projectsFeedToken), mount: 'public' },
  { path: '/api/projects', router: projectsRouter(vaultRoot) },
];
