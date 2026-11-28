import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ReceiptJournal } from './hosts/receiptJournal.js';
import { setTimeout as delay } from 'node:timers/promises';
import { runHostCommandOnce } from './hosts/worker.js';

async function main() {
  const [origin, mode, ...extra] = process.argv.slice(2);
  if (!origin || (mode !== undefined && mode !== '--once') || extra.length) {
    throw new Error('Usage: cli-host-worker <server-origin> [--once]');
  }
  const token = process.env.SECONDBRAIN_HOST_TOKEN;
  if (!token) throw new Error('Set SECONDBRAIN_HOST_TOKEN to the enrolled machine token');
  const binding = createHash('sha256').update(new URL(origin).origin).update('\0').update(token).digest('hex');
  const root = process.env.SECONDBRAIN_HOST_STATE_DIR ?? join(homedir(), '.secondbrain', 'host-receipts');
  const journal = new ReceiptJournal(join(root, binding));
  const drain = new AbortController();
  const stop = () => drain.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    while (!drain.signal.aborted) {
      const worked = await runHostCommandOnce(origin, token, fetch, { journal });
      if (mode === '--once') break;
      if (!worked && !drain.signal.aborted) {
        await delay(5000, undefined, { signal: drain.signal }).catch(error => {
          if (!drain.signal.aborted) throw error;
        });
      }
    }
  } finally {
    journal.close();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Host worker failed');
  process.exitCode = 1;
});
