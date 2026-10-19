import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { SocialProvider } from '../src/social/providers/types.js';
import { truncateAll } from './helpers.js';

const KEY = '0'.repeat(63) + '1';

function fakeLinkedIn(): SocialProvider {
  return {
    id: 'linkedin',
    authUrl: (state, redirectUri) => `https://www.linkedin.com/oauth/v2/authorization?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
    exchangeCode: async (code) => ({
      providerAccountId: 'urn:li:person:abc123',
      displayName: 'Konrad Gnat',
      tokens: { accessToken: `tok-for-${code}`, accessTokenExpiresAt: new Date(Date.now() + 5_184_000_000), refreshToken: null, refreshTokenExpiresAt: null },
    }),
    refresh: async () => {
      throw new Error('not used');
    },
    publish: async () => ({ remoteId: 'urn:li:share:1' }),
  };
}

function app() {
  return createApp({
    modules: new Set(['social']),
    social: { providers: { linkedin: fakeLinkedIn() }, tokenEncKey: KEY, redirectBaseUrl: 'https://brain.example.com' },
  });
}

describe('social routes', () => {
  beforeEach(truncateAll);

  it('lists no accounts when none are connected', async () => {
    const res = await request(app()).get('/api/social/accounts');
    expect(res.status).toBe(200);
    expect(res.body.accounts).toEqual([]);
  });

  it('redirects /connect to the provider auth URL', async () => {
    const res = await request(app()).get('/api/social/accounts/linkedin/connect');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('https://www.linkedin.com/oauth/v2/authorization');
    expect(res.headers.location).toContain(encodeURIComponent('https://brain.example.com/api/social/accounts/linkedin/callback'));
  });

  it('connect -> callback round trip stores the account', async () => {
    const a = app();
    const connect = await request(a).get('/api/social/accounts/linkedin/connect');
    const state = new URL(connect.headers.location).searchParams.get('state');

    const callback = await request(a).get(`/api/social/accounts/linkedin/callback?code=authcode123&state=${state}`);
    expect(callback.status).toBe(200);
    expect(callback.body.connected.displayName).toBe('Konrad Gnat');

    const list = await request(a).get('/api/social/accounts');
    expect(list.body.accounts).toHaveLength(1);
  });

  it('rejects a callback with a missing or reused state', async () => {
    const a = app();
    const res = await request(a).get('/api/social/accounts/linkedin/callback?code=x&state=not-real');
    expect(res.status).toBe(400);
  });

  it('404s on an unknown provider', async () => {
    const res = await request(app()).get('/api/social/accounts/tiktok/connect');
    expect(res.status).toBe(404);
  });

  it('queues, lists, and cancels a post', async () => {
    const a = app();
    const connect = await request(a).get('/api/social/accounts/linkedin/connect');
    const state = new URL(connect.headers.location).searchParams.get('state');
    const callback = await request(a).get(`/api/social/accounts/linkedin/callback?code=c1&state=${state}`);
    const accountId = callback.body.connected.id;

    const queued = await request(a)
      .post('/api/social/posts')
      .send({ accountId, body: 'Hello LinkedIn', scheduledFor: new Date(Date.now() + 3600_000).toISOString() });
    expect(queued.status).toBe(201);
    expect(queued.body.post.status).toBe('queued');

    const list = await request(a).get('/api/social/posts?status=queued');
    expect(list.body.posts).toHaveLength(1);

    const canceled = await request(a).delete(`/api/social/posts/${queued.body.post.id}`);
    expect(canceled.status).toBe(200);
    expect((await request(a).get('/api/social/posts?status=queued')).body.posts).toEqual([]);
  });

  it('rejects a post body over 3000 characters', async () => {
    const res = await request(app())
      .post('/api/social/posts')
      .send({ accountId: 1, body: 'x'.repeat(3001), scheduledFor: new Date().toISOString() });
    expect(res.status).toBe(400);
  });

  it('disconnects an account', async () => {
    const a = app();
    const connect = await request(a).get('/api/social/accounts/linkedin/connect');
    const state = new URL(connect.headers.location).searchParams.get('state');
    const callback = await request(a).get(`/api/social/accounts/linkedin/callback?code=c1&state=${state}`);
    const id = callback.body.connected.id;

    expect((await request(a).delete(`/api/social/accounts/${id}`)).status).toBe(200);
    expect((await request(a).get('/api/social/accounts')).body.accounts).toEqual([]);
    expect((await request(a).delete(`/api/social/accounts/${id}`)).status).toBe(404);
  });

  it('on a server, the callback works without a session but everything else needs one', async () => {
    // The state comes from a logged-in /connect; here a local app mints it.
    const connect = await request(app()).get('/api/social/accounts/linkedin/connect');
    const state = new URL(connect.headers.location).searchParams.get('state');

    const server = createApp({
      modules: new Set(['social']),
      deployment: 'server',
      auth: { passwordHash: 'x', totpSecret: 'JBSWY3DPEHPK3PXP', publicOrigin: 'https://example.test' },
      social: { providers: { linkedin: fakeLinkedIn() }, tokenEncKey: KEY, redirectBaseUrl: 'https://brain.example.com' },
    });
    await request(server).get('/api/social/accounts').expect(401);
    await request(server).get('/api/social/accounts/linkedin/connect').expect(401);
    await request(server).get('/api/social/accounts/linkedin/callback?code=x&state=forged').expect(400);
    const callback = await request(server).get(`/api/social/accounts/linkedin/callback?code=authcode123&state=${state}`);
    expect(callback.status).toBe(200);
    expect(callback.body.connected.displayName).toBe('Konrad Gnat');
  });
});
