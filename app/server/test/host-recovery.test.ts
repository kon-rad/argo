import { spawnSync } from 'node:child_process';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { runHostCommandOnce } from '../src/hosts/worker.js';
import { ReceiptJournal } from '../src/hosts/receiptJournal.js';

it('resends the saved result from a new journal after an acknowledged effect loses its response', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'host-receipt-'));
  const origin = 'https://unit.example';
  const lease = { attempt: 'a', generation: 1, command: 'c', handler: 'word-count', text: 'one two three' };
  const actions: string[] = [];
  const receipts: unknown[] = [];
  let disconnected = true;
  const send: typeof fetch = async (url, init) => {
    const action = String(url).split('/').pop()!;
    actions.push(action);
    if (action === 'poll') return Response.json({ lease });
    if (action === 'finish') {
      receipts.push(JSON.parse(String(init?.body)));
      if (disconnected) throw Error('lost response');
    }
    return new Response(null, { status: 204 });
  };
  try {
    const effects = join(dir, 'publisher.log');
    const execute = async () => {
      await appendFile(effects, 'published\n');
      return { attempt: 'a', generation: 1, outcome: 'succeeded' as const, count: 3 };
    };
    const first = new ReceiptJournal(dir);
    try { await expect(runHostCommandOnce(origin, 'test', send, { journal: first, execute })).rejects.toThrow('confirm finish'); }
    finally { first.close(); }
    disconnected = false;
    const reopened = new ReceiptJournal(dir);
    try {
      expect(await runHostCommandOnce(origin, 'test', send, { journal: reopened, execute })).toBe(true);
      expect(actions.filter(a => a === 'poll')).toHaveLength(1);
      expect(actions.filter(a => a === 'start')).toHaveLength(1);
      expect(receipts.at(-1)).toEqual({ attempt: 'a', generation: 1, outcome: 'succeeded', count: 3 });
      expect(new Set(receipts.map(r => JSON.stringify(r))).size).toBe(1);
      expect(reopened.pending()).toBeNull();
      expect(await readFile(effects, 'utf8')).toBe('published\n');
    } finally { reopened.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('marks an interrupted execution unknown and never starts or executes it again', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'host-uncertain-'));
  try {
    const initial = new ReceiptJournal(dir);
    initial.begin({ attempt: 'ambiguous', generation: 1 });
    initial.close();
    const restarted = new ReceiptJournal(dir);
    try {
      const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
      await runHostCommandOnce('https://unit.example', 'test', send, { journal: restarted });
      expect(send).toHaveBeenCalledTimes(1);
      expect(String(send.mock.calls[0]![0])).toMatch(/\/finish$/);
      expect(JSON.parse(String(send.mock.calls[0]![1]?.body))).toMatchObject({ outcome: 'unknown', attempt: 'ambiguous' });
    } finally { restarted.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('persists uncertainty when a handler exceeds its deadline after an effect', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'host-timeout-'));
  const journal = new ReceiptJournal(dir);
  let time = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => time);
  const deadline = new Date(time + 60_000).toISOString();
  const lease = { attempt: 'limited', generation: 1, command: 'c', handler: 'word-count', text: '', deadline };
  const send = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ lease }))
    .mockResolvedValueOnce(new Response(null, { status: 204 })).mockResolvedValueOnce(new Response(null, { status: 204 }));
  const exec = vi.fn(async () => {
    time += 65_000;
    return { attempt: 'limited', generation: 1, outcome: 'succeeded' as const, count: 1 };
  });
  try {
    await runHostCommandOnce('https://unit.example', 'test', send, { journal, execute: exec, transportTimeoutMs: 90 });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(send.mock.calls.at(-1)![1]?.body))).toMatchObject({ outcome: 'unknown' });
  } finally { clock.mockRestore(); journal.close(); await rm(dir, { recursive: true, force: true }); }
});

it('prevents another process from interpreting a live worker receipt as interrupted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'host-lock-'));
  const worker = new ReceiptJournal(dir);
  try { expect(() => new ReceiptJournal(dir)).toThrow(); }
  finally { worker.close(); await rm(dir, { recursive: true, force: true }); }
});

it('recovers a journal left by a process that exited immediately after publishing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'host-crash-'));
  try {
    const action = join(dir, 'published');
    const program = `
      import { appendFileSync } from 'node:fs';
      import { ReceiptJournal } from ${JSON.stringify(new URL('../src/hosts/receiptJournal.ts', import.meta.url).href)};
      import { runHostCommandOnce } from ${JSON.stringify(new URL('../src/hosts/worker.ts', import.meta.url).href)};
      const journal = new ReceiptJournal(process.argv[1]);
      const send = async (url) => String(url).endsWith('/poll') ? Response.json({ lease: {
        attempt: 'publish-once', generation: 1, command: 'counter', handler: 'word-count', text: 'fixture'
      } }) : new Response(null, { status: 204 });
      await runHostCommandOnce('https://unit.example','test',send,{ journal, execute: async () => {
        appendFileSync(process.argv[2], '1'); process.exit(73);
      } });
    `;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', program, dir, action],
      { timeout: 10_000, env: { PATH: process.env.PATH } });
    expect(child.status, child.stderr.toString()).toBe(73);
    const reopened = new ReceiptJournal(dir);
    try {
      const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
      const execute = vi.fn();
      await runHostCommandOnce('https://unit.example', 'test', send, { journal: reopened, execute });
      expect(execute).not.toHaveBeenCalled();
      expect(JSON.parse(String(send.mock.calls[0]![1]?.body))).toMatchObject({ attempt: 'publish-once', outcome: 'unknown' });
      expect(await readFile(action, 'utf8')).toBe('1');
    } finally { reopened.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
