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

/**
 * Social accounts the metrics timer reads through official APIs (docs/social-metrics.md).
 * Every list is empty by default: nothing is collected until the owner names their accounts.
 * `key` is the metric_samples prefix (`<key>.followers`); it defaults from the handle, so a
 * corrected handle gets a new key and the old account's history is left as it was.
 */
const MetricKeyPrefix = z.string().regex(/^[a-z0-9_.-]+$/);
const SocialAccountBase = {
  key: MetricKeyPrefix.optional(),
  label: z.string().min(1).optional(),
  /** Hours after which a reading counts as stale in reports and totals; default `socialMetrics.staleHours`. */
  staleHours: z.number().positive().optional(),
};
const SocialMetrics = z
  .object({
    /** A reading older than this many hours is stale: reports flag it and leave it out of totals. */
    staleHours: z.number().positive().default(36),
    /** Per-post numbers are collected for posts published in the last this many days. */
    postDays: z.number().int().positive().default(90),
    /** Upper bound on posts read per account per run. */
    maxPosts: z.number().int().positive().default(500),
    /** Graph API version for Instagram calls. */
    instagramApiVersion: z.string().regex(/^v\d+\.\d+$/).default('v23.0'),
    /** YouTube Data API v3 (YOUTUBE_API_KEY): channel subscribers, views, video count, and per-video stats. */
    youtube: z
      .array(z.object({ ...SocialAccountBase, channelId: z.string().regex(/^UC[A-Za-z0-9_-]{22}$/), posts: z.boolean().default(true) }))
      .default([]),
    /** Instagram API with Instagram Login (a Professional account): followers and per-post insights. */
    instagram: z
      .array(
        z.object({
          ...SocialAccountBase,
          /** The account's username; checked against the token's account before anything is written. */
          username: z.string().regex(/^[A-Za-z0-9_.]{1,30}$/),
          /** Defaults to Instagram Login; Unified credentials use a different endpoint and never legacy refresh. */
          login: z.enum(['instagram', 'unified']).default('instagram'),
          /** Intended Instagram Professional account ID, required to connect Unified Login. */
          assetId: z.string().regex(/^[0-9]+$/).optional(),
          /** Legacy Instagram Login env token, used only to seed its encrypted store. */
          tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
          posts: z.boolean().default(true),
        }),
      )
      .default([]),
    /** X through fxtwitter (public, no key): followers, and per-post numbers for known post ids only. */
    x: z
      .array(
        z.object({
          ...SocialAccountBase,
          handle: z.string().regex(/^[A-Za-z0-9_]{1,15}$/),
          followers: z.boolean().default(true),
          posts: z.boolean().default(true),
          /** Vault-relative text file of post ids or URLs, one per line (`#` comments), for posts not published by the social module. */
          postIdsFile: z.string().min(1).optional(),
        }),
      )
      .default([]),
    /** LinkedIn has no self-service analytics API: these accounts take manual entries only (`metrics social linkedin`). */
    linkedin: z
      .array(z.object({ ...SocialAccountBase, account: z.string().regex(/^[a-z0-9_.-]+$/) }))
      .default([]),
  })
  .prefault({});

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
    /** `provider/model` for the classifier when a schema does not pin one. Unset: every call falls through (`no-model`). */
    model: z.string().min(1).optional(),
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
        /** Vault-relative page `cli-org route report --write` (the weekly timer) writes. */
        reportFile: z.string().min(1).default('routing-report.md'),
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
    /**
     * The model that stands in when the run's model is served by a connected computer (OLLAMA_MACHINES) that does not
     * answer, or when a run on that computer ends with a provider error (docs/org-routing.md, "Fallback model").
     * Unset: no fallback, the wake fails as before.
     */
    fallback: z
      .object({
        /** `provider/model` zen-agent can call with a key from the environment, e.g. `together/deepseek-ai/DeepSeek-V4.1-Flash`. */
        model: z.string().min(1),
        thinking: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
        /** Re-run once on the fallback when a run on the machine fails with a provider error (connection, 5xx, model not in the catalogue). */
        retryOnError: z.boolean().default(true),
      })
      .optional(),
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

