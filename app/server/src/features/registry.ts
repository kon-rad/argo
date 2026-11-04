/**
 * The data half of every feature, in nav order, plus the commands that live outside
 * the core manifests. Imports no server code, so the launcher, deploy.sh and the docs
 * generator can read it without a database or a config.
 * The routes join in ./index.ts, which only app.ts imports.
 */
import board from './board/manifest.js';
import org from './org/manifest.js';
import projects from './projects/manifest.js';
import summaries from './summaries/manifest.js';
import type { FeatureCli, FeatureManifest, FeatureNav } from './types.js';
import usage from './usage/manifest.js';

export const MANIFESTS: readonly FeatureManifest[] = [projects, org, board, usage, summaries];

/**
 * The commands that belong to an optional module which has no manifest yet ('social',
 * 'livestream'): they are reachable as `secondbrain <command>` and get a PATH wrapper
 * like the core features' commands, so every `cli-x` wrapper comes from one table.
 */
const STANDALONE: readonly (FeatureCli & { wrapper?: string; module: string })[] = [
  { command: 'social', entry: 'cli-social.js', summary: 'the social queue: status | list | add | publish | reauth | run', wrapper: 'cli-social', module: 'social' },
  { command: 'livestream', entry: 'cli-livestream.js', summary: 'the livestream feed: sync | list', wrapper: 'cli-livestream', module: 'livestream' },
];

export function enabledManifests(modules: ReadonlySet<string>): FeatureManifest[] {
  return MANIFESTS.filter((m) => modules.has(m.name));
}

/** The systemd unit stems deploy.sh installs for this module list. */
export function unitsFor(modules: ReadonlySet<string>): string[] {
  return enabledManifests(modules).flatMap((m) => m.timers.map((t) => t.unit));
}

/** The PATH wrappers deploy.sh installs for this module list: core features plus the standalone commands. */
export function wrappersFor(modules: ReadonlySet<string>): string[] {
  return [
    ...enabledManifests(modules).flatMap((m) => m.wrappers),
    ...STANDALONE.filter((c) => modules.has(c.module)).flatMap((c) => (c.wrapper ? [c.wrapper] : [])),
  ];
}

/** The header links the web app shows for this module list. */
export function navFor(modules: ReadonlySet<string>): FeatureNav[] {
  return enabledManifests(modules).flatMap((m) => m.nav);
}

/** The feature that owns a `secondbrain <command>` word, if any. `feature` is absent for a standalone command. */
export function cliFor(command: string): { feature?: FeatureManifest; cli: FeatureCli } | undefined {
  for (const feature of MANIFESTS) {
    const cli = feature.cli.find((c) => c.command === command);
    if (cli) return { feature, cli };
  }
  const standalone = STANDALONE.find((c) => c.command === command);
  return standalone ? { cli: standalone } : undefined;
}

/** Every command word, core first, so `secondbrain features help` lists all of them. */
export function commandsFor(): FeatureCli[] {
  return [...MANIFESTS.flatMap((m) => m.cli), ...STANDALONE];
}

/**
 * The PATH wrapper for the command a `cli-x` name belongs to. Generated from the table
 * (deploy.sh writes it, no file under deploy/bin to drift), with @APP_DIR@ left for
 * deploy.sh's render to fill. `undefined` for a wrapper no command owns.
 */
export function wrapperScript(wrapper: string): string | undefined {
  const lines = (entry: string): string =>
    [
      '#!/usr/bin/env bash',
      `# ${wrapper} on the app user's PATH (installed by deploy.sh), so an agent's \`Bash(${wrapper} *)\``,
      "# tool rule matches. Identity comes from ORG_AGENT in the caller's environment.",
      'set -eo pipefail   # no -u: the env file holds bcrypt hashes with $-sequences the shell would flag',
      'set -a; . /etc/secondbrain/env; set +a',
      `exec node --no-warnings @APP_DIR@/server/dist/${entry} "$@"`,
      '',
    ].join('\n');

  for (const m of MANIFESTS) {
    if (!m.wrappers.includes(wrapper)) continue;
    // The core wrappers are named `cli-<command>` for their feature's command.
    const cli = m.cli.find((c) => `cli-${c.command}` === wrapper) ?? m.cli[0];
    if (cli) return lines(cli.entry);
  }
  const standalone = STANDALONE.find((c) => c.wrapper === wrapper);
  return standalone ? lines(standalone.entry) : undefined;
}
