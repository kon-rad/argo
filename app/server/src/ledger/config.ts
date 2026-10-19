import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { LedgerConfig } from './types.js';

/** Where the ledger lives on each OS. SB_LEDGER_DIR overrides (tests, a second ledger). */
export function dataDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (env.SB_LEDGER_DIR) return env.SB_LEDGER_DIR;
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'secondbrain');
  if (platform === 'win32') return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'secondbrain');
  return join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'secondbrain');
}

export function defaultConfig(home = homedir()): LedgerConfig {
  return {
    server: null, token: null, host: null,
    claudeProjectsDir: join(home, '.claude', 'projects'),
    claudeProvider: 'anthropic',
    hermesHomes: [{ dir: join(home, '.hermes'), label: 'main' }],
    intervalSec: 120,
    batchBytes: 8 * 1024 * 1024,
    retainDays: null,
    proxy: { enabled: false, port: 18080, upstream: 'https://api.anthropic.com' },
  };
}

export function loadConfig(dir: string): LedgerConfig {
  const file = join(dir, 'ledger.json');
  const base = defaultConfig();
  if (!existsSync(file)) return base;
  return { ...base, ...(JSON.parse(readFileSync(file, 'utf8')) as Partial<LedgerConfig>) };
}

/** Written 0600: it holds the device token. */
export function saveConfig(dir: string, cfg: LedgerConfig): string {
  const file = join(dir, 'ledger.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  try { chmodSync(file, 0o600); } catch { /* Windows: ACLs, not modes */ }
  return file;
}
