import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { stageHostInput, executeHostInput } from '../src/hosts/artifact-worker.js';
import { commandRequest, type CommandLease } from '@secondbrain/contracts/hosts';

const digest = (data: string) => createHash('sha256').update(data).digest('hex');
const input = { id: randomUUID(), bytes: 13, sha256: digest('one two three') };
const lease: CommandLease = { attempt: randomUUID(), generation: 1, command: 'count', handler: 'word-count', input };
const server = new URL('https://board.example');

describe('file-backed word count', () => {
  it('accepts exactly one typed input, with a bounded size and an opaque object identity', () => {
    const job = { command: 'count', requestKey: 'sample', input };
    expect(commandRequest.safeParse(job).success).toBe(true);
    for (const bad of [{ ...job, text: '' }, { ...job, input: { ...input, bytes: 999999999 } },
      { ...job, input: { ...input, id: '/etc/passwd' } }]) {
      expect(commandRequest.safeParse(bad).success).toBe(false);
    }
  });

  it('verifies the bytes before launch and sends a named output bound to the attempt', async () => {
    const get = vi.fn(async () => new Response('one two three'));
    const text = await stageHostInput(server, 'scoped', lease, get);
    expect(text).toBe('one two three');
    const resultText = '{"count":3}\n';
    const output = { id: randomUUID(), bytes: Buffer.byteLength(resultText), sha256: digest(resultText) };
    const send = vi.fn(async () => Response.json(output));
    expect(await executeHostInput(server, 'scoped', lease, text, send)).toEqual({
      attempt: lease.attempt, generation: 1, outcome: 'succeeded', count: 3, output,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('refuses a changed file or excessive size and detects failed delivery', async () => {
    for (const data of ['two three one', 'one two three four']) {
      await expect(stageHostInput(server, 'scoped', lease, async () => new Response(data))).rejects.toThrow();
    }
    await expect(executeHostInput(server, 'scoped', lease, 'one two three', async () => new Response(null, { status: 503 }))).rejects.toThrow();
  });
});
