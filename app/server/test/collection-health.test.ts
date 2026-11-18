import request from 'supertest';
import { beforeEach, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { query } from '../src/db.js';
import { addDevice } from '../src/ingest/devices.js';
import { recordHealth } from '../src/usage/health.js';
import { importLines } from '../src/usage/importer.js';
import { acceptedUpload } from '../src/usage/upload.js';
import { truncateAll } from './helpers.js';

beforeEach(truncateAll);
const health = (seq = 1) => ({ v: 1, collectorInstance: 'fixture', runtime: 'codex', path: '/synthetic/sessions', attemptSeq: seq,
  collectorVersion: 'fixture-2', startedAt: new Date(Date.now() - 1000).toISOString(), endedAt: new Date().toISOString(),
  outcome: 'ok', observedAt: '2020-01-01T00:00:00Z', importedAt: '2020-01-01T00:00:00Z', backlog: null,
  oldestPendingAt: null, rejected: null, quarantined: null, reason: null, capabilities: ['heartbeat'] });

it('authenticates host, refuses spoofed host and separates path freshness', async () => {
  const device = await addDevice('test-box', { display: 'Test', kind: 'laptop' });
  const app = createApp();
  await request(app).post('/api/ingest/health').send(health()).expect(401);
  await request(app).post('/api/ingest/health').auth(device.token, { type: 'bearer' }).send({ ...health(), host: 'other' }).expect(422);
  await request(app).post('/api/ingest/health').auth(device.token, { type: 'bearer' }).send(health()).expect(200);
  await recordHealth('other-box', { ...health(), path: '/synthetic/old' });
  await query(`UPDATE collection_streams SET received_at=now()-interval '1 hour' WHERE host='other-box'`);
  const response = await request(app).get('/api/usage/health').expect(200);
  expect(response.body.streams.find((x: { host: string }) => x.host === 'test-box')).toMatchObject({ state: 'healthy', backlog: null });
  expect(response.body.streams.find((x: { host: string }) => x.host === 'other-box')).toMatchObject({ state: 'offline' });
});

it('replay cannot refresh receipt, source-event time or last success', async () => {
  const h = health();
  await recordHealth('test-box', h);
  await query(`UPDATE collection_streams SET received_at='2021-01-01T00:00:00Z', last_success_at='2021-01-01T00:00:00Z'`);
  await recordHealth('test-box', h);
  let row = (await query('SELECT * FROM collection_streams')).rows[0]!;
  expect(row.received_at.toISOString()).toBe('2021-01-01T00:00:00.000Z');
  await recordHealth('test-box', { ...health(2), observedAt: '2019-01-01T00:00:00Z' });
  row = (await query('SELECT * FROM collection_streams')).rows[0]!;
  expect(row.observed_at.toISOString()).toBe('2020-01-01T00:00:00.000Z');
  expect(row.imported_at.toISOString()).toBe('2020-01-01T00:00:00.000Z');
  expect((await query('SELECT count(*)::int n FROM collection_attempts')).rows[0]!.n).toBe(2);
});

it('keeps poison wire records durably and accepts later valid records without starvation', async () => {
  const lines = ['not json', JSON.stringify({ t: 'health', health: health() })];
  const first = await importLines(lines, 'test-box', { quarantine: true });
  expect(first).toMatchObject({ accepted: [2], rejected: [1], quarantined: [1] });
  expect(acceptedUpload(0, JSON.stringify({ v: 2, ...first }), 2)).toBe(true);
  await importLines(lines, 'test-box', { quarantine: true });
  expect((await query('SELECT wire FROM usage_import_quarantine')).rows).toEqual([{ wire: 'not json' }]);
});

it('global bounded expiry removes inactive attempts while retaining streams and unaccepted quarantine', async () => {
  const { cleanupAttempts } = await import('../src/usage/health.js');
  for (let seq = 1; seq <= 3; seq++) await recordHealth('test-box', health(seq));
  await importLines(['poison'], 'test-box', { quarantine: true });
  await query(`UPDATE collection_attempts SET received_at=now()-interval '40 days'`);
  expect(await cleanupAttempts(2)).toBe(2);
  expect((await query('SELECT count(*) n FROM collection_attempts')).rows[0]!.n).toBe(1);
  expect(await cleanupAttempts(2)).toBe(1);
  expect((await query('SELECT count(*) n FROM collection_streams')).rows[0]!.n).toBe(1);
  expect((await query('SELECT count(*) n FROM usage_import_quarantine')).rows[0]!.n).toBe(1);
});

it('quarantine metadata inspection is redacted and replay deletes only a supported accepted item', async () => {
  const { listQuarantine, inspectQuarantine, replayQuarantine } = await import('../src/usage/quarantine.js');
  const poison = 'API_TOKEN=synthetic-value-long-enough not json';
  await importLines([poison], 'test-box', { quarantine: true });
  const listed = await listQuarantine('test-box');
  expect(listed).toHaveLength(1);
  const digest = listed[0]!.digest as string;
  expect(JSON.stringify(await inspectQuarantine('test-box', digest))).not.toContain('synthetic-value');
  expect((await query('SELECT wire FROM usage_import_quarantine')).rows[0]!.wire).not.toContain('synthetic-value');
  expect(await replayQuarantine('test-box', digest)).toBe(false);
  expect(await replayQuarantine('test-box', digest, JSON.stringify({ t: 'health', health: health() }))).toBe(true);
  expect(await listQuarantine('test-box')).toEqual([]);
});

it('a rejected wire cannot claim imported freshness through the trailing health item', async () => {
  const h = { ...health(), path: '/synthetic', backlog: 0, backlogUnit: 'bytes' };
  const c = await importLines([
    JSON.stringify({ t: 'unknown', path: '/synthetic/session.jsonl' }),
    JSON.stringify({ t: 'health', health: h }),
  ], 'test-box', { quarantine: true });
  expect(c).toMatchObject({ accepted: [2], rejected: [1], quarantined: [1] });
  const row = (await query(`SELECT imported_at,observed_at,outcome,reason,quarantined FROM collection_streams`)).rows[0]!;
  expect(row).toMatchObject({ imported_at: null, outcome: 'retry', reason: 'rejected', quarantined: 1 });
  expect(row.observed_at.toISOString()).toBe('2020-01-01T00:00:00.000Z');
});

it('replays quarantined calls through normal accounting without changing source identity or totals', async () => {
  const { replayQuarantine, listQuarantine } = await import('../src/usage/quarantine.js');
  const wire = JSON.stringify({ t: 'calls', calls: [{ source: 'codex', callId: 'stable-call', requestId: null,
    sessionExternalId: 'stable-session', messageExternalId: null, ts: '2020-01-01T00:00:00Z', model: 'fixture',
    entrypoint: 'cli', cwd: null, isSidechain: false, inputTokens: 80, outputTokens: 20, cacheWriteTokens: 0,
    cacheReadTokens: 0, thinkingTokens: 0, webSearchRequests: 0 }] });
  await importLines([wire], 'test-box');
  const before = (await query('SELECT call_id,input_tokens,output_tokens,ts FROM usage_calls')).rows;
  await importLines(['bad source'], 'test-box', { quarantine: true });
  const digest = String((await listQuarantine('test-box'))[0]!.digest);
  expect(await replayQuarantine('test-box', digest, wire)).toBe(true);
  expect((await query('SELECT call_id,input_tokens,output_tokens,ts FROM usage_calls')).rows).toEqual(before);
});

it('imports and retries a supported prefix above 64MiB without changing IDs or token totals', async () => {
  const { mkdtempSync, writeFileSync, rmSync, utimesSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { buildPush } = await import('../src/usage/push.js');
  const dir = mkdtempSync(join(tmpdir(), 'large-import-'));
  try {
    const path = join(dir, 'source.jsonl');
    const timestamp = '2020-01-01T00:00:00Z';
    writeFileSync(path, [
      { type: 'session_meta', timestamp, payload: { id: 'large-session', source: 'exec', model: 'fixture' } },
      { type: 'extension', timestamp, padding: 'x'.repeat(65 * 1024 * 1024) },
      { type: 'event_msg', timestamp, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 80, output_tokens: 20 } } } },
    ].map(x => JSON.stringify(x)).join('\n') + '\n');
    const input = { claudeProjectsDir: join(dir, 'missing'), codexSessionsDir: dir, planLog: null, maxBytes: 100 };
    const push = buildPush(input, { files: {} });
    expect(push.bytes).toBeGreaterThan(64 * 1024 * 1024);
    expect((await importLines(push.lines, 'test-box', { quarantine: true })).rejected).toEqual([]);
    const calls = (await query('SELECT call_id,input_tokens,output_tokens,ts FROM usage_calls')).rows;
    const sessions = (await query('SELECT id,external_id,input_tokens,output_tokens FROM archive_sessions')).rows;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ input_tokens: 80, output_tokens: 20 });
    expect((await importLines(push.lines, 'test-box', { quarantine: true })).calls).toBe(0);
    utimesSync(path, new Date(), new Date());
    expect(buildPush(input, push.next).lines).toEqual([]);
    expect((await query('SELECT call_id,input_tokens,output_tokens,ts FROM usage_calls')).rows).toEqual(calls);
    expect((await query('SELECT id,external_id,input_tokens,output_tokens FROM archive_sessions')).rows).toEqual(sessions);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 60_000);
