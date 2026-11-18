import { config } from '../../config.js';
import type { FeatureRoutes } from '../../features/types.js';
import { mountUploads } from '../../uploads/setup.js';
import { uploadsPullRouter } from '../../routes/uploadsPull.js';

// The second machine's pull calls carry a bearer token, no session, so they sit ahead of the login
// gates; the browser upload routes are session-gated. The worker that drains finished uploads is
// attached to app.locals and started by the bootstrap (server/src/index.ts).
export const routes: FeatureRoutes = ({ vaultRoot, opts, app }) => {
  const uploads = mountUploads(vaultRoot, opts.uploads);
  app.locals['uploadsWorker'] = uploads.worker;
  return [
    { path: '/api/uploads/pull', router: uploadsPullRouter(opts.uploadsPullToken ?? config.uploadsPullToken), mount: 'public' },
    { path: '/api/uploads', router: uploads.router },
  ];
};
