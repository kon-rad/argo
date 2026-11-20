import { runSkillsCli } from './addons/skills/cli.js';
import { SkillsService } from './addons/skills/service.js';
import { exitFlushed } from './cli-exit.js';
import { config } from './config.js';
import { pool } from './db.js';
import { settings } from './settings.js';
import { readBuildInfo } from './version.js';

// Lifecycle operations read authoritative deployment observations before removal. Offline
// package inspection and draft editing need no database. Pack/sync authorize online against
// the canonical server; recording owner policy approval requires this process's DB privileges.
const argv = process.argv.slice(2);
const usesDb = ['machines', 'show', 'matrix', 'explain', 'preview', 'propose', 'apply', 'changes', 'approve-policy'].includes(argv[0] ?? '');
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
