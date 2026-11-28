import { setTimeout as delay } from 'node:timers/promises';
import { commandLease, type CommandResult } from '@secondbrain/contracts/hosts';
import { z } from 'zod';

const pollResponse = z.strictObject({ lease: commandLease.nullable() });

export class HostCredentialRejected extends Error {}

export function workerOrigin(origin: string): URL {
  const server = new URL(origin);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(server.hostname);
  if (server.protocol !== 'https:' && !(server.protocol === 'http:' && local)) {
    throw new Error('Host worker requires HTTPS or loopback HTTP');
  }
  if (server.username || server.password || server.search || server.hash || server.pathname !== '/') {
    throw new Error('Expected a server origin');
  }
  return server;
}

export async function runHostCommandOnce(origin: string, token: string, send: typeof fetch = fetch): Promise<boolean> {
  const server = workerOrigin(origin);
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
          body: serialized, redirect: 'error', signal: AbortSignal.timeout(30_000),
        });
      } catch {
        if (i === attempts) throw new Error('Host worker could not confirm ' + action);
        await delay(250 * i);
        continue;
      }
      // A 412 start response confirms prelaunch denial has already been recorded.
      if (response.ok || (action === 'start' && response.status === 412)) return response;
      await response.body?.cancel();
      if (response.status === 401) throw new HostCredentialRejected('Host worker ' + action + ' returned HTTP 401');
      if (response.status < 500 || i === attempts) throw new Error('Host worker ' + action + ' returned HTTP ' + response.status);
      await delay(250 * i);
    }
  }

  const { lease } = pollResponse.parse(await (await post('poll', {})).json());
  if (!lease) return false;
  const fence = { attempt: lease.attempt, generation: lease.generation };
  // This built-in handler executes in the worker process recorded by this receipt.
  const start = await post('start', { ...fence, pid: process.pid });
  await start.body?.cancel();
  if (start.status === 412) return true;
  const result: CommandResult = {
    ...fence, outcome: 'succeeded', count: lease.text.match(/\S+/gu)?.length ?? 0,
  };
  await (await post('finish', result)).body?.cancel();
  return true;
}
