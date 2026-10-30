import { exitFlushed } from './cli-exit.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Host } from './archive/types.js';
import { config } from './config.js';
import { pool } from './db.js';
import { syncUsage } from './usage/sync.js';

// `secondbrain usage-sync`: this machine's Claude Code transcripts, cc-runs logs, plan readings and zen-agent traces -> the ledger.
// On the droplet a systemd timer runs it as hermes (deploy/secondbrain-usage-sync.*).
const home = homedir();
const host = (process.env.USAGE_SYNC_HOST ?? (process.env.DEPLOYMENT === 'server' ? 'droplet' : 'mac')) as Host;
const paths = {
  claudeProjectsDir: process.env.CLAUDE_PROJECTS_DIR ?? join(home, '.claude', 'projects'),
  runsDir: process.env.CC_RUNS_DIR ?? join(home, 'cc-runs'),
  statuslineLog: process.env.PLAN_USAGE_LOG ?? join(home, '.local', 'share', 'secondbrain', 'plan-usage.ndjson'),
  zenSessionsDir: config.zenSessionsDir,
};

let code = 1;
try {
  const c = await syncUsage(paths, host);
  console.log(`usage-sync ${host}: ${c.files} files, ${c.calls} calls, ${c.sessions} sessions, ${c.messages} messages, ` +
    `${c.runs} runs, ${c.plan} plan readings changed, ${c.attached} calls attached to runs`);
  for (const e of c.errors) console.error(`  ! ${e}`);
  code = c.errors.length ? 2 : 0;
} catch (err) {
  console.error(`usage-sync failed: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await pool.end();
}
await exitFlushed(code);