/** The memory feature (docs/memory.md): the one store of sourced claims, `memory_facts`. */
const Memory = z
  .object({
    /**
     * Vault paths a `memory recall` never returns, on top of the engine's own list (`.env`), matched as path
     * prefixes. Lets a vault keep its working files out of an agent's recall without an env var. Empty: nothing extra.
     */
    exclude: z.array(z.string().min(1)).default([]),
    /**
     * The capture loop: after a bot's wakes, one model pass reads the episode log and writes the durable lessons as
     * that bot's own facts (`memory_facts.agent`). Off by default; nothing is written until it is turned on. Every
     * part of the decision (which wakes, how often, which model, the prompt) is a knob here, so a vault can tune the
     * loop and later build a self-improvement cycle on top of it.
     */
    capture: z
      .object({
        /** Turn the loop on. Off: `secondbrain memory capture` does nothing. */
        enabled: z.boolean().default(false),
        /** `schedule`: the `secondbrain-memory-capture` timer drains the eligible episodes. `off`: never. */
        trigger: z.enum(['schedule', 'off']).default('schedule'),
        /** How often the loop may run: a tick within this many minutes of the last capture is a no-op. */
        everyMinutes: z.number().int().min(1).default(30),
        /** How many finished wakes one run reads at most (a cap on the model calls per tick). */
        maxWakesPerRun: z.number().int().min(1).max(50).default(10),
        /** A wake shorter than this many turns is skipped as too thin to teach anything. */
        minTurns: z.number().int().min(0).default(3),
        /** Which wake outcomes are worth reading. */
        outcomes: z
          .array(z.enum(['done', 'blocked', 'request_changes', 'no_report', 'error']))
          .min(1)
          .default(['done', 'blocked', 'request_changes', 'error']),
        /** Wakes older than this are left alone (a backfill is a deliberate `--all`). */
        maxAgeHours: z.number().int().min(1).default(24),
        /** Most facts one wake may produce. */
        maxFactsPerWake: z.number().int().min(1).max(20).default(3),
        /** `exact`: skip a claim the bot already holds word for word. `similar`: also skip near-duplicates (pg_trgm). */
        dedupe: z.enum(['exact', 'similar']).default('exact'),
        /** With `dedupe: similar`, a claim this close to an existing fact is skipped. */
        dedupeSimilarity: z.number().min(0).max(1).default(0.86),
        /** `agent`: the fact is the bot's own memory. `company`: it is written company-wide (no agent tag). */
        scope: z.enum(['agent', 'company']).default('agent'),
        /** Providers tried in order; default: the summaries chain (`app/config/summaries.json`). */
        chain: z.array(SummaryChainEntry).min(1).optional(),
        /** Vault path of the prompt template; unset: the engine's own `app/config/memory-capture-prompt.md`. */
        promptFile: z.string().min(1).optional(),
        /** Inline replacement for the whole template (wins over `promptFile`). */
        systemPrompt: z.string().min(1).optional(),
      })
      .prefault({}),
  })
  .prefault({});

/** One Telegram bot: which agent answers it, so a session's channel label can name the bot (channel.ts). */
const TelegramBot = z.object({
  /** Short name shown on /usage, e.g. "claude" */
  name: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  agent: z.enum(['claude-code', 'hermes', 'zen-agent']),
  /** The bot's Telegram username, without @ (informational) */
  username: z.string().optional(),
  /** Hermes: the profile whose gateway polls this bot ('main' for ~/.hermes). Unset: any profile */
  profile: z.string().optional(),
  /** zen-agent: the persona the bridge runs */
  persona: z.string().optional(),
});
const Telegram = z.object({ bots: z.array(TelegramBot).default([]) }).prefault({});

/** The org module's portraits (docs/org-yaml.md "Avatars"): where `cli-org avatar generate` writes and what every image shares. */
const OrgSettings = z
  .object({
    avatars: z
      .object({
        /** Vault-relative folder for generated portraits whose agent names no `avatar` path yet. */
        dir: z.string().min(1).default('.agents/org/avatars'),
        /** Vault-relative image sent with every prompt as the style reference (one finished portrait works best). */
        reference: z.string().min(1).optional(),
        /** Style text put in front of every agent's own prompt; unset: the engine's generic low-poly brief. */
        style: z.string().min(1).optional(),
        /** Gemini image model name. */
        model: z.string().min(1).default('gemini-3-pro-image-preview'),
      })
      .prefault({}),
  })
  .prefault({});

/**
 * The `server` block (proposal section 4): what `secondbrain plan|apply` generates the
 * env file, the systemd units and the Caddyfile from, plus the enabled feature
 * manifests. Non-secret by design - the login hash, the database URL and the API keys
 * stay in the machine's env file.
 */
