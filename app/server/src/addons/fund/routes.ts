import type { FeatureRoutes } from '../../features/types.js';
import { fundRouter } from '../../routes/fund.js';

export const routes: FeatureRoutes = ({ vaultRoot, opts }) => [
  { path: '/api/fund', router: fundRouter(vaultRoot, opts.fund) },
];
