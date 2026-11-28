import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactRef, type CommandLease, type CommandResult } from '@secondbrain/contracts/hosts';

function transferUrl(origin: URL, lease: CommandLease, direction: 'input' | 'output') {
  return new URL(`/api/host-pilot/transfers/${encodeURIComponent(lease.attempt)}/${lease.generation}/${direction}`, origin);
}

export async function stageHostInput(origin: URL, token: string, lease: CommandLease, send: typeof fetch): Promise<string> {
  if (!lease.input) return lease.text!;
  const ref = lease.input;
  const response = await send(transferUrl(origin, lease, 'input'), {
    headers: { authorization: 'Bearer ' + token }, redirect: 'error', signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error('Input unavailable');
  }
  const folder = await mkdtemp(join(tmpdir(), 'host-command-'));
  const path = join(folder, 'input');
  try {
    const file = await open(path, 'wx', 0o600);
    const reader = response.body.getReader();
    try {
      const hash = createHash('sha256');
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > ref.bytes) throw new Error('Input size mismatch');
        hash.update(value);
        await file.writeFile(value);
      }
      if (bytes !== ref.bytes || hash.digest('hex') !== ref.sha256) throw new Error('Input verification failed');
    } finally {
      await reader.cancel().catch(() => {});
      await file.close();
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path));
  } finally { await rm(folder, { recursive: true, force: true }); }
}

export async function executeHostInput(origin: URL, token: string, lease: CommandLease, text: string, send: typeof fetch): Promise<CommandResult> {
  const count = text.match(/\S+/gu)?.length ?? 0;
  const result = { attempt: lease.attempt, generation: lease.generation, outcome: 'succeeded' as const, count };
  if (!lease.input) return result;
  const body = JSON.stringify({ count }) + '\n';
  const digest = createHash('sha256').update(body).digest('hex');
  const response = await send(transferUrl(origin, lease, 'output'), {
    method: 'PUT', body, redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/octet-stream', 'x-content-sha256': digest },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Output upload failed');
  }
  const output = artifactRef.parse(await response.json());
  if (output.bytes !== Buffer.byteLength(body) || output.sha256 !== digest) throw new Error('Output verification failed');
  return { ...result, output };
}
