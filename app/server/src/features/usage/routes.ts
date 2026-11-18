import { ingestRouter } from '../../routes/ingest.js';
import { usageRouter } from '../../routes/usage.js';
import type { FeatureRoutes } from '../types.js';

export const routes: FeatureRoutes = () => [
  // Each machine's agent ledger syncs here with a device token, no session. Mounted ahead of the
  // global body parser: the router checks the token before it reads its large body.
  { path: '/api/ingest', router: ingestRouter(), mount: 'raw' },
  { path: '/api/usage', router: usageRouter() },
];
