import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

/**
 * zen.json: everything a run needs that is not a secret. Secrets (API keys,
 * the hub token, the knowledge base's auth header) only ever come from the
 * environment, named here by variable. Relative paths are resolved against the
 * vault, and the vault defaults to the working directory.
 */

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ProviderModelConfig {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: ('text' | 'image')[];
}

export interface ProviderConfig {
  /** The wire protocol the endpoint speaks. */
  api: 'openai-completions' | 'anthropic-messages';
  baseUrl: string;
  name?: string;
  /** Variable that holds the key; null or absent for a keyless local server. */
  apiKeyEnv?: string | null;
  models: ProviderModelConfig[];
}

export type KanbanConfig =
  | { kind: 'none' }
  /** The engine's board (the secondbrain app's /api/board) with a board token from the environment. */
  | { kind: 'board'; url: string; tokenEnv: string; board: string }
  | { kind: 'hub'; url: string; tokenEnv: string; board: string }
  | { kind: 'cli'; command: string; board: string };

export type KnowledgeConfig = { kind: 'none' } | { kind: 'secondbrain'; url: string; headersEnv: string };

export interface Budget {
  turns: number;
  tokens: number;
  minutes: number;
}

export interface ZenConfig {
  /** `provider/model`, or a bare model id looked up across providers. */
  model: string;
  thinking: ThinkingLevel;
  workdir: string;
  vault: string;
  sessionsDir: string;
  /** Rule files read into the `rules` part of the system prompt, first that exists. */
  rules: string[];
  /** Skill folders (Agent Skills layout: `<dir>/<name>/SKILL.md`); earlier dirs win on a name clash. */
  skills: string[];
  persona: { org: string; definitions: string; memory: string };
  /** Tool sets to load: fs, shell, skills, knowledge, kanban, org, subagent. */
  tools: string[];
  budget: Budget;
  context: {
    /** Fraction of the model's context window at which older turns are compacted. */
    cap: number;
    /** User turns kept verbatim after a compaction. */
    keepTurns: number;
    /** Token caps per system-prompt part (the fetched parts `thread`, `tracker`, `github`, `recall` included). */
    parts: Record<string, number>;
    /**
     * Context fetchers a wake runs before the model sees the card, by card work type (`coding`, `research`, ...),
     * by team (`team:<slug>`) or for every card (`default`); the matching lists are united. Each name is a function
     * in fetchers.ts that reads one source (the tracker, GitHub, recall) into its own capped part. Empty by default:
     * nothing but the card enters the prompt unless the vault says so.
     */
    fetchers: Record<string, string[]>;
  };
  guard: {
    local: string | null;
    log: string | null;
    hooks: { preToolUse: string[]; stop: string[] };
  };
  fs: { roots: string[]; maxRead: number };
  shell: { timeoutS: number; maxOutput: number };
  knowledge: KnowledgeConfig;
  kanban: KanbanConfig;
  org: { command: string };
  /** The project tracker CLI (the `tracker` fetcher). */
  tracker: { command: string };
  /** GitHub's CLI (the `github` fetcher). */
  github: { command: string };
  providers: Record<string, ProviderConfig>;
}

export const DEFAULTS: ZenConfig = {
  model: 'anthropic/claude-sonnet-4-6',
  thinking: 'off',
  workdir: '.',
  vault: '.',
  sessionsDir: '.zen/sessions',
  rules: ['AGENTS.md'],
  skills: ['.agents/skills', '~/.zen/skills'],
  persona: { org: '.agents/org/org.json', definitions: '.claude/agents', memory: '.agents/org/memory' },
  tools: ['fs', 'shell', 'skills', 'knowledge', 'kanban', 'org', 'subagent'],
  budget: { turns: 40, tokens: 400_000, minutes: 30 },
  context: {
    cap: 0.6,
    keepTurns: 6,
    parts: { rules: 6000, persona: 3000, playbook: 2000, skills: 1500, task: 4000, thread: 2000, tracker: 1500, github: 1500, recall: 2000 },
    fetchers: {},
  },
  guard: { local: null, log: '~/.cache/agent-guard.log', hooks: { preToolUse: [], stop: [] } },
  fs: { roots: [], maxRead: 200_000 },
  shell: { timeoutS: 120, maxOutput: 12_000 },
  knowledge: { kind: 'none' },
  kanban: { kind: 'none' },
  org: { command: 'cli-org' },
  tracker: { command: 'cli-projects' },
  github: { command: 'gh' },
  providers: {},
};

