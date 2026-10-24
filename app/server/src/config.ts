import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));
/** app/ regardless of whether we run from src/ (tsx) or dist/ (built). */
const appRoot = resolve(here, '..', '..');
// The engine is a submodule at <vault>/.secondbrain, so the app is <vault>/.secondbrain/app.
// A standalone checkout (no vault around it) falls back to the folder above app/.
const engineRoot = resolve(appRoot, '..');
const defaultVaultRoot = basename(engineRoot) === '.secondbrain' ? resolve(engineRoot, '..') : engineRoot;

// Secrets live in the vault-root .env — never a copy inside app/.
const vaultEnv = resolve(process.env.VAULT_ROOT ?? defaultVaultRoot, '.env');
if (existsSync(vaultEnv)) dotenv.config({ path: vaultEnv, quiet: true });

const Schema = z.object({
  VAULT_ROOT: z.string().default(defaultVaultRoot),
  DATABASE_URL: z.string().default('postgres://localhost:5432/secondbrain'),
  PORT: z.coerce.number().int().positive().default(5123),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  // Optional: the embeddings source falls back to a local Ollama provider, and
  // the rest of the app runs perfectly well with no embeddings at all.
  TOGETHER_API_KEY: z.string().optional(),
  OLLAMA_URL: z.string().default('http://127.0.0.1:11434'),
  // Chat providers (chat module, and the optional contextual-enrichment step of the
  // embedder). A provider is offered only when its key is set; see app/config/llm-presets.json.
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  // Reranker for the chat's retrieval (Cohere-compatible /rerank). Unset: reranking is off.
  RERANK_API_KEY: z.string().optional(),
  RERANK_URL: z.string().url().optional(),
  RERANK_MODEL: z.string().default('Salesforce/Llama-Rank-V1'),
  // Writes the SQL for the Database page's "ask" box, on Together with the
  // key above. Checked by a real request on 2026-09-28; Together's catalogue
  // shifts, so swap it here rather than in code when this one goes away.
  SQL_MODEL: z.string().default('deepseek-ai/DeepSeek-V4.1-Flash'),
  // `local` is the Mac: loopback is the security boundary and there is no
  // login. `server` is the internet-facing box behind Caddy: every /api route
  // needs a session, and the Mac-only routes (robot launcher, HTTP shutdown)
  // are not mounted at all.
  DEPLOYMENT: z.enum(['local', 'server']).default('local'),
  // The browser-visible origin, e.g. https://brain.example.com. Mutating requests
  // must carry it as Origin — that is the CSRF check.
  PUBLIC_ORIGIN: z.string().url().optional(),
  // Written by `secondbrain auth-setup`. Never the password or secret in any
  // other form than these two.
  AUTH_PASSWORD_HASH: z.string().optional(),
  AUTH_TOTP_SECRET: z.string().optional(),
  // `b2store serve` on loopback, for streaming the big files that live only in
  // B2 (see .hermes/scripts/b2-offload.sh). Unset on the Mac: originals are local.
  B2_SERVE_URL: z.string().url().optional(),
  // 0 = never (the Mac, where rescans are a button). The server sets 30.
  SCAN_INTERVAL_MINUTES: z.coerce.number().int().min(0).default(0),
  // Optional features, comma separated (MODULE_NAMES below). Off unless listed.
  MODULES: z.string().default(''),
  // Shown in the TOTP app and as the comment author on the Agents board.
  OWNER_NAME: z.string().trim().min(1).default('owner'),
  // org module: the name of the human agent in the org (org_agents, runtime human).
  ORG_OWNER: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).default('owner'),
  // org module: the kanban assignee for vault work, a Claude Code session on the owner's machine that no dispatcher
  // spawns. Boards that still use the old slug `m4` keep working.
  ORG_VAULT_ASSIGNEE: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).default('vault-session'),
  // org module: runs one remembered agent session may carry before the next wake starts fresh (1: never resume).
  ORG_SESSION_MAX_RUNS: z.coerce.number().int().min(1).default(3),
  // org module: re-wakes of a bot for the same card in 24 h before it is held for a person, and the first
  // wait between them in minutes (doubles each time).
  ORG_TASK_WAKE_RETRIES: z.coerce.number().int().min(0).default(2),
  ORG_TASK_WAKE_BACKOFF_MINUTES: z.coerce.number().int().min(0).default(15),
  // org module: the cheap model the reflect step calls after a bot's wake (docs/agent-memory.md): `cheap` (the local
  // Ollama first, then the default keyed chat provider), `off` (episodes only, no model call), or <provider>/<model>.
  ORG_REFLECT_MODEL: z.string().trim().min(1).default('cheap'),
  // org module: reflect model calls allowed per day across every bot; past it, wakes still record their episode.
  ORG_REFLECT_MAX_PER_DAY: z.coerce.number().int().min(0).default(200),
  // org module: the local day for "one routine per day" and the dispatcher's quiet hours (an IANA zone name).
  ORG_TZ: z.string().min(1).default('UTC'),
  // org module: the engine's dispatcher (secondbrain org-dispatch; docs/zen-runtime.md). `on` installs its timer and
  // runs bots whose roster runtime is zen-agent; `off` leaves wakeups to whatever dispatcher the install has.
  ORG_DISPATCH: z.enum(['on', 'off']).default('off'),
  ORG_DISPATCH_TICK_SECONDS: z.coerce.number().int().min(10).default(120),
  ORG_DISPATCH_PARALLEL: z.coerce.number().int().min(1).default(2),
  // Local hours with no wakes, `HH-HH` (e.g. 01-07); unset: none.
  ORG_DISPATCH_QUIET: z.string().regex(/^\d{2}-\d{2}$/).optional(),
  // Tokens all bots together may spend in one local day before the rest of the day's wakes are held; 0: no cap.
  ORG_DISPATCH_DAILY_TOKENS: z.coerce.number().int().min(0).default(0),
  // The zen-agent command the dispatcher runs (on the PATH, or an absolute path).
  ORG_ZEN_COMMAND: z.string().min(1).default('zen-agent'),
  // Where zen-agent writes its traces (zen.json sessionsDir); usage-sync reads them. Default: <vault>/.zen/sessions.
  ZEN_SESSIONS_DIR: z.string().optional(),
  // The classify step (secondbrain classify): `none` falls every decision through to the old path.
  CLASSIFY_PROVIDER: z.enum(['none', 'openrouter', 'typesafe']).default('none'),
  CLASSIFY_DAILY_TOKENS: z.coerce.number().int().min(0).default(2_000_000),
  TYPESAFE_API_KEY: z.string().optional(),
  // Vault-relative notes the nav links to; unset hides the link.
  DEV_LOG_PATH: z.string().optional(),
  DOCS_PATH: z.string().optional(),
  // Mac only: a script the "start robot" button runs. Unset: the route is not mounted.
  ROBOT_LAUNCH_SCRIPT: z.string().optional(),
  // Where `secondbrain-vault sync` writes sync.json on this machine (docs/sync.md); the header chip reads it.
  SYNC_STATE_DIR: z.string().optional(),
  // Hermes's home on this machine and, for the archive, on the server it pulls from.
  HERMES_HOME: z.string().default(resolve(homedir(), '.hermes')),
  REMOTE_HERMES_HOME: z.string().optional(),
  // ssh host (an ~/.ssh/config alias) the archive pulls the server's Hermes from. Unset: no pull.
  ARCHIVE_SSH_HOST: z.string().optional(),
  // A local copy mirrors the server's ring_* tables over ssh. Unset: "Pull from server" is off.
  RING_PULL_SSH_HOST: z.string().optional(),
  // `off` when this process is a client of another machine's master database
  // (bin/secondbrain sets it whenever it uses SECONDBRAIN_DB_URL). Only the
  // master scans, embeds and receives Ring data: a second scanner with a
  // different checkout would rewrite the index and cascade-delete embeddings,
  // and a Ring pull would replace the master's rows.
  INDEXER: z.enum(['on', 'off']).default('on'),
  RING_PULL_DB: z.string().regex(/^[a-z_][a-z0-9_]*$/).default('secondbrain'),
  // agent-hub (argo-exo/agents/agent-hub) on the droplet: the kanban board, Claude chats and the Telegram toggle.
  // Unset on the Mac, where the Agents page's live tabs say so.
  AGENT_HUB_URL: z.string().url().optional(),
  AGENT_HUB_TOKEN: z.string().min(32).optional(),
  // board module: minutes a claimed card's lease lasts without a heartbeat before the board takes it back.
  BOARD_LEASE_MINUTES: z.coerce.number().int().min(1).default(60),
  // board module, on a machine that is not the server: cli-board reaches the board over HTTPS with a token
  // minted by `cli-board token create` (door 2 of docs/board-design.md). Unset: the database connection is used.
  BOARD_URL: z.string().url().optional(),
  BOARD_TOKEN: z.string().min(20).optional(),
  // board module, while the Hermes board still runs the bots: mirror every card the engine makes into it with
  // `hermes kanban` (ORG_KANBAN_CMD names the binary). Off once the engine's record is the only one.
  BOARD_HERMES_PROJECTION: z.enum(['on', 'off']).default('off'),
  // Read-only bearer token for a kiosk's Projects panel (GET /api/feed/projects).
  // Unset = the feed route does not exist.
  PROJECTS_FEED_TOKEN: z.string().min(32).optional(),
  // A local OpenAI-compatible speech server (e.g. mlx-audio running Kokoro),
  // localhost only. Used by the voice module's Listen button; never on a server.
  TTS_URL: z.string().url().default('http://127.0.0.1:8880'),
  TTS_MODEL: z.string().default('mlx-community/Kokoro-82M-bf16'),
  // social module: LinkedIn is the first provider. App-level OAuth credentials
  // from developer.linkedin.com; one app serves every connected account.
  LINKEDIN_CLIENT_ID: z.string().optional(),
  LINKEDIN_CLIENT_SECRET: z.string().optional(),
  // Base URL the LinkedIn OAuth callback redirects to, e.g. https://brain.example.com.
  // Must exactly match a redirect URI registered on the LinkedIn app. Defaults to
  // PUBLIC_ORIGIN (server) or http://localhost:5123 (local dev).
  SOCIAL_REDIRECT_BASE_URL: z.string().url().optional(),
  // 32-byte key (64 hex chars) used to AES-256-GCM encrypt stored OAuth tokens.
  // Required only when the social module is on; generate with
  // `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
  SOCIAL_TOKEN_ENC_KEY: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
  // A personal key from Buffer (Settings > API). Relays Instagram, YouTube
  // Shorts and X through the channels connected in that Buffer account;
  // unset = no Buffer relay.
  BUFFER_API_KEY: z.string().min(1).optional(),
  // Public base URL Buffer fetches post media from (it has no upload), e.g.
  // https://brain.example.com. Must be reachable from the internet.
  // Defaults to SOCIAL_REDIRECT_BASE_URL.
  SOCIAL_MEDIA_BASE_URL: z.string().url().optional(),
  // X counts a post's length by weight; 280 on a free account, 25000 on Premium.
  SOCIAL_X_MAX_CHARS: z.coerce.number().int().positive().default(280),
});

