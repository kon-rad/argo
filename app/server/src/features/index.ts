import type express from 'express';
import boardManifest from './board/manifest.js';
import { routes as boardRoutes } from './board/routes.js';
import memoryManifest from './memory/manifest.js';
import { routes as memoryRoutes } from './memory/routes.js';
import orgManifest from './org/manifest.js';
import { routes as orgRoutes } from './org/routes.js';
import projectsManifest from './projects/manifest.js';
import { routes as projectsRoutes } from './projects/routes.js';
import summariesManifest from './summaries/manifest.js';
import { routes as summariesRoutes } from './summaries/routes.js';
import type { Feature, FeatureContext, FeatureRoute, MountPoint } from './types.js';
import usageManifest from './usage/manifest.js';
import { routes as usageRoutes } from './usage/routes.js';

export { ALL_MANIFESTS, MANIFESTS, cliFor, enabledManifests, navFor, unitsFor, wrappersFor } from './registry.js';
export type * from './types.js';

/** Every feature with its routes, in the registry's order. */
export const FEATURES: readonly Feature[] = [
  { ...projectsManifest, routes: projectsRoutes },
  { ...memoryManifest, routes: memoryRoutes },
  { ...orgManifest, routes: orgRoutes },
  { ...boardManifest, routes: boardRoutes },
  { ...usageManifest, routes: usageRoutes },
  { ...summariesManifest, routes: summariesRoutes },
];

/** The routes of the enabled features, built once per app so app.ts can mount each group where it belongs. */
export function featureRoutes(modules: ReadonlySet<string>, ctx: FeatureContext): FeatureRoute[] {
  return FEATURES.filter((f) => modules.has(f.name)).flatMap((f) => f.routes(ctx));
}

export function mountAt(app: express.Express, routes: FeatureRoute[], point: MountPoint): void {
  for (const r of routes) {
    if ((r.mount ?? 'session') === point) app.use(r.path, r.router);
  }
}
