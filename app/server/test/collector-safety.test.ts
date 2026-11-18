import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildPush } from '../src/usage/push.js';
import { streamState, healthSchema } from '../src/usage/health-wire.js';
import { reportLedgerHealth } from '../src/ledger/health.js';
import { defaultConfig } from '../src/ledger/config.js';
import { syncOnce } from '../src/ledger/sync.js';
import { vi } from 'vitest';
import { Ledger } from '../src/ledger/store.js';
import { runUpload, acceptedUpload } from '../src/usage/upload.js';

it('status opens a read-only snapshot during a collector transaction', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'collector-')), 'ledger.db');
  const writer = new Ledger(path);
  writer.put('session', 'a', {});
  writer.tx(() => {
    writer.put('session', 'b', {});
    const reader = new Ledger(path, { readOnly: true, busyTimeoutMs: 30 });
    try {
      expect(reader.headSeq).toBe(1);
      expect(() => reader.setMeta('unexpected', 'write')).toThrow();
      expect(reader.stats().headSeq).toBe(1);
    } finally { reader.close(); }
  });
  writer.close();
  const missing = join(mkdtempSync(join(tmpdir(), 'collector-')), 'missing.db');
  expect(() => new Ledger(missing, { readOnly: true })).toThrow();
  expect(existsSync(missing)).toBe(false);
});

it('never treats legacy exit 2 or a partial acknowledgement as acceptance', () => {
  expect(acceptedUpload(2, '', 2)).toBe(false);
  expect(acceptedUpload(0, '', 2)).toBe(false);
  expect(acceptedUpload(0, JSON.stringify({ v: 2, accepted: [1], rejected: [2], lines: 2 }), 2)).toBe(false);
  expect(acceptedUpload(0, JSON.stringify({ v: 2, accepted: [1, 2], rejected: [], lines: 2 }), 2)).toBe(true);
});

it('bounds stalled subprocesses and cleans up the process group', async () => {
  const at = Date.now();
  const result = await runUpload(process.execPath, ['-e', 'setInterval(()=>{},1000)'], ['hello'], 120);
  expect(result.reason).toBe('deadline');
  console.info(`fixture stalled-child deadline=120ms elapsed=${Date.now() - at}ms`);
  expect(Date.now() - at).toBeLessThan(2000);
});

it('bounds early stdin closure and disconnect without accepting anything', async () => {
  const at = Date.now();
  const result = await runUpload(process.execPath, ['-e', 'process.stdin.destroy(); process.exit(1)'], ['x'.repeat(2_000_000)], 500);
  expect(result.ok).toBe(false);
  console.info(`fixture stdin-close deadline=500ms elapsed=${Date.now() - at}ms reason=${result.reason}`);
  expect(Date.now() - at).toBeLessThan(2000);
});


it('durably quarantined rejection explicitly covers the rejected position', () => {
  expect(acceptedUpload(0, JSON.stringify({ v: 2, lines: 3, accepted: [1, 3], rejected: [2], quarantined: [2] }), 3)).toBe(true);
  expect(acceptedUpload(0, JSON.stringify({ v: 2, lines: 3, accepted: [1, 3], rejected: [2], quarantined: [1] }), 3)).toBe(false);
});

it('a fresh path cannot conceal another host or runtime overdue heartbeat', () => {
  const now = Date.now();
  expect(streamState({ received_at: new Date(now), outcome: 'ok', backlog: null }, 60, now)).toBe('healthy');
  expect(streamState({ received_at: new Date(now - 241000), outcome: 'ok', backlog: 0 }, 60, now)).toBe('offline');
  expect(streamState(undefined, 60, now)).toBe('unknown');
  expect(streamState({ received_at: new Date(now), outcome: 'ok', backlog: 3 }, 60, now)).toBe('stale');
  expect(healthSchema.safeParse({ host: 'spoof' }).success).toBe(false);
});

