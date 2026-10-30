import { exitFlushed } from './cli-exit.js';
import { config } from './config.js';
import { pool } from './db.js';
import { pullRing } from './ring.js';

// `secondbrain ring-pull`: mirror the server's ring_* tables into this machine's Postgres.
let code = 1;
try {
  if (!config.ringPullHost) throw new Error('RING_PULL_SSH_HOST is not set (the ssh alias of the server to pull from)');
  const counts = await pullRing(config.ringPullHost, config.ringPullDb);
  console.log(`ring-pull from ${config.ringPullHost}: ${Object.entries(counts).map(([t, n]) => `${t} ${n}`).join(', ')}`);
  code = 0;
} catch (err) {
  console.error(`ring-pull failed: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await pool.end();
}
await exitFlushed(code);
