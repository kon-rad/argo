import { exitFlushed } from './cli-exit.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { config } from './config.js';
import { pool } from './db.js';
import { pullDroplet, snapshotSqlite, uploadOutbox } from './archive/collect.js';
import { defaultPaths, runArchive } from './archive/run.js';

const args = new Set(process.argv.slice(2));
const logFile = join(homedir(), 'Library', 'Logs', 'secondbrain-archive.log');
const log = (msg: string) => {
  const line = `${new Date().toISOString()} ${msg}`;
  console.error(line);
  // Under launchd stderr is already redirected into logFile (bin/secondbrain-archive.sh); only interactive runs append.
  if (process.stderr.isTTY) {
    try { mkdirSync(dirname(logFile), { recursive: true }); appendFileSync(logFile, line + '\n'); } catch { /* log dir optional */ }
  }
};

let code = 1;
try {
  const summary = await runArchive({
    paths: defaultPaths(config.vaultRoot, homedir()),
    now: () => new Date(), log, snapshotSqlite,
    pullDroplet: (dest) => pullDroplet(dest, config.archiveSshHost!),
    upload: uploadOutbox,
    // No ARCHIVE_SSH_HOST: there is no server to pull Hermes from.
  }, { dryRun: args.has('--dry-run'), upload: !args.has('--no-upload'), droplet: Boolean(config.archiveSshHost) && !args.has('--no-droplet') });
  if (summary) log(JSON.stringify(summary));
  code = summary && (summary.errors.length > 0 || summary.uploadError) ? 2 : 0;
} catch (err) {
  log(`archive run failed: ${(err as Error).message}`);
} finally {
  await pool.end();
}
await exitFlushed(code);