export const MODULE_NAMES = ['ring', 'agents', 'projects', 'org', 'board', 'usage', 'map', 'tv', 'voice', 'livestream', 'media', 'social', 'fund', 'chat'] as const;
export type ModuleName = (typeof MODULE_NAMES)[number];

/** `"ring, agents"` → {'ring', 'agents'}; unknown names are ignored. */
export function parseModules(raw: string): ReadonlySet<ModuleName> {
  const wanted = raw.split(',').map((m) => m.trim());
  return new Set(MODULE_NAMES.filter((m) => wanted.includes(m)));
}

const parsed = Schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

// A server deployment without credentials would either lock everyone out or,
// worse, be tempting to "fix" by turning auth off. Refuse to boot instead.
if (parsed.data.DEPLOYMENT === 'server') {
  const missing = (['AUTH_PASSWORD_HASH', 'AUTH_TOTP_SECRET', 'PUBLIC_ORIGIN'] as const).filter(
    (k) => !parsed.data[k],
  );
  if (missing.length > 0) {
    console.error(`DEPLOYMENT=server requires ${missing.join(', ')} — run \`secondbrain auth-setup\``);
    process.exit(1);
  }
}

export const config = {
  appRoot,
  vaultRoot: resolve(parsed.data.VAULT_ROOT),
  databaseUrl: parsed.data.DATABASE_URL,
  port: parsed.data.PORT,
  logLevel: parsed.data.LOG_LEVEL,
  togetherApiKey: parsed.data.TOGETHER_API_KEY,
  ollamaUrl: parsed.data.OLLAMA_URL.replace(/\/+$/, ''),
  rerankApiKey: parsed.data.RERANK_API_KEY,
  rerankUrl: parsed.data.RERANK_URL?.replace(/\/+$/, ''),
  rerankModel: parsed.data.RERANK_MODEL,
  sqlModel: parsed.data.SQL_MODEL,
  deployment: parsed.data.DEPLOYMENT,
  publicOrigin: parsed.data.PUBLIC_ORIGIN?.replace(/\/+$/, ''),
  authPasswordHash: parsed.data.AUTH_PASSWORD_HASH,
  authTotpSecret: parsed.data.AUTH_TOTP_SECRET,
  scanIntervalMinutes: parsed.data.SCAN_INTERVAL_MINUTES,
  indexer: parsed.data.INDEXER === 'on',
  b2ServeUrl: parsed.data.B2_SERVE_URL,
  dataDir: resolve(appRoot, 'data'),
  modules: parseModules(parsed.data.MODULES),
  ownerName: parsed.data.OWNER_NAME,
  orgOwner: parsed.data.ORG_OWNER,
  orgVaultAssignee: parsed.data.ORG_VAULT_ASSIGNEE,
  orgReflectModel: parsed.data.ORG_REFLECT_MODEL,
  orgReflectMaxPerDay: parsed.data.ORG_REFLECT_MAX_PER_DAY,
  orgSessionMaxRuns: parsed.data.ORG_SESSION_MAX_RUNS,
  orgTaskWakeRetries: parsed.data.ORG_TASK_WAKE_RETRIES,
  orgTaskWakeBackoffMinutes: parsed.data.ORG_TASK_WAKE_BACKOFF_MINUTES,
  orgTz: parsed.data.ORG_TZ,
  orgDispatch: parsed.data.ORG_DISPATCH === 'on',
  orgDispatchTickSeconds: parsed.data.ORG_DISPATCH_TICK_SECONDS,
  orgDispatchParallel: parsed.data.ORG_DISPATCH_PARALLEL,
  orgDispatchQuiet: parsed.data.ORG_DISPATCH_QUIET ?? null,
  orgDispatchDailyTokens: parsed.data.ORG_DISPATCH_DAILY_TOKENS,
  orgZenCommand: parsed.data.ORG_ZEN_COMMAND,
  zenSessionsDir: parsed.data.ZEN_SESSIONS_DIR ?? resolve(parsed.data.VAULT_ROOT, '.zen', 'sessions'),
  classifyProvider: parsed.data.CLASSIFY_PROVIDER,
  classifyDailyTokens: parsed.data.CLASSIFY_DAILY_TOKENS,
  openrouterApiKey: parsed.data.OPENROUTER_API_KEY,
  typesafeApiKey: parsed.data.TYPESAFE_API_KEY,
  devLogPath: parsed.data.DEV_LOG_PATH ?? null,
  docsPath: parsed.data.DOCS_PATH ?? null,
  robotLaunchScript: parsed.data.ROBOT_LAUNCH_SCRIPT,
  syncStateDir: parsed.data.SYNC_STATE_DIR,
  hermesHome: parsed.data.HERMES_HOME,
  remoteHermesHome: parsed.data.REMOTE_HERMES_HOME ?? '~/.hermes',
  archiveSshHost: parsed.data.ARCHIVE_SSH_HOST,
  ringPullHost: parsed.data.RING_PULL_SSH_HOST,
  ringPullDb: parsed.data.RING_PULL_DB,
  agentHubUrl: parsed.data.AGENT_HUB_URL,
  agentHubToken: parsed.data.AGENT_HUB_TOKEN,
  projectsFeedToken: parsed.data.PROJECTS_FEED_TOKEN,
  boardLeaseMinutes: parsed.data.BOARD_LEASE_MINUTES,
  boardUrl: parsed.data.BOARD_URL?.replace(/\/+$/, ''),
  boardToken: parsed.data.BOARD_TOKEN,
  boardHermesProjection: parsed.data.BOARD_HERMES_PROJECTION === 'on',
  ttsUrl: parsed.data.TTS_URL.replace(/\/+$/, ''),
  ttsModel: parsed.data.TTS_MODEL,
  webDist: resolve(appRoot, 'web', 'dist'),
  linkedinClientId: parsed.data.LINKEDIN_CLIENT_ID,
  linkedinClientSecret: parsed.data.LINKEDIN_CLIENT_SECRET,
  socialRedirectBaseUrl: (parsed.data.SOCIAL_REDIRECT_BASE_URL ?? parsed.data.PUBLIC_ORIGIN ?? `http://localhost:${parsed.data.PORT}`).replace(/\/+$/, ''),
  socialMediaBaseUrl: (
    parsed.data.SOCIAL_MEDIA_BASE_URL ?? parsed.data.SOCIAL_REDIRECT_BASE_URL ?? parsed.data.PUBLIC_ORIGIN ?? `http://localhost:${parsed.data.PORT}`
  ).replace(/\/+$/, ''),
  socialTokenEncKey: parsed.data.SOCIAL_TOKEN_ENC_KEY,
  bufferApiKey: parsed.data.BUFFER_API_KEY,
  socialXMaxChars: parsed.data.SOCIAL_X_MAX_CHARS,
} as const;
