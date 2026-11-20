import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
  mkdirSync(join(dir, '.claude', 'projects'), { recursive: true });
  mkdirSync(join(dir, '.hermes'));
  const ledger = new Ledger(join(dir, 'ledger.db'));
  const received: unknown[] = [];
  const fetcher = vi.fn(async (_url, opts) => { received.push(JSON.parse(opts.body)); return new Response('{}'); });
  vi.stubGlobal('fetch', fetcher);
  try {
    await reportLedgerHealth(ledger, { ...defaultConfig(dir), server: 'https://brain.example.com', token: 'synthetic' }, 'fixture-1', new Date().toISOString(), false, () => {});
    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({ outcome: 'ok', backlog: 0, backlogUnit: 'records', observedAt: null, importedAt: null, attemptSeq: 1 });
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

it('measures source time and pending units without receipt/mtime freshness on replay', async () => {
  const { measureJsonl } = await import('../src/usage/sourceHealth.js');
  const dir = mkdtempSync(join(tmpdir(), 'source-health-'));
  const path = join(dir, 'session.jsonl');
  const first = JSON.stringify({ timestamp: '2020-01-01T00:00:00Z' }) + '\n';
  const second = JSON.stringify({ timestamp: '2020-01-02T00:00:00Z' }) + '\n';
  writeFileSync(path, first + second + 'bad\n');
  expect(measureJsonl(path, Buffer.byteLength(first))).toMatchObject({
    observedAt: '2020-01-02T00:00:00.000Z', importedAt: '2020-01-01T00:00:00.000Z',
    oldestPendingAt: '2020-01-02T00:00:00.000Z', backlog: Buffer.byteLength(second + 'bad\n'), backlogUnit: 'bytes', rejected: 1,
  });
  const done = measureJsonl(path, Buffer.byteLength(first + second + 'bad\n'));
  writeFileSync(path, first + second + 'bad\n');
  expect(measureJsonl(path, Buffer.byteLength(first + second + 'bad\n'))).toEqual(done);
  expect(done).toMatchObject({ backlog: 0, oldestPendingAt: null, importedAt: '2020-01-02T00:00:00.000Z' });
});

it('ledger measures pending and quarantined records per path without changing source sequence on replay', () => {
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), 'ledger-health-')), 'ledger.db'));
  try {
    ledger.put('message', 'one', { text: 'first' }, { path: '/synthetic/one', ts: '2020-01-01T00:00:00.000Z' });
    ledger.setMeta('acked_seq', 1);
    ledger.put('message', 'two', { text: 'second' }, { path: '/synthetic/two', ts: '2020-01-02T00:00:00.000Z' });
    expect(ledger.health('/synthetic/one')).toMatchObject({ backlog: 0, importedAt: '2020-01-01T00:00:00.000Z' });
    expect(ledger.health('/synthetic/two')).toMatchObject({ backlog: 1, oldestPendingAt: '2020-01-02T00:00:00.000Z', importedAt: null });
    ledger.quarantine(ledger.pending(1, 1000)[0]!, 'invalid-item');
    ledger.setMeta('acked_seq', 2);
    expect(ledger.health('/synthetic/two')).toMatchObject({ backlog: 0, quarantined: 1, rejected: 1, importedAt: null });
    const seq = ledger.headSeq;
    expect(ledger.put('message', 'two', { text: 'second' }, { path: '/synthetic/two' })).toBe(false);
    expect(ledger.headSeq).toBe(seq);
  } finally { ledger.close(); }
});

it('supervision interrupts a synchronous parser and removes private snapshots after deadline', async () => {
  const { supervise } = await import('../src/usage/supervise.js');
  const path = join(mkdtempSync(join(tmpdir(), 'supervisor-')), 'scratch-path');
  const start = Date.now();
  const result = await supervise(process.execPath, ['-e', `
    const fs=require('node:fs'),os=require('node:os'),p=require('node:path');
    fs.writeFileSync(${JSON.stringify(path)},os.tmpdir());
    fs.writeFileSync(p.join(os.tmpdir(),'snapshot.db'),'synthetic private data');
    while(true) JSON.parse('123');
  `], 200);
  const { readFileSync } = await import('node:fs');
  expect(result).toEqual({ code: 1, reason: 'deadline' });
  expect(existsSync(readFileSync(path, 'utf8'))).toBe(false);
  console.info(`fixture synchronous-worker deadline=200ms elapsed=${Date.now() - start}ms`);
  expect(Date.now() - start).toBeLessThan(2000);
});


