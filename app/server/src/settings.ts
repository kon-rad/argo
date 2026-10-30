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

/** `chat.providers.<id>`: extra models for a preset provider, or another default or base URL. */
const ChatProviderOverride = z.object({
  models: z.array(z.object({ id: z.string().min(1), label: z.string().min(1).optional() })).optional(),
  default: z.string().min(1).optional(),
  baseUrl: z.string().min(1).optional(),
});

const Chat = z
  .object({
    /** Preset provider id the chat starts on (when its key is set). */
    defaultProvider: z.string().optional(),
    /** Replaces the engine's base system prompt (still editable in the app). */
    systemPrompt: z.string().min(1).optional(),
    providers: z.record(z.string(), ChatProviderOverride).default({}),
  })
  .prefault({});

/** One card tier the dispatcher may route to: a `provider/model` zen-agent knows and a thinking level. */
const Tier = z.object({
  model: z.string().min(1).optional(),
  thinking: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
});
const BudgetSetting = z.object({ turns: z.number().int().positive(), tokens: z.number().int().positive(), minutes: z.number().int().positive() });

/** The classify step (docs/zen-runtime.md, section 4.2). Nothing leaves the machine until `allow` names what may. */
const Classify = z
  .object({
    /** Channel slugs and vault folders (prefixes) whose text may be sent to the classifier. Empty: every call falls through. */
    allow: z.array(z.string().min(1)).default([]),
    /** `provider/model` for the classifier when a schema does not pin one. */
    model: z.string().min(1).default('openrouter/typesafe/jev-1.14'),
    /** Vault-relative folder of decision schemas (`<decision>.yaml`); the engine's defaults fill in what is missing. */
    schemasDir: z.string().default('.agents/classify'),
  })
  .prefault({});

/** The engine's dispatcher (docs/zen-runtime.md, sections 5 and 8). Every default is zen-agent's own. */
const Dispatch = z
  .object({
    /** Card tiers the card-tier decision maps to. Unset tiers use zen.json's model. */
    tiers: z.partialRecord(z.enum(['flash-low', 'flash-high', 'mid', 'strong']), Tier).default({}),
    /** Budgets by wake reason: dm, mention, handoff, task, routine, owner. */
    budgets: z.record(z.string(), BudgetSetting).default({}),
    /** zen-agent tool sets by wake reason (fs, shell, skills, knowledge, kanban, org, subagent). */
    tools: z.record(z.string(), z.array(z.string().min(1))).default({}),
    /** Model routing (docs/org-routing.md). `shadow` logs what the router would pick and changes nothing; `on` applies it. */
    routing: z
      .object({
        mode: z.enum(['off', 'shadow', 'on']).default('off'),
        /** Vault-relative routing.json written by `compile.py routing`. */
        config: z.string().default('.agents/org/routing.json'),
        /** Highest tier a card may climb to by escalation; unset: the bot's own model tier (no climbing). */
        maxTier: z.enum(['t0', 't1', 't2', 't3']).optional(),
        /** Card signals: `rules` only, or `model` to let a t0 model (OpenAI-compatible endpoint) make spec clarity stricter. */
        classifier: z
          .object({
            mode: z.enum(['rules', 'model']).default('rules'),
            model: z.string().min(1).optional(),
            /** The server root or its /v1, e.g. a local Ollama; /v1/chat/completions is appended. */
            baseUrl: z.string().min(1).optional(),
            timeoutMs: z.number().int().positive().default(10_000),
          })
          .prefault({}),
      })
      .prefault({}),
  })
  .prefault({});

/** One provider to try, in order, when the summarizer needs a model (docs/summaries.md). */
const SummaryChainEntry = z.object({
  /** A preset provider id from llm-presets.json: ollama, together, openrouter, anthropic, openai. */
  provider: z.string().min(1),
  model: z.string().min(1),
  /** Overrides the preset's base URL; `baseUrlEnv` names an environment variable that holds one (a home server's address). */
  baseUrl: z.string().min(1).optional(),
  baseUrlEnv: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
  body: z.record(z.string(), z.unknown()).optional(),
});

/** The summarizer (`secondbrain summarize`). Every field defaults from `app/config/summaries.json`. */
const Summaries = z
  .object({
    /** Providers tried in order; the first that answers writes the summary. */
    chain: z.array(SummaryChainEntry).min(1).optional(),
    /** Sessions with fewer prompt+response steps than this are recorded as skipped. */
    minSteps: z.number().int().min(1).optional(),
    /** A session is finished once nothing was added for this many minutes. */
    quietMinutes: z.number().int().min(1).optional(),
    /** Characters of compacted transcript sent to the model. */
    maxInputChars: z.number().int().min(2000).optional(),
  })
  .prefault({});

const Settings = z.object({
  chat: Chat,
  summaries: Summaries,
  classify: Classify,
  dispatch: Dispatch,
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
  fund: z
    .object({
      /** Vault-relative folder the fund keeps its state in (`state/config.json`, proposals, meetings, runs). */
      dir: z.string().default('fund'),
      /** Safe Transaction Service for the fund's chain: lists the Safe's incoming and outgoing transfers. */
      txService: z.string().url().default('https://api.safe.global/tx-service/base'),
      /** Block explorer the page links hashes and addresses to. */
      explorer: z.string().url().default('https://basescan.org'),
    })
    .prefault({}),
  uploads: z
    .object({
      /** Folders the Uploads page offers, so "my vlog" lands in the right vault folder. `keywords` match the filename and description. */
      destinations: z
        .array(
          z.object({
            label: z.string().min(1),
            path: z.string().min(1),
            keywords: z.array(z.string().min(1)).default([]),
          }),
        )
        .default([]),
      /** Where the editing machine's puller puts working copies, relative to the editing machine user's home. */
      m1Dir: z.string().default('Movies/inbox'),
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
export type ChatSettingsOverrides = z.infer<typeof Chat>;
export type ClassifySettings = z.infer<typeof Classify>;
export type DispatchSettings = z.infer<typeof Dispatch>;
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
