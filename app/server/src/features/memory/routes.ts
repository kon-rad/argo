import { memoryRouter } from '../../routes/memory.js';
import type { FeatureRoutes } from '../types.js';

export const routes: FeatureRoutes = () => [{ path: '/api/memory', router: memoryRouter() }];