const Server = z
  .object({
    /**
     * Generate `/etc/secondbrain/env`, the unit files and the Caddyfile from this block and
     * the enabled manifests. Off by default: a merge never changes a running server's units
     * on its own; the owner turns it on, then runs `secondbrain apply`.
     */
    generate: z.boolean().default(false),
    /** The domain Caddy serves, e.g. `sb.example.com`. Unset: no Caddyfile is generated. */
    host: z.string().min(1).optional(),
    /** The browser origin mutating requests must carry (PUBLIC_ORIGIN). Defaults to `https://<host>`. */
    publicOrigin: z.string().url().optional(),
    /** The Unix user that owns the vault and runs the app. */
    user: z.string().regex(/^[a-z_][a-z0-9_-]*$/).default('secondbrain'),
    /** Where the app is installed on the server (@APP_DIR@ in the unit templates). */
    dir: z.string().min(1).default('/opt/secondbrain-app'),
    /** The vault checkout on the server (VAULT_ROOT in the generated env). */
    vaultDir: z.string().min(1).default('/srv/vault'),
    /** Hermes's home for the app user, for the agents module. Default: `<user>`'s home. */
    hermesHome: z.string().min(1).optional(),
    backup: z
      .object({
        /** Local time the nightly pg_dump runs, `HH:MM`. */
        schedule: z.string().regex(/^\d{2}:\d{2}$/).default('03:30'),
        keepDaily: z.number().int().positive().default(14),
        keepWeekly: z.number().int().positive().default(8),
      })
      .prefault({}),
  })
  .prefault({});

const Settings = z.object({
  server: Server,
  /** Providers and panels shown on the Usage page. Empty provider lists do no polling. */
  usage: z.object({
    subscriptions: z.array(z.enum(['codex', 'claude-code'])).default([]),
    credits: z.array(z.enum(['openrouter', 'fal', 'gemini'])).default([]),
    sections: z.array(z.enum(['running', 'ledger', 'sessions', 'summaries']))
      .default(['running', 'ledger', 'sessions', 'summaries']),
  }).prefault({}),
  /**
   * The addons this vault turns on, e.g. `["map", "voice"]`. The core features are
   * always on and are never listed here. Read at runtime by `config.readAddonList` (which
   * parses the same key directly, because config.ts cannot import this file back);
   * declared here so the settings reference and validation see it.
   */
  addons: z.array(z.string()).default([]),
  chat: Chat,
  telegram: Telegram,
  org: OrgSettings,
  memory: Memory,
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
  socialMetrics: SocialMetrics,
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
  /** `secondbrain garden`: the nightly vault gardener (docs/garden.md). */
  garden: z
    .object({
      /** Top-level folders whose immediate subfolders are shelves. */
      roots: z.array(z.string().min(1)).default(['Projects', 'Areas', 'Research']),
      /** Where archived shelves go: `<archiveDir>/<quarter>/<projects|areas|research>/<name>`. */
      archiveDir: z.string().default('Archives'),
      /** Vault-relative file the catalog is rendered to. */
      catalogFile: z.string().default('garden/catalog.md'),
      /** Vault-relative folder for the nightly reports (`<reportDir>/<date>.md`). */
      reportDir: z.string().default('garden/reports'),
      /** File name of the shelf note that carries the shelf frontmatter. */
      shelfFile: z.string().default('README.md'),
      /** A project shelf untouched this long is archived. */
      projectArchiveAfterDays: z.number().int().positive().default(90),
      /** An area shelf untouched this long is proposed for archiving (never moved on its own). */
      areaProposeAfterDays: z.number().int().positive().default(180),
      /** Archive moves per run; the rest wait for the next night. */
      maxMoves: z.number().int().nonnegative().default(25),
      /** Folder renames per run. */
      maxRenames: z.number().int().nonnegative().default(5),
      /** Shelves never archived, proposed or renamed (vault-relative folders). */
      pinned: z.array(z.string().min(1)).default([]),
      /** When true the timer run moves files (apply mode); otherwise it only writes READMEs, the catalog and the report. */
      apply: z.boolean().default(false),
    })
    .prefault({}),
});

export type SecondBrainSettings = z.infer<typeof Settings>;
export type ServerSettings = SecondBrainSettings['server'];
export type GardenSettings = SecondBrainSettings['garden'];
export type ChatSettingsOverrides = z.infer<typeof Chat>;
export type ClassifySettings = z.infer<typeof Classify>;
export type DispatchSettings = z.infer<typeof Dispatch>;
export type MetricSetting = z.infer<typeof Metric>;
export type SocialMetricsSettings = z.infer<typeof SocialMetrics>;
export type TelegramBotSetting = z.infer<typeof TelegramBot>;

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
