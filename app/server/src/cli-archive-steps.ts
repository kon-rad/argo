import { backfillObservatory, observatoryCoverage } from './archive/observatoryProjection.js';
import { replayResults } from './archive/replayResults.js';
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
  if (has('--observatory')) {
    log(JSON.stringify(has('--apply') ? { changed: await backfillObservatory(has('--batch') ? batch : 100), coverage: await observatoryCoverage() } : await observatoryCoverage()));
  }
  else if (has('--results')) {
    const value = (flag: string) => {
      if (!has(flag)) return undefined;
      const v = argv[argv.indexOf(flag) + 1];
      if (!v || v.startsWith('--')) throw new Error(`missing value for ${flag}`);
      return v;
    };
    const runtime = value('--runtime');
    if (runtime !== 'codex' && runtime !== 'hermes') throw new Error('--runtime codex|hermes required');
    if (has('--apply') === has('--dry-run')) throw new Error('choose --dry-run or --apply');
    log(JSON.stringify(await replayResults({ runtime, dryRun: has('--dry-run'), batch,
      sessionId: has('--session') ? Number(value('--session')) : undefined,
      seq: has('--seq') ? Number(value('--seq')) : undefined, from: value('--from'), to: value('--to') })));
  }
  else if (has('--redact')) log(JSON.stringify(await redactExisting({ batch, dryRun: has('--dry-run'), log })));
  else if (has('--relabel')) log(JSON.stringify(await relabelChannels({ batch, log })));
  else log(JSON.stringify(await backfillSteps({ batch, log })));
  code = 0;
} catch (err) {
  log(`archive-steps failed: ${(err as Error).message}`);
} finally {
  await pool.end();
}
await exitFlushed(code);
