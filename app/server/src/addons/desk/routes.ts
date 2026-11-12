import type { FeatureRoutes } from '../../features/types.js';
import { loadedDeskRoutes } from './boot.js';

/**
 * The external implementation is loaded by the enabled addon's lifecycle hook (bootDesk) before createApp.
 * A missing install is reported there; an app built without that boot (tests, tools) mounts no desk routes.
 */
export const routes: FeatureRoutes = context => {
  const external = loadedDeskRoutes();
  if (!external) return [];
  return external(context) as ReturnType<FeatureRoutes>;
};
