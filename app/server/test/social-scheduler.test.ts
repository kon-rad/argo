import { beforeEach, describe, expect, it } from 'vitest';
import { checkReauthNeeded, runDuePosts } from '../src/social/scheduler.js';
import type { SocialProvider } from '../src/social/providers/types.js';
import { NoRefreshTokenError } from '../src/social/providers/types.js';
import { getAccount, listPosts, queuePost, saveConnectedAccount } from '../src/social/store.js';
import { truncateAll } from './helpers.js';

const KEY = '0'.repeat(63) + '1';
const T0 = new Date('2026-10-18T00:00:00Z');

function fakeProvider(overrides: Partial<SocialProvider> = {}): SocialProvider {
  return {
    id: 'linkedin',
    authUrl: () => 'https://example.com/auth',
    exchangeCode: async () => {
      throw new Error('not used in these tests');
    },
    refresh: async () => {
      throw new NoRefreshTokenError('linkedin');
    },
    publish: async () => ({ remoteId: 'urn:li:share:1', url: 'https://linkedin.com/x' }),
    ...overrides,
  };
}

async function connectAccount(expiresAt = new Date(T0.getTime() + 3600_000)) {
  return saveConnectedAccount(
    'linkedin',
    { providerAccountId: 'urn:li:person:abc', displayName: 'Konrad', tokens: { accessToken: 'tok', accessTokenExpiresAt: expiresAt, refreshToken: null, refreshTokenExpiresAt: null } },
    KEY,
  );
}

describe('runDuePosts', () => {
  beforeEach(truncateAll);

  it('publishes a due post and marks it posted', async () => {
    const accountId = await connectAccount();
    const post = await queuePost(accountId, 'Hello LinkedIn', [], T0);
    const result = await runDuePosts({ linkedin: fakeProvider() }, KEY, T0);
    expect(result).toEqual({ posted: 1, failed: 0, handedOff: 0 });
    expect((await listPosts('posted')).map((p) => p.id)).toEqual([post.id]);
  });

  it('refreshes an expiring token before publishing, and persists the new one', async () => {
    const accountId = await connectAccount(new Date(T0.getTime() + 60_000)); // expires in 1 minute, under the 2-minute buffer
    await queuePost(accountId, 'needs refresh', [], T0);
    const provider = fakeProvider({
      refresh: async () => ({ accessToken: 'newtok', accessTokenExpiresAt: new Date(T0.getTime() + 5_184_000_000), refreshToken: null, refreshTokenExpiresAt: null }),
    });
    const result = await runDuePosts({ linkedin: provider }, KEY, T0);
    expect(result).toEqual({ posted: 1, failed: 0, handedOff: 0 });
    const stored = await getAccount(accountId, KEY);
    expect(stored?.accessToken).toBe('newtok');
  });

  it('a post whose account has no refresh token and an expired access token fails without posting', async () => {
    const accountId = await connectAccount(new Date(T0.getTime() - 1000)); // already expired
    const post = await queuePost(accountId, 'stuck', [], T0);
    const result = await runDuePosts({ linkedin: fakeProvider() }, KEY, T0);
    expect(result).toEqual({ posted: 0, failed: 1, handedOff: 0 });
    const rows = await listPosts('queued');
    expect(rows.find((r) => r.id === post.id)).toMatchObject({ attempt_count: 1, last_error: expect.stringMatching(/reauthorized manually/) });
  });

  it('gives up after 3 failed attempts', async () => {
    const accountId = await connectAccount();
    const post = await queuePost(accountId, 'always fails', [], T0);
    const provider = fakeProvider({
      publish: async () => {
        throw new Error('linkedin publish failed: HTTP 500');
      },
    });
    for (let i = 0; i < 3; i++) await runDuePosts({ linkedin: provider }, KEY, T0);
    const failed = await listPosts('failed');
    expect(failed.find((p) => p.id === post.id)).toMatchObject({ attempt_count: 3 });
  });

  it('only processes due posts, leaving future ones queued', async () => {
    const accountId = await connectAccount();
    await queuePost(accountId, 'later', [], new Date(T0.getTime() + 3600_000));
    const result = await runDuePosts({ linkedin: fakeProvider() }, KEY, T0);
    expect(result).toEqual({ posted: 0, failed: 0, handedOff: 0 });
  });
});

describe('checkReauthNeeded', () => {
  beforeEach(truncateAll);

  it('notifies once per account and does not repeat within 24 hours', async () => {
    await connectAccount(new Date(T0.getTime() + 24 * 3600_000)); // 1 day out, under the 7-day window, no refresh token
    const sent: string[] = [];
    await checkReauthNeeded(async (t) => void sent.push(t), T0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/linkedin.*reauthorization/);

    const again: string[] = [];
    await checkReauthNeeded(async (t) => void again.push(t), T0);
    expect(again).toEqual([]);
  });

  it('stays quiet for an account whose token is healthy', async () => {
    await connectAccount(new Date(T0.getTime() + 30 * 24 * 3600_000)); // 30 days out
    const sent: string[] = [];
    await checkReauthNeeded(async (t) => void sent.push(t), T0);
    expect(sent).toEqual([]);
  });
});
