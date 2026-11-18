import type { FeatureRoutes } from '../../features/types.js';
import { localAiRouter } from '../../routes/localAi.js';
export const routes: FeatureRoutes = () => [{ path: '/api/local-ai', router: localAiRouter() }];
