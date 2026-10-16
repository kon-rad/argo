import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { query } from '../src/db.js';
import { readFal, readKeys, readOpenRouter, saveReading, type CreditReading } from '../src/credits.js';
import { ALL_MODULES, truncateAll } from './helpers.js';

const fakeFetch = (status: number, body: unknown, seen: { url?: string; auth?: string } = {}) =>
  (async (url: string, init?: RequestInit) => {
    seen.url = url;
    seen.auth = (init?.headers as Record<string, string>).Authorization;
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;

const ok = (over: Partial<CreditReading> = {}): CreditReading => ({
  provider: 'openrouter', origin: 'api', status: 'ok', balance: 7.9394, totalCredits: 120, totalUsage: 112.0606,
  currency: 'USD', error: null, note: null, ...over,
});

describe('credit readers', () => {
  it('OpenRouter: balance is credits bought minus used', async () => {
    const seen: { url?: string; auth?: string } = {};
    const r = await readOpenRouter('sk-or', fakeFetch(200, { data: { total_credits: 120, total_usage: 112.06055105 } }, seen));
    expect(seen).toEqual({ url: 'https://openrouter.ai/api/v1/credits', auth: 'Bearer sk-or' });
    expect(r).toMatchObject({ status: 'ok', balance: 7.9394, totalCredits: 120, totalUsage: 112.06055105, currency: 'USD' });
  });

  it('fal: reads credits.current_balance and the currency, and reports a refused key as an error', async () => {
    const seen: { url?: string; auth?: string } = {};
    const r = await readFal('fk', fakeFetch(200, { username: 'k', credits: { current_balance: 24.5, currency: 'USD' } }, seen));
    expect(seen).toEqual({ url: 'https://api.fal.ai/v1/account/billing?expand=credits', auth: 'Key fk' });
    expect(r).toMatchObject({ status: 'ok', balance: 24.5, currency: 'USD' });
    const denied = await readFal('fk', fakeFetch(403, { error: { type: 'authorization_error', message: 'This API key is not permitted to perform this action.' } }));
    expect(denied).toMatchObject({ status: 'error', balance: null, error: 'HTTP 403: This API key is not permitted to perform this action.' });
  });

  it('a missing key is "unsupported", never a zero balance', async () => {
    expect(await readFal(undefined)).toMatchObject({ status: 'unsupported', balance: null });
    expect(await readOpenRouter('')).toMatchObject({ status: 'unsupported', balance: null });
  });

  it('readKeys takes only the named keys from the file, and the environment wins', () => {
    const dir = mkdtempSync(join(tmpdir(), 'credits-'));
    const file = join(dir, '.env');
    writeFileSync(file, 'OTHER_SECRET=nope\nOPENROUTER_API_KEY="from-file"\nexport FAL_BILLING_KEY=fal-file\nBROKEN=$8\n');
    expect(readKeys({}, file)).toEqual({ OPENROUTER_API_KEY: 'from-file', FAL_BILLING_KEY: 'fal-file' });
    expect(readKeys({ OPENROUTER_API_KEY: 'env' }, file).OPENROUTER_API_KEY).toBe('env');
    expect(readKeys({}, join(dir, 'missing'))).toEqual({ OPENROUTER_API_KEY: undefined, FAL_BILLING_KEY: undefined });
  });
});

describe('credit snapshots', () => {
  beforeEach(truncateAll);
  const count = async () => Number((await query('SELECT count(*) FROM provider_credit_snapshots')).rows[0].count);

  it('stores a change at once, an unchanged API reading at most hourly, a manual one always', async () => {
    const t0 = new Date('2026-10-14T10:00:00Z');
    expect(await saveReading(ok(), t0)).toBe(true);
    expect(await saveReading(ok(), new Date(t0.getTime() + 15 * 60000))).toBe(false);
    expect(await saveReading(ok({ balance: 7.5 }), new Date(t0.getTime() + 30 * 60000))).toBe(true);
    expect(await saveReading(ok({ balance: 7.5 }), new Date(t0.getTime() + 91 * 60000))).toBe(true);
    expect(await saveReading(ok({ provider: 'gemini', origin: 'manual', totalCredits: null, totalUsage: null }), new Date(t0.getTime() + 92 * 60000))).toBe(true);
    expect(await saveReading(ok({ provider: 'gemini', origin: 'manual', totalCredits: null, totalUsage: null }), new Date(t0.getTime() + 93 * 60000))).toBe(true);
    expect(await count()).toBe(5);
  });

  it('GET /api/usage/credits gives every provider, the latest row and the last good balance', async () => {
    const app = createApp({ modules: ALL_MODULES });
    const now = Date.now();
    await saveReading(ok(), new Date(now - 3600_000));
    await saveReading(ok({ status: 'error', balance: null, totalCredits: null, totalUsage: null, error: 'HTTP 500' }), new Date(now - 60_000));
    const r = await request(app).get('/api/usage/credits');
    expect(r.status).toBe(200);
    const byP = Object.fromEntries(r.body.providers.map((p: { provider: string }) => [p.provider, p]));
    expect(Object.keys(byP)).toEqual(['openrouter', 'fal', 'gemini']);
    expect(byP.openrouter.latest).toMatchObject({ status: 'error', error: 'HTTP 500', balance: null });
    expect(byP.openrouter.last_ok).toMatchObject({ status: 'ok', balance: 7.9394, total_credits: 120 });
    expect(byP.fal).toMatchObject({ latest: null, last_ok: null });
    expect(r.body.history).toHaveLength(1);
    expect(r.body.history[0]).toMatchObject({ provider: 'openrouter', balance: 7.9394 });
  });
});
