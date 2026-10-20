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
  // Vault-relative notes the nav links to; unset hides the link.
  DEV_LOG_PATH: z.string().optional(),
  DOCS_PATH: z.string().optional(),
  // Mac only: a script the "start robot" button runs. Unset: the route is not mounted.
  ROBOT_LAUNCH_SCRIPT: z.string().optional(),
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
});

export const MODULE_NAMES = ['ring', 'agents', 'projects', 'org', 'usage', 'map', 'tv', 'voice', 'livestream', 'media', 'social', 'calendar'] as const;
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
  ollamaUrl: parsed.data.OLLAMA_URL,
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
  devLogPath: parsed.data.DEV_LOG_PATH ?? null,
  docsPath: parsed.data.DOCS_PATH ?? null,
  robotLaunchScript: parsed.data.ROBOT_LAUNCH_SCRIPT,
  hermesHome: parsed.data.HERMES_HOME,
  remoteHermesHome: parsed.data.REMOTE_HERMES_HOME ?? '~/.hermes',
  archiveSshHost: parsed.data.ARCHIVE_SSH_HOST,
  ringPullHost: parsed.data.RING_PULL_SSH_HOST,
  ringPullDb: parsed.data.RING_PULL_DB,
  agentHubUrl: parsed.data.AGENT_HUB_URL,
  agentHubToken: parsed.data.AGENT_HUB_TOKEN,
  projectsFeedToken: parsed.data.PROJECTS_FEED_TOKEN,
  ttsUrl: parsed.data.TTS_URL.replace(/\/+$/, ''),
  ttsModel: parsed.data.TTS_MODEL,
  webDist: resolve(appRoot, 'web', 'dist'),
  linkedinClientId: parsed.data.LINKEDIN_CLIENT_ID,
  linkedinClientSecret: parsed.data.LINKEDIN_CLIENT_SECRET,
  socialRedirectBaseUrl: (parsed.data.SOCIAL_REDIRECT_BASE_URL ?? parsed.data.PUBLIC_ORIGIN ?? `http://localhost:${parsed.data.PORT}`).replace(/\/+$/, ''),
  socialTokenEncKey: parsed.data.SOCIAL_TOKEN_ENC_KEY,
} as const;
