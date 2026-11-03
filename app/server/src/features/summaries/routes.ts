import { summariesRouter } from '../../routes/summaries.js';
import type { FeatureRoutes } from '../types.js';

export const routes: FeatureRoutes = () => [{ path: '/api/summaries', router: summariesRouter() }];
