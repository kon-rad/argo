/**
 * The addon routes, joined to their manifests. The mirror of features/index.ts for the non-core
 * modules: each addon that mounts anything has a `routes.ts`, and app.ts mounts the enabled ones
 * through the same featureRoutes/mountAt machinery the core features use, so "routes come from the
 * manifest" is true for addons too.
 *
 * The two addons with no routes (livestream, garden) have no entry here; they are CLI and timers only.
 */
import type { AppOptions } from '../app.js';
import type { Feature, FeatureContext, FeatureRoute } from '../features/types.js';
import agentsManifest from './agents/manifest.js';
import { routes as agentsRoutes } from './agents/routes.js';
import chatManifest from './chat/manifest.js';
import { routes as chatRoutes } from './chat/routes.js';
import fundManifest from './fund/manifest.js';
import { routes as fundRoutes } from './fund/routes.js';
import mapManifest from './map/manifest.js';
import { routes as mapRoutes } from './map/routes.js';
import mediaManifest from './media/manifest.js';
import { routes as mediaRoutes } from './media/routes.js';
import ringManifest from './ring/manifest.js';
import { routes as ringRoutes } from './ring/routes.js';
import socialManifest from './social/manifest.js';
import { routes as socialRoutes } from './social/routes.js';
import tvManifest from './tv/manifest.js';
import { routes as tvRoutes } from './tv/routes.js';
import uploadsManifest from './uploads/manifest.js';
import { routes as uploadsRoutes } from './uploads/routes.js';
import voiceManifest from './voice/manifest.js';
import { routes as voiceRoutes } from './voice/routes.js';
import deskManifest from './desk/manifest.js';
import { routes as deskRoutes } from './desk/routes.js';

export { ADDON_MANIFESTS } from './registry.js';

interface AddonFeature extends Feature {
  /** Loaded only after the addon is enabled, before the HTTP app is built. */
  boot?: (deps: { config: AppConfig; modules: ReadonlySet<string> }) => Promise<Partial<AppOptions> | void>;
  close?: () => Promise<void>;
}

type AppConfig = typeof import('../config.js').config;

/** Every addon that mounts routes, with its manifest, in config.ts's ADDON_MODULES order. */
export const ADDON_FEATURES: readonly AddonFeature[] = [
  { ...ringManifest, routes: ringRoutes },
  { ...agentsManifest, routes: agentsRoutes },
  { ...mapManifest, routes: mapRoutes },
  { ...tvManifest, routes: tvRoutes },
  { ...mediaManifest, routes: mediaRoutes },
  { ...uploadsManifest, routes: uploadsRoutes },
  { ...socialManifest, routes: socialRoutes },
  { ...fundManifest, routes: fundRoutes },
  { ...chatManifest, routes: chatRoutes },
  { ...voiceManifest, routes: voiceRoutes },
  {
    ...deskManifest,
    routes: deskRoutes,
    boot: async ({ config, modules }) => {
      const { bootDesk } = await import('./desk/boot.js');
      return { desk: await bootDesk(modules, config.desk) };
    },
  },
];

/** Boot enabled addons without importing disabled addon implementations. */
export async function bootAddons(modules: ReadonlySet<string>, config: AppConfig): Promise<Partial<AppOptions>> {
  const options: Partial<AppOptions> = {};
  for (const addon of ADDON_FEATURES) {
    if (!modules.has(addon.name) || !addon.boot) continue;
    Object.assign(options, await addon.boot({ config, modules }));
  }
  return options;
}

/** Close enabled addon resources in reverse composition order. */
export async function closeAddons(modules: ReadonlySet<string>): Promise<void> {
  for (const addon of [...ADDON_FEATURES].reverse()) {
    if (modules.has(addon.name)) await addon.close?.();
  }
}

/** The routes of the enabled addons, built once per app alongside the core features'. */
export function addonRoutes(modules: ReadonlySet<string>, ctx: FeatureContext): FeatureRoute[] {
  return ADDON_FEATURES.filter((f) => modules.has(f.name)).flatMap((f) => f.routes(ctx));
}
