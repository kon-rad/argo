import { exitFlushed } from './cli-exit.js';
import { pool } from './db.js';
import { buildDigest } from './summaries/digest.js';
import { runSummaries } from './summaries/run.js';

// secondbrain summarize [--since HOURS] [--limit N] [--session ID] [--force] [--dry-run]
// secondbrain summarize --digest [HOURS]   print the stand-up's markdown digest of the last HOURS (default 24) and exit
// Writes one summary per finished agent session (agent_summaries). Droplet only, after the archive run.
const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const val = (f: string): number | undefined => {
  const i = argv.indexOf(f);
  const n = i >= 0 ? Number(argv[i + 1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
};
const log = (m: string) => console.error(`${new Date().toISOString()} ${m}`);

let code = 1;
try {
  if (has('--digest')) {
    process.stdout.write(await buildDigest(val('--digest') ?? 24));
    await pool.end();
    process.exit(0);
  }
  const result = await runSummaries({
    sinceHours: val('--since'),
    limit: val('--limit'),
    sessionId: val('--session'),
    force: has('--force'),
    dryRun: has('--dry-run'),
    log,
  });
  log(JSON.stringify(result));
  // Every session failing is a problem to see in the unit's status; some failing is normal (a model down for a while).
  code = result.considered > 0 && result.failed === result.considered ? 1 : 0;
} catch (err) {
  log(`summarize failed: ${(err as Error).message}`);
} finally {
  await pool.end();
}
await exitFlushed(code);