it('oversized complete records progress, malformed records remain recoverable, and files rotate fairly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fair-'));
  const first = join(dir, 'a.jsonl'); const second = join(dir, 'b.jsonl');
  writeFileSync(first, JSON.stringify({ text: 'x'.repeat(10000) }) + '\nnot-json\n');
  writeFileSync(second, '{}\n');
  const input = { claudeProjectsDir: dir, planLog: null, maxBytes: 100 };
  const a = buildPush(input, { files: {} });
  expect(a.bytes).toBeGreaterThan(100);
  const b = buildPush(input, a.next);
  expect(b.lines.some(x => JSON.parse(x).path === second)).toBe(true);
  const c = buildPush(input, b.next);
  expect([...b.lines, ...c.lines].some(x => JSON.parse(x).t === 'quarantine')).toBe(true);
  expect(buildPush(input, c.next).lines).toEqual([]);
});

it('SQLite busy is bounded and failed writes preserve cursors', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'busy-')), 'ledger.db');
  const a = new Ledger(path); const b = new Ledger(path, { busyTimeoutMs: 20 });
  const start = Date.now();
  a.tx(() => expect(() => b.tx(() => b.setCursor('file', 12))).toThrow());
  expect(Date.now() - start).toBeLessThan(1000);
  expect(b.cursor('file')).toBeNull();
  a.close(); b.close();
});

it('an interrupted local batch rolls back both data and cursor before recovery', () => {
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), 'recover-')), 'ledger.db'));
  expect(() => ledger.tx(() => { ledger.put('session', 'a', {}); ledger.setCursor('a', 12); throw Error('interrupted'); })).toThrow();
  expect(ledger.headSeq).toBe(0); expect(ledger.cursor('a')).toBeNull();
  ledger.tx(() => { ledger.put('session', 'a', {}); ledger.setCursor('a', 12); });
  expect(ledger.headSeq).toBe(1); expect(ledger.cursor('a')).toBe(12);
  ledger.close();
});


it('emits per-path no-change heartbeat without inventing source measurements', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heartbeat-'));
  const ledger = new Ledger(join(dir, 'ledger.db'));
  const received: unknown[] = [];
  const fetcher = vi.fn(async (_url, opts) => { received.push(JSON.parse(opts.body)); return new Response('{}'); });
  vi.stubGlobal('fetch', fetcher);
  try {
    await reportLedgerHealth(ledger, { ...defaultConfig(dir), server: 'https://brain.example.com', token: 'synthetic' }, 'fixture-1', new Date().toISOString(), false, () => {});
    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({ outcome: 'ok', backlog: null, observedAt: null, importedAt: null, attemptSeq: 1 });
    expect(ledger.headSeq).toBe(0);
  } finally { vi.unstubAllGlobals(); ledger.close(); }
});

it('explicit HTTP rejection quarantines intact local data and allows queue progress', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rejection-'));
  const ledger = new Ledger(join(dir, 'ledger.db'));
  ledger.put('message', 'poison', { text: 'retained' });
  try {
    const result = await syncOnce(ledger, { ...defaultConfig(dir), server: 'https://brain.example.com', token: 'synthetic' }, {
      fetch: async () => new Response('{}', { status: 422 }), now: () => new Date(), bundle: 'fixture',
    });
    expect(result).toMatchObject({ status: 'ok', quarantined: 1, ackedSeq: 1 });
    expect(ledger.get('message', 'poison')).toEqual({ text: 'retained' });
    expect(ledger.prune(1)).toBe(0);
  } finally { ledger.close(); }
});

it('HTTP deadline keeps acknowledgement cursor pending for recovery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'http-deadline-'));
  const ledger = new Ledger(join(dir, 'ledger.db'));
  ledger.put('session', 'pending', {});
  const start = Date.now();
  try {
    const result = await syncOnce(ledger, { ...defaultConfig(dir), server: 'https://brain.example.com', token: 'synthetic' }, {
      fetch: async (_url, opts) => new Promise((_resolve, reject) => opts!.signal!.addEventListener('abort', () => reject(new Error('timeout')))),
      now: () => new Date(), bundle: 'fixture',
    }, { maxMs: 80 });
    console.info(`fixture http-stall deadline=80ms elapsed=${Date.now() - start}ms`);
    expect(result).toMatchObject({ status: 'retry', ackedSeq: 0 });
    expect(ledger.pending(0, 1000)).toHaveLength(1);
    expect(Date.now() - start).toBeLessThan(1000);
  } finally { ledger.close(); }
});
