import { orgRouter } from '../../routes/org.js';
import type { FeatureRoutes } from '../types.js';

export const routes: FeatureRoutes = ({ vaultRoot }) => [{ path: '/api/org', router: orgRouter(vaultRoot) }];
