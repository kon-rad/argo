import { setTimeout as delay } from 'node:timers/promises';
import { commandLease, type CommandLease, type CommandResult } from '@secondbrain/contracts/hosts';
import { stageHostInput, executeHostInput } from './artifact-worker.js';
import type { ReceiptJournal } from './receiptJournal.js';
import { z } from 'zod';

const pollResponse = z.strictObject({ lease: commandLease.nullable() });

type Execute = (lease: CommandLease, signal: AbortSignal) => Promise<CommandResult>;

export async function runHostCommandOnce(origin: string, token: string, send: typeof fetch = fetch,
  options: { journal?: ReceiptJournal; transportTimeoutMs?: number; execute?: Execute } = {}): Promise<boolean> {
  const server = new URL(origin);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(server.hostname);
  if (server.protocol !== 'https:' && !(server.protocol === 'http:' && local)) {
    throw new Error('Host worker requires HTTPS or loopback HTTP');
  }
  if (server.username || server.password || server.search || server.hash || server.pathname !== '/') {
    throw new Error('Expected a server origin');
  }
  if (!token.trim()) throw new Error('Host worker requires an enrollment token');

  async function post(action: 'poll' | 'start' | 'finish', body: object) {
    const url = new URL('/api/host-pilot/' + action, server);
    const serialized = JSON.stringify(body);
    // A lost poll could already have reserved a run. Only receipts/results can be replayed.
    const attempts = action === 'poll' ? 1 : 3;
    for (let i = 1; ; i++) {
      let response: Response;
      try {
        response = await send(url, {
          method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
          body: serialized, redirect: 'error', signal: AbortSignal.timeout(options.transportTimeoutMs ?? 30_000),
        });
      } catch {
        if (i === attempts) throw new Error('Host worker could not confirm ' + action);
        await delay(250 * i);
        continue;
      }
      // A 412 start response confirms prelaunch denial has already been recorded.
      if (response.ok || (action === 'start' && response.status === 412)) return response;
      await response.body?.cancel();
      if (response.status < 500 || i === attempts) throw new Error('Host worker ' + action + ' returned HTTP ' + response.status);
      await delay(250 * i);
    }
  }

  const journal = options.journal;
  const finish = async (result: CommandResult) => {
    journal?.save(result);
    await (await post('finish', result)).body?.cancel();
    journal?.acknowledge();
  };
  const pending = journal?.pending();
  if (pending) {
    await finish(pending);
    return true;
  }
  const { lease } = pollResponse.parse(await (await post('poll', journal ? { protocol: 2 } : {})).json());
  if (!lease) return false;
  const fence = { attempt: lease.attempt, generation: lease.generation };
  // This built-in handler executes in the worker process recorded by this receipt.
  journal?.begin(fence);
  const expired = () => lease.deadline !== undefined && Date.now() >= Date.parse(lease.deadline);
  if (expired()) {
    await finish({ ...fence, outcome: 'failed', reason: 'Command deadline elapsed before launch' });
    return true;
  }
  let text: string;
  try {
    text = await stageHostInput(server, token, lease, send);
  } catch {
    await finish({ ...fence, outcome: 'failed', reason: 'Input staging or verification failed' });
    return true;
  }
  const start = await post('start', { ...fence, pid: process.pid });
  await start.body?.cancel();
  if (start.status === 412) {
    journal?.acknowledge();
    return true;
  }
  if (expired()) {
    await finish({ ...fence, outcome: 'failed', reason: 'Command deadline elapsed before execution' });
    return true;
  }
  // Only code registered by the worker supplies the handler. A crash here leaves
  // the pre-execution fence on disk; recovery reports uncertainty rather than rerunning it.
  const remaining = lease.deadline ? Math.max(0, Date.parse(lease.deadline) - Date.now()) : 300_000;
  const signal = AbortSignal.timeout(Math.min(remaining, 2_147_483_647));
  let result: CommandResult;
  try {
    result = options.execute ? await options.execute(lease, signal) : await executeHostInput(server, token, lease, text, send, signal);
  } catch {
    result = { ...fence, outcome: 'unknown', reason: 'Execution or output delivery interrupted after start' };
  }
  await finish(expired() || signal.aborted
    ? { ...fence, outcome: 'unknown', reason: 'Command execution exceeded its deadline' } : result);
  return true;
}
