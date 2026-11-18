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
