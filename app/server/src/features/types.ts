import type { RequestHandler, Router } from 'express';
import type { AppOptions } from '../app.js';
import type { ModuleName } from '../config.js';

/**
 * A feature manifest is the one place a feature is wired. Everything that used to be
 * spread over app.ts, App.tsx, the launcher, deploy.sh and four docs reads from it:
 * app.ts mounts `routes`, /api/meta serves `nav`, the launcher dispatches `cli`,
 * deploy.sh installs `timers` and `wrappers`, and the tests check that every file a
 * manifest names exists. Deleting a feature is deleting its folder.
 *
 * The manifest (`<name>/manifest.ts`) is pure data so a CLI or a deploy step can read
 * it without loading the server; the routes (`<name>/routes.ts`) are joined to it in
 * `features/index.ts`, which only app.ts imports.
 */

/** Where a nav link sits in the header menus. */
export type NavSection = 'Vault' | 'Work' | 'Life';

export interface FeatureNav {
  section: NavSection;
  label: string;
  path: string;
}

export interface FeatureCli {
  /** The word after `secondbrain`. */
  command: string;
  /** The compiled entry under server/dist, e.g. `cli-board.js`. */
  entry: string;
  summary: string;
}

export interface FeatureTimer {
  /** The unit stem under app/deploy: `<unit>.service` and `<unit>.timer` both exist. */
  unit: string;
  summary: string;
}

/** The data half of a feature: what every reader needs without loading its code. */
export interface FeatureManifest {
  name: ModuleName;
  /** Core features ship on by default in a fresh vault's config; addons are off until listed. */
  core: boolean;
  summary: string;
  nav: FeatureNav[];
  cli: FeatureCli[];
  timers: FeatureTimer[];
  /** PATH wrappers deploy.sh installs for the app user, so an agent's `Bash(cli-x *)` rule matches. */
  wrappers: string[];
  /** Env keys the feature reads. Each has a row in docs/configuration.md. */
  env: string[];
  /** Its block in secondbrain.json, when it has one. */
  settings?: string;
  /** The doc page, relative to the repo root; an anchor is allowed. */
  docs: string;
}

/**
 * `raw`: before the JSON body parser, for a route that parses its own (larger) body.
 * `public`: after the parser, before the login gates, for a route with its own token check.
 * `session`: behind the login (the default).
 */
export type MountPoint = 'raw' | 'public' | 'session';

export interface FeatureRoute {
  path: string;
  router: Router;
  mount?: MountPoint;
}

export interface FeatureContext {
  vaultRoot: string;
  remote: boolean;
  /** The session check, for a public route that gates some of its own paths (the board). Absent locally. */
  sessionGate?: RequestHandler;
  opts: AppOptions;
}

export type FeatureRoutes = (ctx: FeatureContext) => FeatureRoute[];

export interface Feature extends FeatureManifest {
  routes: FeatureRoutes;
}

export function defineFeature(manifest: FeatureManifest): FeatureManifest {
  return manifest;
}
