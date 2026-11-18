import type { FeatureRoutes } from '../../features/types.js';
import { mediaRouter } from '../../routes/media.js';

export const routes: FeatureRoutes = ({ vaultRoot }) => [{ path: '/api/media', router: mediaRouter(vaultRoot) }];
