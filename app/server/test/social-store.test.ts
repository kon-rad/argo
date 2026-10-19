import { beforeEach, describe, expect, it } from 'vitest';
import * as store from '../src/social/store.js';
import { truncateAll } from './helpers.js';

const KEY = '0'.repeat(63) + '1';
const T0 = new Date('2026-10-18T00:00:00Z');

function account(overrides: Partial<Parameters<typeof store.saveConnectedAccount>[1]> = {}) {
  return {
    providerAccountId: 'urn:li:person:abc123',
    displayName: 'Konrad Gnat',
    tokens: { accessToken: 'tok1', accessTokenExpiresAt: new Date(T0.getTime() + 1000), refreshToken: null, refreshTokenExpiresAt: null },
    ...overrides,
  };
}

describe('social store: accounts', () => {
  beforeEach(truncateAll);

  it('saves a connected account and lists it without exposing the raw token', async () => {
    const id = await store.saveConnectedAccount('linkedin', account(), KEY);
    const accounts = await store.listAccounts();
    expect(accounts).toEqual([
      expect.objectContaining({ id, provider: 'linkedin', displayName: 'Konrad Gnat', hasRefreshToken: false }),
    ]);
    expect(JSON.stringify(accounts)).not.toContain('tok1');
  });

  it('reconnecting the same provider account replaces its tokens (upsert)', async () => {
    const id1 = await store.saveConnectedAccount('linkedin', account(), KEY);
    const id2 = await store.saveConnectedAccount('linkedin', account({ tokens: { ...account().tokens, accessToken: 'tok2' } }), KEY);
    expect(id2).toBe(id1);
    const stored = await store.getAccount(id1, KEY);
    expect(stored?.accessToken).toBe('tok2');
  });

  it('round-trips encrypted tokens through getAccount', async () => {
    const id = await store.saveConnectedAccount('linkedin', account({ tokens: { accessToken: 'secret-token', accessTokenExpiresAt: T0, refreshToken: 'refresh-token', refreshTokenExpiresAt: T0 } }), KEY);
    const stored = await store.getAccount(id, KEY);
    expect(stored?.accessToken).toBe('secret-token');
    expect(stored?.refreshToken).toBe('refresh-token');
  });

  it('disconnecting hides the account from listAccounts and getAccount', async () => {
    const id = await store.saveConnectedAccount('linkedin', account(), KEY);
    expect(await store.disconnectAccount(id)).toBe(true);
    expect(await store.listAccounts()).toEqual([]);
    expect(await store.getAccount(id, KEY)).toBeNull();
    expect(await store.disconnectAccount(id)).toBe(false); // already disconnected
  });

  it('flags accounts needing reauth when the access token is expiring with no usable refresh token', async () => {
    const soon = new Date(T0.getTime() + 3 * 24 * 3600_000); // 3 days out
    await store.saveConnectedAccount('linkedin', account({ tokens: { accessToken: 'a', accessTokenExpiresAt: soon, refreshToken: null, refreshTokenExpiresAt: null } }), KEY);
    const candidates = await store.accountsNeedingReauth(T0);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.provider).toBe('linkedin');
  });

  it('does not flag an account with a refresh token that outlives the window', async () => {
    const soon = new Date(T0.getTime() + 3 * 24 * 3600_000);
    const farOut = new Date(T0.getTime() + 300 * 24 * 3600_000);
    await store.saveConnectedAccount('linkedin', account({ tokens: { accessToken: 'a', accessTokenExpiresAt: soon, refreshToken: 'r', refreshTokenExpiresAt: farOut } }), KEY);
    expect(await store.accountsNeedingReauth(T0)).toEqual([]);
  });
});

describe('social store: posts', () => {
  beforeEach(truncateAll);

  it('queues, lists, and cancels a post', async () => {
    const accountId = await store.saveConnectedAccount('linkedin', account(), KEY);
    const post = await store.queuePost(accountId, 'Hello world', [], T0);
    expect(post.status).toBe('queued');

    expect(await store.listPosts('queued')).toHaveLength(1);
    expect(await store.cancelPost(post.id)).toBe(true);
    expect(await store.listPosts('queued')).toEqual([]);
    expect(await store.listPosts('canceled')).toHaveLength(1);
  });

  it('cannot cancel a post that is no longer queued', async () => {
    const accountId = await store.saveConnectedAccount('linkedin', account(), KEY);
    const post = await store.queuePost(accountId, 'Hello world', [], T0);
    await store.markPublishing(post.id);
    expect(await store.cancelPost(post.id)).toBe(false);
  });

  it('dueQueuedPosts only returns queued posts scheduled at or before now', async () => {
    const accountId = await store.saveConnectedAccount('linkedin', account(), KEY);
    const due = await store.queuePost(accountId, 'due now', [], T0);
    await store.queuePost(accountId, 'later', [], new Date(T0.getTime() + 3600_000));
    const rows = await store.dueQueuedPosts(T0);
    expect(rows.map((r) => r.id)).toEqual([due.id]);
  });

  it('marks a post posted, and failed/retried after 3 attempts', async () => {
    const accountId = await store.saveConnectedAccount('linkedin', account(), KEY);
    const posted = await store.queuePost(accountId, 'ok', [], T0);
    await store.markPosted(posted.id, T0, 'urn:li:share:1', 'https://linkedin.com/x');
    expect((await store.listPosts('posted'))[0]).toMatchObject({ remote_id: 'urn:li:share:1' });

    const failing = await store.queuePost(accountId, 'fails', [], T0);
    await store.markFailedOrRetry(failing.id, 0, 'first error');
    expect((await store.listPosts('queued')).find((p) => p.id === failing.id)?.attempt_count).toBe(1);
    await store.markFailedOrRetry(failing.id, 1, 'second error');
    await store.markFailedOrRetry(failing.id, 2, 'third error');
    const final = (await store.listPosts('failed')).find((p) => p.id === failing.id);
    expect(final).toMatchObject({ attempt_count: 3, last_error: 'third error' });
  });
});
