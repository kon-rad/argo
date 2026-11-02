import { exitFlushed } from './cli-exit.js';
import { pool } from './db.js';
import { backfillSteps, redactExisting, relabelChannels } from './archive/backfill.js';

// secondbrain archive-steps [--redact | --relabel] [--dry-run] [--batch N]
// Without a flag: fills the step columns of rows stored before they existed.
// With --redact: rewrites stored rows that hold a key (this machine's env values + key formats).
// With --relabel: sets the channel label (Telegram chats) on sessions stored before it existed.
const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const batchArg = argv[argv.indexOf('--batch') + 1];
const batch = has('--batch') && Number(batchArg) > 0 ? Number(batchArg) : 2000;
const log = (m: string) => console.error(`${new Date().toISOString()} ${m}`);

let code = 1;
try {
  if (has('--redact')) log(JSON.stringify(await redactExisting({ batch, dryRun: has('--dry-run'), log })));
  else if (has('--relabel')) log(JSON.stringify(await relabelChannels({ batch, log })));
  else log(JSON.stringify(await backfillSteps({ batch, log })));
  code = 0;
} catch (err) {
  log(`archive-steps failed: ${(err as Error).message}`);
} finally {
  await pool.end();
}
await exitFlushed(code);