export function expandHome(p: string): string {
  return p === '~' ? homedir() : p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : p;
}

function under(base: string, p: string): string {
  const e = expandHome(p);
  return isAbsolute(e) ? e : resolve(base, e);
}

/** Deep merge for plain objects; arrays and scalars replace. */
function merge<T>(base: T, over: unknown): T {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return (over === undefined ? base : over) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    const cur = out[k];
    out[k] = cur && typeof cur === 'object' && !Array.isArray(cur) && v && typeof v === 'object' && !Array.isArray(v) ? merge(cur, v) : v;
  }
  return out as T;
}

export interface LoadOptions {
  /** An explicit file; otherwise $ZEN_CONFIG, <workdir>/zen.json, <workdir>/.zen/zen.json, ~/.zen/zen.json. */
  path?: string;
  workdir?: string;
  /** Last word: CLI flags. */
  overrides?: Partial<ZenConfig> & { budget?: Partial<Budget> };
  env?: NodeJS.ProcessEnv;
}

export function findConfig(workdir: string, env: NodeJS.ProcessEnv, explicit?: string): string | null {
  const candidates = [explicit, env['ZEN_CONFIG'], resolve(workdir, 'zen.json'), resolve(workdir, '.zen', 'zen.json'), expandHome('~/.zen/zen.json')];
  for (const c of candidates) if (c && existsSync(expandHome(c))) return expandHome(c);
  return null;
}

export function loadConfig(opts: LoadOptions = {}): ZenConfig {
  const env = opts.env ?? process.env;
  const workdir0 = resolve(expandHome(opts.workdir ?? env['ZEN_WORKDIR'] ?? process.cwd()));
  const file = findConfig(workdir0, env, opts.path);
  let fromFile: unknown = {};
  if (file) {
    try {
      fromFile = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`zen config ${file}: ${(err as Error).message}`);
    }
  }
  let cfg = merge(DEFAULTS, fromFile);
  if (env['ZEN_MODEL']) cfg = { ...cfg, model: env['ZEN_MODEL'] };
  cfg = merge(cfg, opts.overrides ?? {});

  const workdir = opts.workdir ? workdir0 : under(workdir0, cfg.workdir);
  const vault = under(workdir, cfg.vault);
  return {
    ...cfg,
    workdir,
    vault,
    sessionsDir: under(vault, cfg.sessionsDir),
    rules: cfg.rules.map((p) => under(vault, p)),
    skills: cfg.skills.map((p) => under(vault, p)),
    persona: {
      org: under(vault, cfg.persona.org),
      definitions: under(vault, cfg.persona.definitions),
      memory: under(vault, cfg.persona.memory),
    },
    guard: { ...cfg.guard, local: cfg.guard.local ? under(vault, cfg.guard.local) : null, log: cfg.guard.log ? expandHome(cfg.guard.log) : null },
    fs: { ...cfg.fs, roots: (cfg.fs.roots.length ? cfg.fs.roots : [workdir, vault]).map((p) => under(vault, p)) },
  };
}

/** Parses `turns: 30 · tokens: 300000 · wakes: 3` (a card's `## Budget` line) into budget fields. */
export function parseBudgetLine(text: string): Partial<Budget> {
  const out: Partial<Budget> = {};
  const turns = /\bturns?\s*[:=]?\s*(\d+)/i.exec(text);
  const tokens = /\btokens?\s*[:=]?\s*(\d[\d_,]*)/i.exec(text);
  const minutes = /\bminutes?\s*[:=]?\s*(\d+)/i.exec(text);
  if (turns) out.turns = Number(turns[1]);
  if (tokens) out.tokens = Number(tokens[1]!.replace(/[_,]/g, ''));
  if (minutes) out.minutes = Number(minutes[1]);
  return out;
}
