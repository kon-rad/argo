import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONFIG_ENV_KEYS } from '../src/config.js';
import { ALL_MANIFESTS } from '../src/features/registry.js';

/**
 * Phase 4's env-schema test (card t_3d4ce863): every `process.env` key read anywhere in
 * the app is listed, so a new stray read fails the build instead of silently inventing a
 * setting with no default and no docs. The ground truth is config.ts's zod schema; the
 * keys below are read outside it today and are the worklist phase 4 pulls into manifests
 * or deletes. Shrink this list, never grow it without a reason on the same line.
 */
const KNOWN_EXTRA: Record<string, string> = {
  SECONDBRAIN_SETTINGS: 'settings.ts: names secondbrain.json itself, read before config',
  SB_UNIT_DIR: 'plan|apply: overrides the unit install dir (tests and ops)',
  SB_ENV_FILE: 'plan|apply: overrides the env file path (tests and ops)',
  SECONDBRAIN_DB_URL: 'bin/secondbrain client mode: the master database another machine owns',
  SECONDBRAIN_TELEGRAM_DIR: 'cli-telegram: the bot config dir',
  ORG_AGENT: 'identity: the calling bot',
  ORG_VIA: 'identity: the runtime the caller runs as',
  ORG_RUN: 'org: the current wake/run id',
  ORG_DB_URL: 'org: an alternate database for the org role',
  SB_ORG_DB_URL: 'org: the org role connection string',
  ORG_ROUTING_JSON: 'org routing pilot: routing.json path override',
  ORG_BREAKER: 'org: breaker override',
  ORG_BREAKER_AS: 'org: breaker identity override',
  PROJECTS_BY: 'cli-projects: author attribution override',
  PLAN_USAGE_LOG: 'usage: one-line log target',
  USAGE_HOST: 'usage: this machine host label',
  USAGE_SYNC_HOST: 'usage: the server to push usage to',
  USAGE_SYNC_SERVER: 'usage manifest: the server to push usage to',
  USAGE_SYNC_TOKEN: 'usage manifest: token for that push',
  USAGE_PUSH_HOST: 'usage-push: the remote host',
  USAGE_PUSH_STATE: 'usage-push: the last-sent state file',
  USAGE_PUSH_MAX_BYTES: 'usage-push: batch size',
  SB_LEDGER_TOKEN: 'ledger: the ingest token',
  SB_LEDGER_DIR: 'ledger: the local ledger dir',
  CLAUDE_PROJECTS_DIR: 'archive: where Claude Code keeps its projects',
  CLAUDE_BIN: 'archive: the claude binary',
  CC_RUNS_DIR: 'usage/archive: the cc-card runs dir',
  BOT_REPOS_FILE: 'org: the bots repo map',
  HERMES_ENV_FILE: 'archive: the Hermes env file',
  REMOTE_HERMES_USER: 'archive: the server-side Hermes user',
  AGENTS_SYNC_HOST: 'agents-sync: the Hermes host to pull from',
  REDACT_ENV_FILES: 'archive-steps: env files whose keys are rewritten',
  CREDITS_KEYS_FILE: 'credits: the provider keys file',
  GEMINI_API_KEY: 'org avatars: the image provider key',
  BASE_RPC_URL: 'fund: the Base RPC override',
  B2STORE: 'b2store: the binary path override',
  LIVESTREAM_YOUTUBE: 'livestream: per-provider toggle',
  LIVESTREAM_TWITCH: 'livestream: per-provider toggle',
  LIVESTREAM_KICK: 'livestream: per-provider toggle',
  LIVESTREAM_PUBLIC_DIR: 'livestream: where public files are written',
  SUMMARIES_LOCAL_URL: 'summaries manifest: a home server local model address',
  XDG_CONFIG_HOME: 'standard: config dir resolution',
  USER: 'standard: the current Unix user',
  DESK_DOMAIN: 'desk manifest: public hiring desk domain',
  DESK_CHAIN_ID: 'desk manifest: settlement chain identifier',
  DESK_PUBLIC_ORIGIN: 'desk manifest: public hiring desk origin',
};

const here = dirname(fileURLToPath(import.meta.url));
/** The app's own source: server/src and bin (the launcher's node helpers). */
const SCAN_DIRS = [resolve(here, '..', 'src'), resolve(here, '..', '..', 'bin')];
const SOURCE_EXT = /\.(ts|mjs|js)$/;
const READ = /process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\])/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === 'dist' ? [] : sourceFiles(path);
    return SOURCE_EXT.test(entry.name) ? [path] : [];
  });
}

/** key -> the first file that reads it. */
function envReads(): Map<string, string> {
  const found = new Map<string, string>();
  for (const dir of SCAN_DIRS) {
    for (const file of sourceFiles(dir)) {
      for (const m of readFileSync(file, 'utf8').matchAll(READ)) {
        const key = m[1] ?? m[2];
        if (key && !found.has(key)) found.set(key, file);
      }
    }
  }
  return found;
}

const KNOWN = new Set<string>([...CONFIG_ENV_KEYS, ...Object.keys(KNOWN_EXTRA)]);

describe('env schema', () => {
  it('lists every process.env key read in the app (schema or documented baseline)', () => {
    const offenders = [...envReads()]
      .filter(([key]) => !KNOWN.has(key))
      .map(([key, file]) => `${key} (${file})`);
    expect(offenders).toEqual([]);
  });

  it('covers every key a feature manifest declares', () => {
    const offenders = [...new Set(ALL_MANIFESTS.flatMap((m) => m.env))].filter((key) => !KNOWN.has(key));
    expect(offenders).toEqual([]);
  });

  it('keeps the baseline honest: no entry is neither read nor declared', () => {
    const read = new Set(envReads().keys());
    const declared = new Set(ALL_MANIFESTS.flatMap((m) => m.env));
    const stale = Object.keys(KNOWN_EXTRA).filter((key) => !read.has(key) && !declared.has(key) && !CONFIG_ENV_KEYS.includes(key));
    expect(stale).toEqual([]);
  });
});
