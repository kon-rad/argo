import { exitFlushed } from './cli-exit.js';
import { pool } from './db.js';
import { healthy, runChecks, type Check } from './doctor.js';

/**
 * secondbrain doctor (proposal phase 3): one command that says whether this
 * install is well. Node, Postgres, pgvector, pending migrations, unknown
 * modules, a stale AGENTS.md, an unparsable settings file, the sync state and
 * each core feature's tables. `--deep` adds the checks that need the deployed
 * server (failed timers, the last backup). `--json` prints the same checks the
 * /api/health route returns. Exits 1 when a critical check fails.
 */
function line(c: Check): string {
  const mark = c.skipped ? '--' : c.ok ? 'ok' : c.critical ? 'FAIL' : 'WARN';
  return `${mark.padEnd(4)} ${c.name.padEnd(16)} ${c.detail}${c.hint ? `\n     > ${c.hint}` : ''}`;
}

const argv = process.argv.slice(2);
const checks = await runChecks({ deep: argv.includes('--deep') });
const ok = healthy(checks);

if (argv.includes('--json')) {
  console.log(JSON.stringify({ ok, checks }, null, 2));
} else {
  for (const c of checks) console.log(line(c));
  const errors = checks.filter((c) => !c.ok && c.critical).length;
  const warnings = checks.filter((c) => !c.ok && !c.critical).length;
  console.log(`\n${ok ? 'healthy' : 'unhealthy'}${errors ? `, ${errors} error(s)` : ''}${warnings ? `, ${warnings} warning(s)` : ''}`);
}

await pool.end();
await exitFlushed(ok ? 0 : 1);
