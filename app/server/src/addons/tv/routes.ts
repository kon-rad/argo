import type { FeatureRoutes } from '../../features/types.js';
import { tvRouter } from '../../routes/tv.js';

export const routes: FeatureRoutes = ({ vaultRoot }) => [{ path: '/api/tv', router: tvRouter(vaultRoot) }];
