import { beforeAll, beforeEach, afterAll, expect, it, vi } from 'vitest';
import request from 'supertest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ModuleName } from '../src/config.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth/password.js';
import { generateSecret, codeAt, currentStep } from '../src/auth/totp.js';
import { query } from '../src/db.js';
import { log } from '../src/logger.js';
import { seedInstagramToken } from '../src/metrics/social/instagram.js';
import { loadToken, saveToken } from '../src/metrics/social/tokens.js';
import { collectInstagram } from '../src/metrics/social/instagram.js';
import { socialAccounts } from '../src/metrics/social/accounts.js';
import { parseSettings, resetSettings } from '../src/settings.js';
import { truncateAll } from './helpers.js';

const origin = 'https://brain.example.com';
const callback = '/socials/ig/auth/callback';
const key = 'a'.repeat(64);
const secret = generateSecret();
const token = 'fake-unified-user-token';
const configs = [{ username: 'example.one', login: 'unified', assetId: '101' }, { username: 'example.two', login: 'unified', assetId: '102' }];
let root: string, passwordHash: string;
let clock = Date.now();
let debug: Record<string, unknown>;
let asset = '101';
const get = vi.fn(async (url: string, _headers: Record<string, string> = {}) => {
  const u = new URL(url);
  let body: unknown;
  if (u.pathname.endsWith('/oauth/access_token')) body = { access_token: token, token_type: 'bearer', expires_in: 3600 };
  else if (u.pathname.endsWith('/debug_token')) body = { data: debug };
  else if (u.pathname.endsWith('/me/accounts')) body = { data: [{ id: '201', instagram_business_account: { id: asset } }] };
  else if (u.pathname.endsWith('/101')) body = { id: '101', username: 'example.one', followers_count: 42, media_count: 3 };
  else if (u.pathname.endsWith('/102')) body = { id: '102', username: 'example.two', followers_count: 17, media_count: 1 };
  else if (u.pathname.endsWith('/101/media')) body = { data: [{ id: '401', media_type: 'IMAGE', timestamp: new Date(clock - 1000).toISOString(), like_count: 2, comments_count: 1 }] };
  else if (u.pathname.endsWith('/401/insights')) body = { data: [{ name: 'views', values: [{ value: 99 }] }, { name: 'reach', total_value: { value: 55 } }] };
  else throw new Error('unexpected fixture request');
  return { status: 200, body: JSON.stringify(body) };
});
function app(modules: ReadonlySet<ModuleName> = new Set(['social'])) {
  return createApp({ vaultRoot: root, deployment: 'server', modules,
    auth: { passwordHash, totpSecret: secret, publicOrigin: origin, secureCookie: false, now: () => clock },
    instagramUnified: { appId: 'fake-app', appSecret: 'fake-app-secret', configurationId: 'fake-config', publicOrigin: origin, encKey: key, get, now: () => clock, secureCookie: false },
  });
}
async function login(a: ReturnType<typeof app>) {
  clock += 30000;
  const r = await request(a).post('/api/auth/login').set('Origin', origin).send({ password: 'fake-password', code: codeAt(secret, currentStep(clock)) });
  expect(r.status).toBe(200);
  return r.headers['set-cookie']![0]!.split(';')[0]!;
}
async function start(a: ReturnType<typeof app>, session: string, account = 'example.one') {
  const r = await request(a).post('/api/social/instagram/connect').set('Cookie', session).set('Origin', origin).send({ account });
  expect(r.status).toBe(200);
  const url = new URL(r.body.url);
  return { state: url.searchParams.get('state')!, cookie: r.headers['set-cookie']![0]!.split(';')[0]!, url, response: r };
}
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'ig-unified-')); passwordHash = await hashPassword('fake-password'); });
beforeEach(async () => {
  await truncateAll();
  await writeFile(join(root, 'secondbrain.json'), JSON.stringify({ socialMetrics: { instagram: configs } }));
  resetSettings(); get.mockClear(); asset = '101';
  debug = { is_valid: true, app_id: 'fake-app', type: 'USER', user_id: '301', expires_at: Math.floor(clock / 1000) + 3600, scopes: ['instagram_basic', 'instagram_manage_insights', 'pages_show_list', 'pages_read_engagement'] };
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
it('requires authentication, same origin, selected configured asset and social module', async () => {
  const a = app();
  expect((await request(a).post('/api/social/instagram/connect').set('Origin', origin).send({ account: 'example.one' })).status).toBe(401);
  const session = await login(a);
  expect((await request(a).post('/api/social/instagram/connect').set('Cookie', session).set('Origin', 'https://evil.example').send({ account: 'example.one' })).status).toBe(403);
  expect((await request(a).post('/api/social/instagram/connect').set('Cookie', session).set('Origin', origin).send({ account: 'unselected' })).status).toBe(400);
  expect((await request(app(new Set())).post('/api/social/instagram/connect').set('Cookie', session).set('Origin', origin).send({ account: 'example.one' })).status).toBe(404);
});
it('uses exact configured redirect, one-time random state, encrypted independent credentials and Facebook collection', async () => {
  const a = app(), session = await login(a);
  for (const [account, id] of [['example.one', '101'], ['example.two', '102']]) {
    asset = id!;
    const s = await start(a, session, account);
    expect(s.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.url.origin + s.url.pathname).toBe('https://www.facebook.com/dialog/oauth');
    expect(s.url.searchParams.get('config_id')).toBe('fake-config');
    expect(s.url.searchParams.get('redirect_uri')).toBe(origin + callback);
    expect(s.response.headers['set-cookie']![0]!).toContain('SameSite=Lax');
    // A real cross-site return has no Strict session cookie.
    const r = await request(a).get(callback).set('Cookie', s.cookie).query({ state: s.state, code: 'fake-secret-code' });
    expect(r.status).toBe(303); expect(r.headers.location).toBe('/socials/ig/auth/complete');
    const landing = await request(a).get(r.headers.location!);
    expect(landing.status).toBe(200); expect(landing.text).toContain('href="/socials/ig/auth"');
    expect(JSON.stringify(r.headers) + r.text).not.toContain(token);
    expect((await request(a).get(callback).set('Cookie', s.cookie).query({ state: s.state, code: 'fake-secret-code' })).status).toBe(400);
    expect((await loadToken('instagram', account!, key))?.tokenKind).toBe('facebook-user');
  }
  const rows = (await query('SELECT * FROM social_metric_tokens ORDER BY account')).rows;
  expect(rows).toHaveLength(2); expect(JSON.stringify(rows)).not.toContain(token);
  for (const call of get.mock.calls.filter(([url]) => url.includes('/oauth/access_token'))) expect(new URL(call[0]).searchParams.get('redirect_uri')).toBe(origin + callback);
  const s = parseSettings({ socialMetrics: { instagram: configs } }).socialMetrics;
  const account = socialAccounts(s).find(a => a.platform === 'instagram')!;
  if (account.platform !== 'instagram') throw new Error('fixture');
  const r = await collectInstagram(account, s, { get, now: new Date(clock), encKey: key, env: {}, vaultRoot: root });
  expect(r.error).toBeUndefined(); expect(r.samples[0]?.value).toBe(42);
  expect(r.posts[0]).toMatchObject({ views: 99, reach: 55, likes: 2, comments: 1 });
  expect(get.mock.calls.filter(([url]) => url.includes('/101')).every(([, headers]) => headers?.Authorization === `Bearer ${token}`)).toBe(true);
  expect(get.mock.calls.some(([url]) => url.includes('graph.instagram.com'))).toBe(false);
});
it('stores a business-integration system-user credential for its granted asset only and collects with it', async () => {
  const a = app(), session = await login(a);
  debug = { is_valid: true, app_id: 'fake-app', type: 'SYSTEM_USER', user_id: '501', expires_at: 0, scopes: ['instagram_basic', 'instagram_manage_insights'],
    granular_scopes: [{ scope: 'instagram_basic', target_ids: ['101'] }, { scope: 'instagram_manage_insights', target_ids: ['101'] }] };
  // Cross-account: the owner granted only asset 101, so an attempt for example.two (102) stores nothing.
  const other = await start(a, session, 'example.two');
  expect((await request(a).get(callback).set('Cookie', other.cookie).query({ state: other.state, code: 'fake-secret-code' })).status).toBe(400);
  expect((await query('SELECT * FROM social_metric_tokens')).rows).toHaveLength(0);
  const s = await start(a, session, 'example.one');
  const r = await request(a).get(callback).set('Cookie', s.cookie).query({ state: s.state, code: 'fake-secret-code' });
  expect(r.status).toBe(303); expect(JSON.stringify(r.headers) + r.text).not.toContain(token);
  // Asset proof comes from granular_scopes; no Page listing is needed.
  expect(get.mock.calls.some(([url]) => url.includes('/me/accounts'))).toBe(false);
  const stored = await loadToken('instagram', 'example.one', key);
  expect(stored).toMatchObject({ tokenKind: 'facebook-system-user', assetId: '101', expiresAt: null, token });
  expect(JSON.stringify((await query('SELECT * FROM social_metric_tokens')).rows)).not.toContain(token);
  const settingsNow = parseSettings({ socialMetrics: { instagram: configs } }).socialMetrics;
  const account = socialAccounts(settingsNow).find(x => x.platform === 'instagram' && x.account === 'example.one')!;
  if (account.platform !== 'instagram') throw new Error('fixture');
  get.mockClear();
  const collected = await collectInstagram(account, settingsNow, { get, now: new Date(clock + 400 * 86_400_000), encKey: key, env: {}, vaultRoot: root });
  expect(collected.error).toBeUndefined(); expect(collected.samples[0]?.value).toBe(42);
  expect(get.mock.calls.every(([url]) => url.startsWith('https://graph.facebook.com/') && !url.includes('refresh'))).toBe(true);
});
it.each(['absent', 'mismatch', 'expired', 'other-session', 'different-strict-session', 'revoked-session', 'provider-error', 'missing-code', 'redirect-changed', 'no-cookie'])('refuses %s before exchange', async kind => {
  const a = app(), session = await login(a), s = await start(a, session);
  let cookie = s.cookie, state: string | undefined = s.state;
  if (kind === 'absent') state = undefined;
  if (kind === 'mismatch') state = 'x'.repeat(43);
  if (kind === 'expired') await query("UPDATE instagram_login_states SET expires_at = now() - interval '1 second'");
  if (kind === 'different-strict-session') cookie = s.cookie + '; ' + await login(a);
  if (kind === 'other-session') cookie = (await start(a, await login(a))).cookie;
  if (kind === 'redirect-changed') await query("UPDATE instagram_login_states SET redirect_uri = 'https://evil.example/callback'");
  if (kind === 'no-cookie') cookie = '';
  if (kind === 'revoked-session') await query('DELETE FROM auth_sessions');
  const r = await request(a).get(callback).set('Cookie', cookie).query({ ...(state ? { state } : {}), ...(kind === 'provider-error' ? { error: 'access_denied', error_description: token } : kind === 'missing-code' ? {} : { code: 'fake-secret-code' }) });
  expect(r.status).toBe(400); expect(get).not.toHaveBeenCalled(); expect(r.text).not.toContain(token);
});
it.each(['wrong-app', 'invalid', 'unsupported-type', 'missing-scope', 'unowned', 'wrong-username', 'expired-token', 'data-expired'])('refuses %s without storing credentials or leaking API errors', async kind => {
  const a = app(), s = await start(a, await login(a));
  if (kind === 'wrong-app') debug.app_id = 'other-app';
  if (kind === 'expired-token') debug.expires_at = 1;
  if (kind === 'data-expired') debug.data_access_expires_at = 1;
  if (kind === 'invalid') debug.is_valid = false;
  if (kind === 'unsupported-type') debug.type = 'SYSTEM_USER';
  if (kind === 'missing-scope') debug.scopes = [];
  if (kind === 'unowned') asset = '999';
  if (kind === 'wrong-username') await writeFile(join(root, 'secondbrain.json'), JSON.stringify({ socialMetrics: { instagram: [{ ...configs[0], username: 'changed' }] } }));
  resetSettings();
  const r = await request(a).get(callback).set('Cookie', s.cookie).query({ state: s.state, code: 'fake-secret-code' });
  expect(r.status).toBe(400); expect(r.text).not.toContain(token);
  expect((await query('SELECT * FROM social_metric_tokens')).rows).toHaveLength(0);
});

it('serves the authenticated connect page before SPA routing', async () => {
  const a = app();
  expect((await request(a).get('/socials/ig/auth')).status).toBe(401);
  const page = await request(a).get('/socials/ig/auth').set('Cookie', await login(a));
  expect(page.status).toBe(200); expect(page.text).toContain('example.one'); expect(page.text).toContain('/api/social/instagram/connect');
  expect(page.headers['cache-control']).toBe('no-store');
});
it('allows only one concurrent exchange and consumes provider denial', async () => {
  const a = app(), session = await login(a), s = await start(a, session);
  const responses = await Promise.all([1, 2].map(() => request(a).get(callback).set('Cookie', s.cookie).query({ state: s.state, code: 'fake-secret-code' })));
  expect(responses.map(r => r.status).sort()).toEqual([303, 400]);
  expect(get.mock.calls.filter(([url]) => url.includes('/oauth/access_token'))).toHaveLength(1);
  const denied = await start(a, session);
  await request(a).get(callback).set('Cookie', denied.cookie).query({ state: denied.state, error: 'access_denied' });
  expect((await request(a).get(callback).set('Cookie', denied.cookie).query({ state: denied.state, code: 'fake-secret-code' })).status).toBe(400);
});
it('does not log or return secret transport errors and encrypts with the configured key', async () => {
  const a = app(), s = await start(a, await login(a));
  const logger = vi.spyOn(log, 'error');
  get.mockRejectedValueOnce(new Error('fake-secret-code fake-app-secret ' + token));
  const r = await request(a).get(callback).set('Cookie', s.cookie).query({ state: s.state, code: 'fake-secret-code' });
  expect(r.status).toBe(400); expect(r.text).not.toContain('fake-secret-code'); expect(r.text).not.toContain('fake-app-secret'); expect(logger).not.toHaveBeenCalled();
  logger.mockRestore();
});
it('never refreshes a Unified credential as legacy or seeds a Unified account through the legacy CLI', async () => {
  await saveToken('instagram', 'example.one', token, key, { tokenKind: 'facebook-user', assetId: '101', expiresAt: new Date(clock + 3600000) });
  const s = parseSettings({ socialMetrics: { instagram: [{ username: 'example.one' }] } }).socialMetrics;
  const account = socialAccounts(s)[0]!;
  if (account.platform !== 'instagram') throw new Error('fixture');
  const d = { get, now: new Date(clock), encKey: key, env: {}, vaultRoot: root };
  expect((await collectInstagram(account, s, d)).error).toContain('Unified'); expect(get).not.toHaveBeenCalled();
  const unified = parseSettings({ socialMetrics: { instagram: configs } }).socialMetrics;
  await expect(seedInstagramToken(unified, 'example.one', token, d)).rejects.toThrow('Unified');
  await expect(loadToken('instagram', 'example.one', 'b'.repeat(64))).rejects.toThrow();
});
