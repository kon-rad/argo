/**
 * `secondbrain plan | apply | upgrade` (proposal section 4, phase 4).
 *
 * `plan`    prints the env file and systemd units this server should have, computed
 *           from the `server` block in `secondbrain.json` and the enabled feature
 *           manifests, and how they differ from what is on disk. Writes nothing.
 * `apply`   writes the plan. Refused unless `server.generate` is true in settings.
 * `upgrade` is the same plan as a dry run unless `--yes` is passed.
 *
 * The behaviour lives in `deploy/config-commands.ts` (side-effect free, unit-tested);
 * this is only the entry that builds the real filesystem view and exits.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exitFlushed } from './cli-exit.js';
import { config } from './config.js';
import { runConfig, type ConfigIo } from './deploy/config-commands.js';
import { moduleSet } from './modules.js';
import { settings } from './settings.js';

const argv = process.argv.slice(2);
const sub = argv[0] ?? 'plan';
const yes = argv.includes('--yes');

const unitDir = config.env.SB_UNIT_DIR ?? '/etc/systemd/system';
const unitsOnly = config.env.SB_CONFIG_UNITS_ONLY === '1';
const configuredServer = settings().server;
const server = unitsOnly
  ? {
      ...configuredServer,
      generate: true,
      user: config.env.SB_APP_USER ?? configuredServer.user,
      dir: config.env.SB_APP_DIR ?? configuredServer.dir,
      vaultDir: config.env.SB_VAULT_DIR ?? configuredServer.vaultDir,
      hermesHome: config.env.SB_HERMES_HOME ?? configuredServer.hermesHome,
    }
  : configuredServer;

const io: ConfigIo = {
  server,
  modules: unitsOnly ? moduleSet(config.env.MODULES) : config.modules,
  templateDir: join(config.appRoot, 'deploy'),
  unitDir,
  envPath: config.env.SB_ENV_FILE ?? '/etc/secondbrain/env',
  values: process.env,
  read: (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  },
  write: (path, content) => writeFileSync(path, content),
  listInstalled: () => {
    try {
      return readdirSync(unitDir);
    } catch {
      return [];
    }
  },
  baseUnits: new Set((config.env.SB_CONFIG_BASE_UNITS ?? '').split(',').filter(Boolean)),
  unitsOnly,
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

await exitFlushed(runConfig(sub, yes, io));
