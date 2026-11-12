import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { query } from '../src/db.js';
import { parseSettings, resetSettings, settingsReport } from '../src/settings.js';
import { claudeUsageFromSnapshots, codexSubscription, parseCodexRateLimits, readCodexRpc, resetCodexQuotaCache, resolveCodexCommand } from '../src/usage/subscriptions.js';
import type { SubscriptionUsage } from '../src/usage/subscriptions.js';
import { ALL_MODULES, truncateAll } from './helpers.js';

const at = '2026-11-08T10:00:00.000Z';
const then = new Date(at);
const win = (duration: number, used: number, resetsAt = 1794135600) =>
  ({ windowDurationMins: duration, usedPercent: used, resetsAt });

describe('Codex quota parser', () => {
  it('classifies duration regardless of primary/secondary order and retains multiple buckets', () => {
    const windows = parseCodexRateLimits({ rateLimitsByLimitId: {
      codex: { primary: win(10080, 30), secondary: win(300, 70) },
      'codex-spark': { primary: win(300, 10) },
    } }, at, then);
    expect(windows.map((w) => [w.key, w.label, w.window_minutes, w.used_pct])).toEqual([
      ['codex:10080:primary', 'codex Weekly', 10080, 30],
      ['codex:300:secondary', 'codex 5-hour', 300, 70],
      ['codex-spark:300:primary', 'codex-spark 5-hour', 300, 10],
    ]);
  });

  it('keeps weekly-only plans and omits malformed or out-of-bounds windows', () => {
    expect(parseCodexRateLimits({ rateLimits: { secondary: win(10080, 41) } }, at, then).map((w) => w.label)).toEqual(['Weekly']);
    expect(parseCodexRateLimits({ rateLimits: { primary: win(300, -1), secondary: win(10080, 101) } }, at, then)).toEqual([]);
    expect(parseCodexRateLimits({ rateLimits: { primary: { usedPercent: 5 } } }, at, then)).toEqual([]);
    expect(parseCodexRateLimits({ rateLimits: { primary: win(300, 5, 0) } }, at, then)).toEqual([]);
  });

  it('nulls a window after its reset, preserving the last observed percentage', () => {
    expect(parseCodexRateLimits({ rateLimits: { primary: win(300, 25, 1794131999) } }, at, then)[0])
      .toMatchObject({ used_pct: null, left_pct: null, reset_since_reading: true, last_pct: 25 });
  });
});

const dir = mkdtempSync(join(tmpdir(), 'sb-codex-usage-'));
const fakeCli = join(dir, 'fake-codex');
writeFileSync(fakeCli, `#!/usr/bin/env node
const mode = process.env.CODEX_FAKE_MODE;
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['app-server'])) process.exit(2);
let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk.toString();
  let i;
  while ((i = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    const m = JSON.parse(line);
    if (mode === 'timeout') continue;
    if (mode === 'overflow') { process.stdout.write('x'.repeat(600000)); continue; }
    if (mode === 'exit') process.exit(0);
    if (mode === 'junk') process.stdout.write('null\\n"str"\\n' + JSON.stringify({ method: 'account/updated', params: {} }) + '\\n');
    if (m.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\\n');
    if (m.id === 2) process.stdout.write(JSON.stringify({ id: 2, result: { account: { type: mode === 'api' ? 'apiKey' : 'chatgpt' } } }) + '\\n');
    if (m.id === 3) process.stdout.write(JSON.stringify({ id: 3, result: { rateLimits: { primary: { windowDurationMins: 300, usedPercent: 52, resetsAt: 1794135600 } } } }) + '\\n');
  }
});
`);
chmodSync(fakeCli, 0o755);
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => { vi.unstubAllEnvs(); delete process.env.CODEX_FAKE_MODE; resetCodexQuotaCache(); resetSettings(); delete process.env.SECONDBRAIN_SETTINGS; });

