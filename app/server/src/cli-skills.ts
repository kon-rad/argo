import { runSkillsCli } from './addons/skills/cli.js';
import { SkillsService } from './addons/skills/service.js';
import { exitFlushed } from './cli-exit.js';
import { config } from './config.js';
import { pool } from './db.js';
import { settings } from './settings.js';
import { readBuildInfo } from './version.js';

// `secondbrain skills ...` (docs/skills.md). Only `machines` and the detail views touch the database;
// on a client machine without one, everything else still works from the vault checkout.
const argv = process.argv.slice(2);
const usesDb = ['machines'].includes(argv[0] ?? '');
const service = new SkillsService(config.vaultRoot, settings(config.vaultRoot).skills, { db: usesDb });
let code = 1;
try {
  const build = readBuildInfo(config.appRoot);
  code = await runSkillsCli(argv, service, {
    out: (s) => console.log(s), err: (s) => console.error(s), env: process.env, engine: build.commitShort ?? build.version,
  });
} catch (err) {
  console.error(`skills: ${(err as Error).message}`);
} finally {
  await pool.end();
}
await exitFlushed(code);
