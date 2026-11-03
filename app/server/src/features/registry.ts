/**
 * The data half of every feature, in nav order. Imports no server code, so the launcher,
 * deploy.sh and the docs generator can read it without a database or a config.
 * The routes join in ./index.ts, which only app.ts imports.
 */
import board from './board/manifest.js';
import org from './org/manifest.js';
import projects from './projects/manifest.js';
import summaries from './summaries/manifest.js';
import type { FeatureCli, FeatureManifest, FeatureNav } from './types.js';
import usage from './usage/manifest.js';

export const MANIFESTS: readonly FeatureManifest[] = [projects, org, board, usage, summaries];

export function enabledManifests(modules: ReadonlySet<string>): FeatureManifest[] {
  return MANIFESTS.filter((m) => modules.has(m.name));
}

/** The systemd unit stems deploy.sh installs for this module list. */
export function unitsFor(modules: ReadonlySet<string>): string[] {
  return enabledManifests(modules).flatMap((m) => m.timers.map((t) => t.unit));
}

/** The PATH wrappers deploy.sh installs for this module list. */
export function wrappersFor(modules: ReadonlySet<string>): string[] {
  return enabledManifests(modules).flatMap((m) => m.wrappers);
}

/** The header links the web app shows for this module list. */
export function navFor(modules: ReadonlySet<string>): FeatureNav[] {
  return enabledManifests(modules).flatMap((m) => m.nav);
}

/** The feature that owns a `secondbrain <command>` word, if any. */
export function cliFor(command: string): { feature: FeatureManifest; cli: FeatureCli } | undefined {
  for (const feature of MANIFESTS) {
    const cli = feature.cli.find((c) => c.command === command);
    if (cli) return { feature, cli };
  }
  return undefined;
}
