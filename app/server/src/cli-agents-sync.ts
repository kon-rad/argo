import { homedir } from 'node:os';
import { join } from 'node:path';
import { syncAgents } from './agents/sync.js';
import type { Host } from './archive/types.js';
import { pool } from './db.js';

// `secondbrain agents-sync`: Hermes conversations + cron jobs/runs/outputs → Postgres.
// On the droplet a systemd timer runs it as hermes (deploy/secondbrain-agents-sync.*).
const root = process.env.HERMES_HOME ?? join(homedir(), '.hermes');
const host = (process.env.AGENTS_SYNC_HOST ?? (process.env.DEPLOYMENT === 'server' ? 'droplet' : 'mac')) as Host;

let code = 1;
try {
  const c = await syncAgents(root, host);
  console.log(`agents-sync ${host} ${root}: ${c.homes} homes, ${c.sessions} sessions, ${c.messages} messages, ` +
    `${c.jobs} jobs, ${c.runs} runs, ${c.outputs} outputs changed`);
  for (const e of c.errors) console.error(`  ! ${e}`);
  code = c.errors.length ? 2 : 0;
} catch (err) {
  console.error(`agents-sync failed: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await pool.end();
}
process.exit(code);
