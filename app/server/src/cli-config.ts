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
import { settings } from './settings.js';

const argv = process.argv.slice(2);
const sub = argv[0] ?? 'plan';
const yes = argv.includes('--yes');

const unitDir = config.env.SB_UNIT_DIR ?? '/etc/systemd/system';

const io: ConfigIo = {
  server: settings().server,
  modules: config.modules,
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
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

await exitFlushed(runConfig(sub, yes, io));
