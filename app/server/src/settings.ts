import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { config } from './config.js';

/**
 * Structured, non-secret settings that don't fit one env line: which numbers
 * the brain map tracks, which folders belong to which division, the TV
 * module's shows, the livestream channels. They live in the vault, in
 * `secondbrain.json` at its root (or the file SECONDBRAIN_SETTINGS names).
 *
 * Every section is optional and defaults to "nothing configured", so a fresh
 * vault needs no file at all. A file that fails to parse is reported once on
 * stderr and ignored: a typo never takes the app down.
 */

const Collect = z.discriminatedUnion('type', [
  z.object({ type: z.literal('youtube'), handle: z.string().min(1) }),
  z.object({ type: z.literal('x'), handle: z.string().min(1) }),
  z.object({ type: z.literal('instagram'), handle: z.string().min(1) }),
  // A Safe (or any account) on Base: ETH + USDC in USD. `address`, or a vault
  // JSON file whose `safe` field holds it (empty until the Safe exists).
  z.object({ type: z.literal('base-balance'), address: z.string().optional(), addressFile: z.string().optional() }),
]);

const Metric = z.object({
  key: z.string().regex(/^[a-z0-9_.-]+$/),
  label: z.string().min(1),
  unit: z.enum(['followers', 'subscribers', 'hours', 'usd', 'count']),
  /** The goal this number moves (an id from the goals file); the map draws it next to that goal. */
  goal: z.string().optional(),
  /** Else the division it belongs to. */
  division: z.string().optional(),
  target: z.number().positive().optional(),
  /** Money is never drawn on the kiosk view. */
  money: z.boolean().default(false),
  /** Shown in the map page's headline row. */
  headline: z.boolean().default(false),
  /** Not collected yet: shows as "no data". */
  placeholder: z.boolean().default(false),
  collect: Collect.optional(),
  /** Computed: the sum of these metrics, or the livestream module's hours in 30 days. */
  sum: z.array(z.string()).optional(),
  derived: z.literal('livestream-hours-30d').optional(),
});

const Settings = z.object({
  /** Vault-relative goals file: tables of `| W1 | Goal | Measure | Due | Status |` (see projects.parseGoals). */
  goalsFile: z.string().optional(),
  /** Vault-relative note the map's mission node opens. */
  missionFile: z.string().optional(),
  map: z
    .object({
      /** Division slug -> vault folders whose notes belong to it when no project claims them. */
      divisionFolders: z.record(z.string(), z.array(z.string())).default({}),
      /** Folders and files that hang off the mission node itself. */
      missionFolders: z.array(z.string()).default([]),
    })
    .prefault({}),
  metrics: z.array(Metric).default([]),
  tv: z
    .object({
      /** Vault-relative folder of episodes, one subfolder each with an episode.md. */
      episodesDir: z.string().default('tv/episodes'),
      /** Show id (the episode's `show:`) -> the label the player shows. */
      shows: z.record(z.string(), z.string()).default({}),
    })
    .prefault({}),
  livestream: z
    .object({
      youtube: z.string().optional(),
      twitch: z.string().optional(),
      kick: z.string().optional(),
    })
    .prefault({}),
  projects: z
    .object({
      /** Vault-relative file `cli-projects render` writes the report to. */
      reportFile: z.string().default('projects.md'),
    })
    .prefault({}),
});

export type SecondBrainSettings = z.infer<typeof Settings>;
export type MetricSetting = z.infer<typeof Metric>;

export function parseSettings(raw: unknown): SecondBrainSettings {
  return Settings.parse(raw ?? {});
}

export function settingsPath(vaultRoot = config.vaultRoot): string {
  const p = process.env.SECONDBRAIN_SETTINGS;
  if (p) return isAbsolute(p) ? p : join(vaultRoot, p);
  return join(vaultRoot, 'secondbrain.json');
}

let cached: { path: string; value: SecondBrainSettings } | null = null;

/** The vault's settings, read once per process (tests reset with `resetSettings`). */
export function settings(vaultRoot = config.vaultRoot): SecondBrainSettings {
  const path = settingsPath(vaultRoot);
  if (cached?.path === path) return cached.value;
  let value = parseSettings({});
  try {
    value = parseSettings(JSON.parse(readFileSync(path, 'utf8')));
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') console.error(`secondbrain.json ignored (${path}): ${e.message.split('\n')[0]}`);
  }
  cached = { path, value };
  return value;
}

export function resetSettings(): void {
  cached = null;
}
