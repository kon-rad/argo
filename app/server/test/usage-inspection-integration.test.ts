import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import * as archive from '../src/archive/store.js';
import { runTimezone } from '../src/cli-timezone.js';
import { withTransaction } from '../src/db.js';
import { resetSettings } from '../src/settings.js';
import { parseCodex } from '../src/usage/codex.js';
import * as usage from '../src/usage/store.js';
import { ALL_MODULES, truncateAll } from './helpers.js';

const at = '2026-11-10T07:13:00Z';
const range = { from: '2026-11-10T00:00:00Z', to: '2026-11-11T00:00:00Z' };
let directory: string;
let settingsFile: string;
let priorSettings: string | undefined;
beforeEach(async () => {
  await truncateAll();
  directory = mkdtempSync(join(tmpdir(), 'usage-integration-'));
  settingsFile = join(directory, 'secondbrain.json');
  writeFileSync(settingsFile, JSON.stringify({ usage: { credits: ['fal'] } }));
  priorSettings = process.env.SECONDBRAIN_SETTINGS;
  process.env.SECONDBRAIN_SETTINGS = settingsFile;
  resetSettings();
});
afterEach(() => {
  if (priorSettings === undefined) delete process.env.SECONDBRAIN_SETTINGS;
  else process.env.SECONDBRAIN_SETTINGS = priorSettings;
  resetSettings();
  rmSync(directory, { recursive: true, force: true });
});

it('combines shared timezone setup, inspectable Telegram identity and honest native context provenance', async () => {
  const output: string[] = [];
  expect(runTimezone(['set', 'Asia/Singapore'], { path: settingsFile, out: s => output.push(s), err: s => output.push(s) })).toBe(0);
  expect(JSON.parse(readFileSync(settingsFile, 'utf8'))).toEqual({ usage: { credits: ['fal'] }, timezone: 'Asia/Singapore' });
  const app = createApp({ modules: ALL_MODULES });
  expect((await request(app).get('/api/meta').expect(200)).body.timezone).toBe('Asia/Singapore');

  const row = (type: string, payload: unknown) => ({ timestamp: at, type, payload });
  const counter = (input: number) => row('event_msg', { type: 'token_count', info: {
    total_token_usage: { input_tokens: input, cached_input_tokens: input / 2, output_tokens: input / 5, reasoning_output_tokens: 0 },
  } });
  const native = parseCodex([row('session_meta', { id: 'integration-native', source: 'cli', model: 'example-model' }),
    row('turn_context', { model: 'example-model' }), counter(100), counter(180)], 'mac');
  expect(native.calls.map(c => c.inputTokens + c.cacheReadTokens)).toEqual([100, 80]);
  await withTransaction(async tx => {
    await archive.upsertSession(tx, { ...native.session, source: 'claude-code', externalId: 'integration-telegram',
      title: 'Inspect deployment status', startedAt: new Date(at), endedAt: new Date('2026-11-10T07:43:00Z'),
      meta: { channel: 'telegram', channel_bot: 'example-bot', persona: 'example-helper', entrypoint: 'cli' } });
    await archive.upsertSession(tx, native.session);
    await usage.upsertCalls(tx, native.calls);
  });

  const filtered = (await request(app).get('/api/usage/agent-sessions')
    .query({ ...range, type: 'telegram', persona: 'example-helper', host: 'mac' }).expect(200)).body.sessions;
  expect(filtered).toHaveLength(1);
  expect(filtered[0]).toMatchObject({ external_id: 'integration-telegram', session_type: 'telegram', persona: 'example-helper',
    channel_bot: 'example-bot', display_title: 'Inspect deployment status', started_at: at.replace('Z', '.000Z'),
    ended_at: '2026-11-10T07:43:00.000Z' });
  expect(filtered[0].display_title.length).toBeLessThan(100);
  const sessions = (await request(app).get('/api/usage/agent-sessions').query(range).expect(200)).body.sessions;
  expect(sessions.find((s: { external_id: string }) => s.external_id === 'integration-native'))
    .toMatchObject({ calls: 2, context_tokens: null, context_at: null });
});
