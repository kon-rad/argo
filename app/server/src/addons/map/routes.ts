import type { FeatureRoutes } from '../../features/types.js';
import { mapRouter } from '../../routes/map.js';

export const routes: FeatureRoutes = () => [{ path: '/api/map', router: mapRouter() }];
