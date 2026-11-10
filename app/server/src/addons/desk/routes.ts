import type { FeatureRoutes } from '../../features/types.js';
import { loadedDeskRoutes } from './boot.js';

/** The external implementation is loaded by the enabled addon's lifecycle hook before createApp. */
export const routes: FeatureRoutes = context => {
  const external = loadedDeskRoutes();
  if (!external) throw new Error('Hiring desk routes are unavailable. Install @secondbrain/hiring-desk and run secondbrain doctor.');
  return external(context) as ReturnType<FeatureRoutes>;
};
