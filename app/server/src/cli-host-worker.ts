import { homedir } from 'node:os';
import { readEnrollment } from './hosts/lifecycle.js';
import { setTimeout as delay } from 'node:timers/promises';
import { HostCredentialRejected, runHostCommandOnce } from './hosts/worker.js';

async function main() {
  const [server, mode, ...extra] = process.argv.slice(2);
  if (!server || (mode !== undefined && mode !== '--once') || extra.length) {
    throw new Error('Usage: cli-host-worker <server-origin> [--once]');
  }
  const enrollment = server === '--enrolled' ? readEnrollment(homedir()) : undefined;
  const origin = enrollment?.origin ?? server;
  const token = enrollment?.token ?? process.env.SECONDBRAIN_HOST_TOKEN;
  if (!token) throw new Error('Set SECONDBRAIN_HOST_TOKEN to the enrolled machine token');
  const drain = new AbortController();
  const stop = () => drain.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  if (enrollment) console.log('Polling as ' + enrollment.machine);
  try {
    while (!drain.signal.aborted) {
      const worked = await runHostCommandOnce(origin, token);
      if (mode === '--once') break;
      if (!worked && !drain.signal.aborted) {
        await delay(5000, undefined, { signal: drain.signal }).catch(error => {
          if (!drain.signal.aborted) throw error;
        });
      }
    }
  } catch (error) {
    if (!enrollment || !(error instanceof HostCredentialRejected)) throw error;
    console.error('Machine credential rejected. Worker stopped.');
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Host worker failed');
  process.exitCode = 1;
});