it('a killed synchronous SQLite importer rolls back its unfinished cursor and accepts a retry', async () => {
  const { supervise } = await import('../src/usage/supervise.js');
  const { DatabaseSync } = await import('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'worker-rollback-'));
  const path = join(dir, 'state.db');
  const init = new DatabaseSync(path);
  init.exec('CREATE TABLE cursor (offset INTEGER); INSERT INTO cursor VALUES (0)');
  init.close();
  const result = await supervise(process.execPath, ['-e', `
    const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(${JSON.stringify(path)});
    db.exec('BEGIN IMMEDIATE; UPDATE cursor SET offset=99');while(true) {}
  `], 200);
  expect(result.reason).toBe('deadline');
  const db = new DatabaseSync(path);
  try {
    expect(db.prepare('SELECT offset FROM cursor').get()).toEqual({ offset: 0 });
    db.exec('BEGIN; UPDATE cursor SET offset=99; COMMIT');
    expect(db.prepare('SELECT offset FROM cursor').get()).toEqual({ offset: 99 });
  } finally { db.close(); }
});

it('reports queued and uncaptured Hermes source revisions, including no-change after pruning', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { collectHermes } = await import('../src/ledger/collect.js');
  const dir = mkdtempSync(join(tmpdir(), 'hermes-health-'));
  const src = join(dir, 'state.db');
  const db = new DatabaseSync(src);
  db.exec(`CREATE TABLE sessions (id TEXT, started_at REAL, ended_at REAL, input_tokens INTEGER, output_tokens INTEGER);
    CREATE TABLE messages (id INTEGER, session_id TEXT, role TEXT, content TEXT, timestamp REAL);
    INSERT INTO sessions VALUES ('fixture',1577836800,1577836801,10,2);
    INSERT INTO messages VALUES (1,'fixture','assistant','reply',1577836801);`);
  db.close();
  const ledger = new Ledger(join(dir, 'ledger.db'));
  const received: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, opts) => { received.push(JSON.parse(opts.body)); return new Response('{}'); }));
  const cfg = { ...defaultConfig(dir), claudeProjectsDir: null, hermesHomes: [{ dir, label: 'main' }], server: 'https://brain.example.com', token: 'synthetic' };
  try {
    const c = await collectHermes(ledger, cfg.hermesHomes);
    expect(c.errors).toEqual([]);
    ledger.setMeta('acked_seq', ledger.headSeq);
    const seq = ledger.headSeq;
    await reportLedgerHealth(ledger, cfg, 'fixture', new Date().toISOString(), false, () => {});
    expect(received.at(-1)).toMatchObject({ backlog: 0, observedAt: '2020-01-01T00:00:01.000Z', importedAt: '2020-01-01T00:00:01.000Z' });
    expect(ledger.prune(1)).toBe(1);
    await reportLedgerHealth(ledger, cfg, 'fixture', new Date().toISOString(), false, () => {});
    expect(received.at(-1)).toMatchObject({ backlog: 0 });
    expect(ledger.headSeq).toBe(seq);
    const writer = new DatabaseSync(src);
    writer.exec(`UPDATE messages SET content='new revision', timestamp=1577836802`);
    writer.close();
    await reportLedgerHealth(ledger, cfg, 'fixture', new Date().toISOString(), true, () => {});
    expect(received.at(-1)).toMatchObject({ backlog: 1, oldestPendingAt: '2020-01-01T00:00:02.000Z', importedAt: '2020-01-01T00:00:01.000Z' });
  } finally { vi.unstubAllGlobals(); ledger.close(); }
});

it('status reads the original v1 schema without migration and writable provenance stays rollback compatible', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const path = join(mkdtempSync(join(tmpdir(), 'v1-compat-')), 'ledger.db');
  const created = new Ledger(path);
  created.put('message', 'original', { text: 'same' }, { source: 'claude-code' });
  created.close();
  const old = new DatabaseSync(path);
  old.exec('ALTER TABLE records DROP COLUMN origin_path');
  old.close();
  const reader = new Ledger(path, { readOnly: true });
  try {
    expect(reader.headSeq).toBe(1);
    expect(reader.stats().headSeq).toBe(1);
    expect((reader.db.prepare('PRAGMA table_info(records)').all() as { name: string }[]).some(r => r.name === 'origin_path')).toBe(false);
  } finally { reader.close(); }
  const updated = new Ledger(path);
  try {
    expect(updated.put('message', 'original', { text: 'same' }, { source: 'claude-code', path: '/synthetic' })).toBe(false);
    expect(updated.headSeq).toBe(1);
    expect(updated.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
  } finally { updated.close(); }
});