describe('Codex executable discovery', () => {
  it('uses an executable on PATH ahead of the user-local fallback', () => {
    const bin = join(dir, 'path-bin');
    const home = join(dir, 'path-home');
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    writeFileSync(join(home, '.local', 'bin', 'codex'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(home, '.local', 'bin', 'codex'), 0o755);
    writeFileSync(join(bin, 'codex'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, 'codex'), 0o755);
    expect(resolveCodexCommand('codex', { PATH: bin }, home)).toBe('codex');
  });

  it('finds the user-local installation under a minimal service PATH', async () => {
    const home = join(dir, 'home');
    const bin = join(home, '.local', 'bin');
    mkdirSync(bin, { recursive: true });
    const local = join(bin, 'codex');
    writeFileSync(local, `#!${process.execPath}\n` + readFileSync(fakeCli, 'utf8').split('\n').slice(1).join('\n'));
    chmodSync(local, 0o755);
    expect(resolveCodexCommand('codex', { PATH: '/usr/bin:/bin' }, home)).toBe(local);
    vi.stubEnv('HOME', home);
    vi.stubEnv('PATH', '/usr/bin:/bin');
    expect(await readCodexRpc('codex', then)).toMatchObject({ status: 'ok', windows: [{ used_pct: 52 }] });
  });

  it('does not replace custom commands or non-executable files', () => {
    const home = join(dir, 'not-executable');
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    writeFileSync(join(home, '.local', 'bin', 'codex'), 'not executable');
    expect(resolveCodexCommand('codex', { PATH: '' }, home)).toBe('codex');
    expect(resolveCodexCommand('/missing/custom-codex', { PATH: '' }, dir)).toBe('/missing/custom-codex');
  });
});

describe('Claude quota freshness', () => {
  const snapshot = (window: string, observedAt = at, resetsAt = '2026-11-09T10:00:00.000Z') => ({
    window, used_pct: 40, observed_at: new Date(observedAt), resets_at: new Date(resetsAt),
  });
  it('reports fresh windows and explicitly identifies missing weekly data', () => {
    expect(claudeUsageFromSnapshots([snapshot('five_hour'), snapshot('seven_day')], then))
      .toMatchObject({ status: 'ok', stale: false, message: null });
    expect(claudeUsageFromSnapshots([snapshot('five_hour')], then).message).toMatch(/Weekly.*not recorded/);
  });
  it('keeps old nonexpired readings visibly stale with collector guidance', () => {
    expect(claudeUsageFromSnapshots([snapshot('seven_day', '2026-11-08T08:00:00.000Z')], then))
      .toMatchObject({ status: 'ok', stale: true, message: expect.stringMatching(/statusline.*collector/i), windows: [{ used_pct: 40 }] });
  });
  it('marks fully expired data unavailable without inventing current percentages', () => {
    expect(claudeUsageFromSnapshots([snapshot('seven_day', '2026-11-07T10:00:00.000Z', '2026-11-08T09:00:00.000Z')], then))
      .toMatchObject({ status: 'unavailable', stale: true, message: expect.stringMatching(/expired/i), windows: [{ used_pct: null, left_pct: null, last_pct: 40 }] });
  });
  it('does not let an expired five-hour reading hide a fresh weekly reading', () => {
    expect(claudeUsageFromSnapshots([snapshot('five_hour', '2026-11-07T10:00:00.000Z', '2026-11-08T09:00:00.000Z'), snapshot('seven_day')], then))
      .toMatchObject({ status: 'ok', stale: false, windows: [{ used_pct: null }, { used_pct: 40 }] });
  });
  it('explains missing snapshots instead of marking them healthy', () => {
    expect(claudeUsageFromSnapshots([], then)).toMatchObject({ status: 'unavailable', stale: false, message: expect.stringMatching(/statusline.*collector/i), windows: [] });
  });
});

describe('Codex quota reader and cache', () => {
  it('returns unavailable for missing CLI, API auth, timeout and output limit', async () => {
    expect((await readCodexRpc(join(dir, 'missing'))).status).toBe('unavailable');
    process.env.CODEX_FAKE_MODE = 'api';
    expect((await readCodexRpc(fakeCli)).message).toMatch(/ChatGPT/);
    process.env.CODEX_FAKE_MODE = 'timeout';
    expect((await readCodexRpc(fakeCli, then, 100)).message).toMatch(/timed out/);
    process.env.CODEX_FAKE_MODE = 'overflow';
    expect((await readCodexRpc(fakeCli)).message).toMatch(/too large/);
    process.env.CODEX_FAKE_MODE = 'exit';
    expect((await readCodexRpc(fakeCli)).status).toBe('unavailable');
  });

  it('reads quota through the read-only RPC sequence', async () => {
    process.env.CODEX_FAKE_MODE = 'junk';
    const result = await readCodexRpc(fakeCli, then);
    expect(result).toMatchObject({ status: 'ok', source: 'codex app-server', windows: [{ window_minutes: 300, used_pct: 52 }] });
    expect(JSON.stringify(result)).not.toMatch(/email|accountId|token|cost/i);
  });

  it('coalesces requests, keeps last good on failure and nulls an expired window', async () => {
    let count = 0;
    const good: SubscriptionUsage = { provider: 'codex', label: 'Codex', status: 'ok', observed_at: at,
      source: 'codex app-server', message: null, stale: false, windows: parseCodexRateLimits({ rateLimits: { primary: win(300, 52, Math.floor(then.getTime() / 1000) + 30) } }, at, then) };
    const reader = async () => { count++; return good; };
    await Promise.all([codexSubscription(then, reader), codexSubscription(then, reader)]);
    expect(count).toBe(1);
    expect((await codexSubscription(then, reader)).status).toBe('ok');
    expect(count).toBe(1);
    const later = new Date(then.getTime() + 61_000);
    const failure: SubscriptionUsage = { ...good, status: 'unavailable', windows: [], message: 'Codex CLI unavailable' };
    const stale = await codexSubscription(later, async () => failure);
    expect(stale).toMatchObject({ status: 'ok', stale: true, message: 'Codex CLI unavailable', windows: [{ used_pct: null, last_pct: 52 }] });
  });
});

describe('usage manifest routes', () => {
  it('defaults to no providers, and defaults only an invalid usage section', async () => {
    expect(parseSettings({}).usage).toEqual({ subscriptions: [], credits: [],
      sections: ['running', 'ledger', 'sessions', 'summaries'] });
    const invalid = settingsReport({ usage: { subscriptions: ['other'] } });
    expect(invalid.settings.usage.subscriptions).toEqual([]);
    expect(invalid.errors[0]).toMatchObject({ section: 'usage', path: ['usage', 'subscriptions', 0] });
    const file = join(dir, 'empty.json');
    writeFileSync(file, '{}');
    process.env.SECONDBRAIN_SETTINGS = file;
    const app = createApp({ modules: ALL_MODULES });
    expect((await request(app).get('/api/usage/config')).body).toEqual(parseSettings({}).usage);
    expect((await request(app).get('/api/usage/subscriptions')).body).toEqual({ providers: [] });
    expect((await request(app).get('/api/usage/credits')).body).toEqual({ providers: [], history: [] });
  });

  it('returns only configured Claude and credit providers, without account identity', async () => {
    await truncateAll();
    const file = join(dir, 'configured.json');
    writeFileSync(file, JSON.stringify({ usage: { subscriptions: ['claude-code'], credits: ['fal'], sections: ['running'] } }));
    process.env.SECONDBRAIN_SETTINGS = file;
    const app = createApp({ modules: ALL_MODULES });
    await query(`INSERT INTO plan_usage_snapshots (host, origin, "window", used_pct, resets_at, observed_at) VALUES
      ('mac', 'statusline', 'seven_day', 40, now() + interval '2 days', now())`);
    await query(`INSERT INTO provider_credit_snapshots (provider, origin, status, observed_at, balance, currency) VALUES
      ('openrouter', 'manual', 'ok', now(), 10, 'USD'), ('fal', 'manual', 'ok', now(), 5, 'USD')`);
    expect((await request(app).get('/api/usage/config')).body).toEqual({ subscriptions: ['claude-code'], credits: ['fal'], sections: ['running'] });
    const subscriptions = (await request(app).get('/api/usage/subscriptions')).body.providers;
    expect(subscriptions).toMatchObject([{ provider: 'claude-code', windows: [{ label: 'Weekly', used_pct: 40 }] }]);
    expect(JSON.stringify(subscriptions)).not.toMatch(/host|origin|email|accountId|token|cost/i);
    const credits = (await request(app).get('/api/usage/credits')).body;
    expect(credits.providers.map((p: { provider: string }) => p.provider)).toEqual(['fal']);
    expect(credits.history.map((p: { provider: string }) => p.provider)).toEqual(['fal']);
  });
});
