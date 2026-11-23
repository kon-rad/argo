import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { query } from '../src/db.js';
import { bufferProvider } from '../src/social/providers/buffer.js';
import { linkedinProvider } from '../src/social/providers/linkedin.js';
import type { PostMedia, QueuedPost, SocialProvider, StoredAccount } from '../src/social/providers/types.js';
import { NotSentError, RejectedError } from '../src/social/providers/types.js';
import { pollHandedOff, runDuePosts } from '../src/social/scheduler.js';
import {
  beginAttempt,
  claimNextDue,
  enqueuePost,
  finishAttempt,
  IdempotencyConflictError,
  LEASE_MS,
  listAttempts,
  listPosts,
  listReconciliations,
  queuePost,
  reconcilePost,
  recoverStaleClaims,
  saveConnectedAccount,
} from '../src/social/store.js';
import { truncateAll } from './helpers.js';

// Social queue safety: idempotent enqueue, one provider call per post, and
// audited reconciliation of uncertain outcomes. Every provider here is a fake
// that counts its calls; nothing reaches a real network.

const exec = promisify(execFile);
const KEY = '0'.repeat(63) + '1';
const T0 = new Date('2026-10-18T00:00:00Z');
const AFTER_LEASE = new Date(T0.getTime() + LEASE_MS + 60_000);
const PNG = (() => {
  const b = Buffer.alloc(33, 7);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  return b;
})();
const image = (bytes = PNG, altText = 'a chart'): PostMedia => ({ filename: 'chart.png', contentType: 'image/png', bytes, altText });

async function connect(providerAccountId = 'urn:li:person:fake1'): Promise<number> {
  return saveConnectedAccount(
    'linkedin',
    { providerAccountId, displayName: 'Test Account', tokens: { accessToken: 'tok', accessTokenExpiresAt: new Date('9999-01-01T00:00:00Z'), refreshToken: null, refreshTokenExpiresAt: null } },
    KEY,
  );
}

interface Fake {
  provider: SocialProvider;
  calls: QueuedPost[];
}

/** A provider whose publish runs `impl` and records every call (the call is what a real network would see). */
function fake(impl: (post: QueuedPost, n: number) => Promise<{ remoteId: string; url?: string; pending?: boolean }>): Fake {
  const calls: QueuedPost[] = [];
  return {
    calls,
    provider: {
      id: 'linkedin',
      authUrl: () => 'https://example.com/auth',
      exchangeCode: async () => {
        throw new Error('unused');
      },
      refresh: async (a) => ({ accessToken: a.accessToken, accessTokenExpiresAt: a.accessTokenExpiresAt, refreshToken: null, refreshTokenExpiresAt: null }),
      publish: async (_a, post) => {
        calls.push(post);
        return impl(post, calls.length);
      },
    },
  };
}

const ok = () => fake(async (p) => ({ remoteId: `urn:li:share:${p.id}`, url: `https://www.example.com/${p.id}` }));

async function postRow(id: number) {
  const { rows } = await query<{ status: string; attempt_count: number; last_error: string | null; claim_token: string | null; remote_id: string | null }>(
    `SELECT status, attempt_count, last_error, claim_token, remote_id FROM social_posts WHERE id = $1`,
    [id],
  );
  return rows[0]!;
}

describe('idempotent enqueue (store)', () => {
  beforeEach(truncateAll);

  it('the same key with the same request returns the original post and stores one row', async () => {
    const a = await connect();
    const first = await enqueuePost(a, 'Hello', [image()], T0, { firstComment: 'hi' }, 'queued', { idempotencyKey: 'run-42:post-1' });
    const second = await enqueuePost(a, 'Hello', [image()], T0, { firstComment: 'hi' }, 'queued', { idempotencyKey: 'run-42:post-1' });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.post.id).toBe(first.post.id);
    expect(second.post.media).toHaveLength(1);
    expect((await query(`SELECT 1 FROM social_posts`)).rowCount).toBe(1);
    expect((await query(`SELECT 1 FROM social_post_media`)).rowCount).toBe(1);
  });

  it('option key order does not change the fingerprint', async () => {
    const a = await connect();
    const first = await enqueuePost(a, 'Hello', [], T0, { title: 't', firstComment: 'c' }, 'queued', { idempotencyKey: 'k-order' });
    const second = await enqueuePost(a, 'Hello', [], T0, { firstComment: 'c', title: 't' }, 'queued', { idempotencyKey: 'k-order' });
    expect(second).toMatchObject({ created: false, post: { id: first.post.id } });
  });

  it('the same key with a different account, schedule, body, options, media, draft flag or link is a conflict', async () => {
    const a = await connect();
    const b = await connect('urn:li:person:fake2');
    const base = await enqueuePost(a, 'Hello', [image()], T0, { firstComment: 'hi' }, 'queued', { idempotencyKey: 'k1', cardId: 't_abcdef12' });
    const variants: [string, () => Promise<unknown>][] = [
      ['account', () => enqueuePost(b, 'Hello', [image()], T0, { firstComment: 'hi' }, 'queued', { idempotencyKey: 'k1', cardId: 't_abcdef12' })],
      ['schedule', () => enqueuePost(a, 'Hello', [image()], new Date(T0.getTime() + 1000), { firstComment: 'hi' }, 'queued', { idempotencyKey: 'k1', cardId: 't_abcdef12' })],
      ['body', () => enqueuePost(a, 'Hello!', [image()], T0, { firstComment: 'hi' }, 'queued', { idempotencyKey: 'k1', cardId: 't_abcdef12' })],
      ['options', () => enqueuePost(a, 'Hello', [image()], T0, { firstComment: 'yo' }, 'queued', { idempotencyKey: 'k1', cardId: 't_abcdef12' })],
      ['media bytes', () => enqueuePost(a, 'Hello', [image(Buffer.concat([PNG, Buffer.from([1])]))], T0, { firstComment: 'hi' }, 'queued', { idempotencyKey: 'k1', cardId: 't_abcdef12' })],
      ['alt text', () => enqueuePost(a, 'Hello', [image(PNG, 'another')], T0, { firstComment: 'hi' }, 'queued', { idempotencyKey: 'k1', cardId: 't_abcdef12' })],
      ['no media', () => enqueuePost(a, 'Hello', [], T0, { firstComment: 'hi' }, 'queued', { idempotencyKey: 'k1', cardId: 't_abcdef12' })],
      ['draft', () => enqueuePost(a, 'Hello', [image()], T0, { firstComment: 'hi' }, 'draft', { idempotencyKey: 'k1', cardId: 't_abcdef12' })],
      ['card', () => enqueuePost(a, 'Hello', [image()], T0, { firstComment: 'hi' }, 'queued', { idempotencyKey: 'k1', cardId: 't_abcdef13' })],
    ];
    for (const [what, call] of variants) {
      const err = await call().then(() => null, (e: unknown) => e);
      expect(err, what).toBeInstanceOf(IdempotencyConflictError);
      expect((err as IdempotencyConflictError).postId, what).toBe(base.post.id);
    }
    expect((await query(`SELECT 1 FROM social_posts`)).rowCount).toBe(1);
  });

  it('twelve concurrent identical requests store exactly one post and all return its id', async () => {
    const a = await connect();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => enqueuePost(a, 'Race', [image()], T0, {}, 'queued', { idempotencyKey: 'race-1' })),
    );
    const ids = new Set(results.map((r) => r.post.id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect((await query(`SELECT 1 FROM social_posts`)).rowCount).toBe(1);
    expect((await query(`SELECT 1 FROM social_post_media`)).rowCount).toBe(1);
  });

  it('concurrent conflicting requests: one wins, every other one conflicts, one row', async () => {
    const a = await connect();
    const settled = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => enqueuePost(a, `body ${i}`, [], T0, {}, 'queued', { idempotencyKey: 'race-2' })),
    );
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
    expect(rejected).toHaveLength(7);
    for (const r of rejected) expect(r.reason).toBeInstanceOf(IdempotencyConflictError);
    expect((await query(`SELECT 1 FROM social_posts`)).rowCount).toBe(1);
  });

  it('the database itself refuses a second row with the same key', async () => {
    const a = await connect();
    await enqueuePost(a, 'x', [], T0, {}, 'queued', { idempotencyKey: 'db-unique' });
    await expect(
      query(`INSERT INTO social_posts (account_id, body, scheduled_for, idempotency_key, request_fingerprint) VALUES ($1, 'y', now(), 'db-unique', $2)`, [a, 'f'.repeat(64)]),
    ).rejects.toThrow(/social_posts_idempotency_key_idx/);
  });

  it('legacy requests without a key still queue a new post each time', async () => {
    const a = await connect();
    const p1 = await queuePost(a, 'same', [], T0);
    const p2 = await queuePost(a, 'same', [], T0);
    expect(p1.id).not.toBe(p2.id);
    expect(p1).toMatchObject({ idempotency_key: null });
  });

  it('refuses a malformed key', async () => {
    const a = await connect();
    await expect(enqueuePost(a, 'x', [], T0, {}, 'queued', { idempotencyKey: 'has space' })).rejects.toThrow(/idempotency key/);
    await expect(enqueuePost(a, 'x', [], T0, {}, 'queued', { idempotencyKey: '' })).rejects.toThrow(/idempotency key/);
  });
});

describe('one provider call per post (scheduler)', () => {
  beforeEach(truncateAll);

  it('publishes a due post once and records a sent attempt', async () => {
    const a = await connect();
    const p = await queuePost(a, 'Hello', [], T0);
    const f = ok();
    expect(await runDuePosts({ linkedin: f.provider }, KEY, T0)).toEqual({ posted: 1, failed: 0, handedOff: 0 });
    expect(f.calls).toHaveLength(1);
    expect(await postRow(p.id)).toMatchObject({ status: 'posted', claim_token: null, remote_id: `urn:li:share:${p.id}` });
    expect(await listAttempts(p.id)).toMatchObject([{ attempt_no: 1, state: 'sent', remote_id: `urn:li:share:${p.id}` }]);
  });

  it('overlapping workers call the provider once per post', async () => {
    const a = await connect();
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push((await queuePost(a, `post ${i}`, [], T0)).id);
    const f = fake(async (p) => {
      await new Promise((r) => setTimeout(r, 20));
      return { remoteId: `urn:li:share:${p.id}` };
    });
    const results = await Promise.all(Array.from({ length: 4 }, () => runDuePosts({ linkedin: f.provider }, KEY, T0)));
    expect(results.reduce((n, r) => n + r.posted, 0)).toBe(5);
    expect(f.calls.map((c) => c.id).sort()).toEqual([...ids].sort());
    expect((await listPosts('posted')).map((p) => p.id).sort()).toEqual([...ids].sort());
  });

  it('a pre-send failure (scheduler side, before the provider) is retried; the third gives up', async () => {
    const a = await connect();
    const p = await queuePost(a, 'no provider yet', [], T0);
    // No provider registered: fails before any network call.
    expect(await runDuePosts({}, KEY, T0)).toMatchObject({ failed: 1 });
    expect(await postRow(p.id)).toMatchObject({ status: 'queued', attempt_count: 1, claim_token: null });
    expect(await listAttempts(p.id)).toEqual([]);
    await runDuePosts({}, KEY, T0);
    await runDuePosts({}, KEY, T0);
    expect(await postRow(p.id)).toMatchObject({ status: 'failed', attempt_count: 3 });
  });

  it('a proven pre-send failure from the provider (NotSentError) is retried and the retry posts', async () => {
    const a = await connect();
    const p = await queuePost(a, 'upload hiccup', [], T0);
    const f = fake(async (post, n) => {
      if (n === 1) throw new NotSentError('image upload failed: HTTP 503');
      return { remoteId: `urn:li:share:${post.id}` };
    });
    expect(await runDuePosts({ linkedin: f.provider }, KEY, T0)).toMatchObject({ failed: 1 });
    expect(await postRow(p.id)).toMatchObject({ status: 'queued', attempt_count: 1 });
    expect(await runDuePosts({ linkedin: f.provider }, KEY, T0)).toMatchObject({ posted: 1 });
    expect(f.calls).toHaveLength(2);
    expect((await listAttempts(p.id)).map((x) => x.state)).toEqual(['not_sent', 'sent']);
  });

  it('a definitive refusal (RejectedError) fails the post without a retry', async () => {
    const a = await connect();
    const p = await queuePost(a, 'refused', [], T0);
    const f = fake(async () => {
      throw new RejectedError('buffer refused the post: invalid channel');
    });
    await runDuePosts({ linkedin: f.provider }, KEY, T0);
    await runDuePosts({ linkedin: f.provider }, KEY, T0);
    expect(f.calls).toHaveLength(1);
    expect(await postRow(p.id)).toMatchObject({ status: 'failed' });
    expect((await listAttempts(p.id)).map((x) => x.state)).toEqual(['rejected']);
  });

  const ambiguous: [string, () => Fake][] = [
    ['a timeout', () => fake(async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); })],
    ['a lost response (network reset)', () => fake(async () => { throw new TypeError('fetch failed'); })],
    ['an HTTP 500 after the request went out', () => fake(async () => { throw new Error('linkedin publish failed: HTTP 500'); })],
    ['acceptance followed by a timeout', () => fake(async () => {
      // The network has the post now; then the response is lost.
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    })],
    ['a success response without an id', () => fake(async () => ({ remoteId: '' }))],
  ];
  for (const [what, make] of ambiguous) {
    it(`${what} leaves the post uncertain and never calls the provider again`, async () => {
      const a = await connect();
      const p = await queuePost(a, 'maybe out', [], T0);
      const f = make();
      expect(await runDuePosts({ linkedin: f.provider }, KEY, T0)).toMatchObject({ failed: 1 });
      expect(await postRow(p.id)).toMatchObject({ status: 'uncertain', claim_token: null, attempt_count: 0 });
      expect((await listAttempts(p.id)).map((x) => x.state)).toEqual(['uncertain']);
      // Later passes, after the lease too, never touch it.
      await runDuePosts({ linkedin: f.provider }, KEY, T0);
      await runDuePosts({ linkedin: f.provider }, KEY, AFTER_LEASE);
      expect(f.calls).toHaveLength(1);
      expect(await postRow(p.id)).toMatchObject({ status: 'uncertain' });
    });
  }

  it('a crash after the write-ahead (process dies mid-send) becomes uncertain after the lease, never a resend', async () => {
    const a = await connect();
    const p = await queuePost(a, 'crashed', [], T0);
    const claim = await claimNextDue(T0);
    expect(claim?.id).toBe(p.id);
    expect(await beginAttempt(p.id, claim!.claimToken, T0)).toEqual(expect.any(Number));
    // ...the process dies here, inside provider.publish.

    const f = ok();
    // Within the lease: nothing happens.
    await runDuePosts({ linkedin: f.provider }, KEY, new Date(T0.getTime() + 60_000));
    expect(await postRow(p.id)).toMatchObject({ status: 'publishing' });
    // After the lease: uncertain, no provider call.
    await runDuePosts({ linkedin: f.provider }, KEY, AFTER_LEASE);
    expect(f.calls).toHaveLength(0);
    expect(await postRow(p.id)).toMatchObject({ status: 'uncertain', claim_token: null });
    expect((await listAttempts(p.id)).map((x) => x.state)).toEqual(['uncertain']);
  });

  it('a crash before the write-ahead is provably pre-send: the post is requeued and sent once', async () => {
    const a = await connect();
    const p = await queuePost(a, 'died early', [], T0);
    const stale = await claimNextDue(T0);
    // ...the process dies while refreshing a token, before any provider call.
    const f = ok();
    await runDuePosts({ linkedin: f.provider }, KEY, AFTER_LEASE);
    expect(f.calls.map((c) => c.id)).toEqual([p.id]);
    expect(await postRow(p.id)).toMatchObject({ status: 'posted', attempt_count: 1 });
    // The stale worker wakes up: its claim is gone, so it may not send.
    expect(await beginAttempt(p.id, stale!.claimToken, AFTER_LEASE)).toBeNull();
  });

  it('a paused worker that resumes after its lease expired cannot start a send', async () => {
    const a = await connect();
    const p = await queuePost(a, 'paused', [], T0);
    const paused = await claimNextDue(T0);
    expect(await recoverStaleClaims(AFTER_LEASE)).toEqual({ requeued: 1, uncertain: 0 });
    const fresh = await claimNextDue(AFTER_LEASE);
    expect(fresh?.id).toBe(p.id);
    // Both now try to write ahead: only the current claim holder may.
    expect(await beginAttempt(p.id, paused!.claimToken, AFTER_LEASE)).toBeNull();
    expect(await beginAttempt(p.id, fresh!.claimToken, AFTER_LEASE)).toEqual(expect.any(Number));
  });

  it('a stale worker paused after its write-ahead: the sweeper marks it uncertain, nobody resends, and its late answer still lands', async () => {
    const a = await connect();
    const p = await queuePost(a, 'slow send', [], T0);
    const paused = await claimNextDue(T0);
    const attempt = await beginAttempt(p.id, paused!.claimToken, T0);
    expect(await recoverStaleClaims(AFTER_LEASE)).toEqual({ requeued: 0, uncertain: 1 });
    const f = ok();
    await runDuePosts({ linkedin: f.provider }, KEY, AFTER_LEASE);
    expect(f.calls).toHaveLength(0);
    // The paused call returns with an id: that is proof, so the post resolves to posted.
    await finishAttempt(attempt!, { kind: 'sent', remoteId: 'urn:li:share:late', url: 'https://www.example.com/late' }, AFTER_LEASE);
    expect(await postRow(p.id)).toMatchObject({ status: 'posted', remote_id: 'urn:li:share:late' });
    expect((await listAttempts(p.id)).map((x) => x.state)).toEqual(['sent']);
  });

  it('a post left publishing by the old code (no claim token) becomes uncertain after the lease', async () => {
    const a = await connect();
    const p = await queuePost(a, 'legacy in flight', [], T0);
    await query(`UPDATE social_posts SET status = 'publishing', publishing_started_at = $2 WHERE id = $1`, [p.id, T0]);
    const f = ok();
    await runDuePosts({ linkedin: f.provider }, KEY, AFTER_LEASE);
    expect(f.calls).toHaveLength(0);
    expect(await postRow(p.id)).toMatchObject({ status: 'uncertain' });
  });

  it('only the attempt that holds the post can finish it; a duplicate finish is a no-op', async () => {
    const a = await connect();
    const p = await queuePost(a, 'finish twice', [], T0);
    const c = await claimNextDue(T0);
    const id = await beginAttempt(p.id, c!.claimToken, T0);
    expect(await beginAttempt(p.id, c!.claimToken, T0)).toBeNull(); // one send in flight per post
    await finishAttempt(id!, { kind: 'sent', remoteId: 'r1' }, T0);
    await finishAttempt(id!, { kind: 'uncertain', message: 'late timeout' }, T0);
    expect(await postRow(p.id)).toMatchObject({ status: 'posted', remote_id: 'r1' });
  });
});

describe('relay polling still works', () => {
  beforeEach(truncateAll);

  function relay(state: () => 'pending' | 'sent' | 'error') {
    const f = fake(async () => ({ remoteId: 'bp1', pending: true }));
    f.provider.status = async () => {
      const s = state();
      return s === 'sent' ? { state: 'sent', url: 'https://x.example.com/1' } : s === 'error' ? { state: 'error', message: 'buffer: token revoked' } : { state: 'pending' };
    };
    return f;
  }

  it('hand-off, then polled to posted; the sweeper leaves a handed-off post alone', async () => {
    const a = await connect();
    const p = await queuePost(a, 'relayed', [], T0);
    let s: 'pending' | 'sent' = 'pending';
    const f = relay(() => s);
    expect(await runDuePosts({ linkedin: f.provider }, KEY, T0)).toMatchObject({ handedOff: 1 });
    expect((await listAttempts(p.id)).map((x) => x.state)).toEqual(['handed_off']);
    await runDuePosts({ linkedin: f.provider }, KEY, AFTER_LEASE);
    expect(await postRow(p.id)).toMatchObject({ status: 'publishing' });
    s = 'sent';
    expect(await pollHandedOff({ linkedin: f.provider }, KEY, async () => undefined, AFTER_LEASE)).toEqual({ posted: 1, failed: 0 });
    expect(f.calls).toHaveLength(1);
    expect(await postRow(p.id)).toMatchObject({ status: 'posted', remote_id: 'bp1' });
  });

  it('a relay error is final, with no resend', async () => {
    const a = await connect();
    const p = await queuePost(a, 'relayed', [], T0);
    const f = relay(() => 'error');
    await runDuePosts({ linkedin: f.provider }, KEY, T0);
    expect(await pollHandedOff({ linkedin: f.provider }, KEY, async () => undefined, T0)).toEqual({ posted: 0, failed: 1 });
    await runDuePosts({ linkedin: f.provider }, KEY, AFTER_LEASE);
    expect(f.calls).toHaveLength(1);
    expect(await postRow(p.id)).toMatchObject({ status: 'failed' });
  });
});

describe('audited reconciliation', () => {
  beforeEach(truncateAll);

  async function uncertainPost(): Promise<number> {
    const a = await connect();
    const p = await queuePost(a, 'maybe', [image()], T0);
    await runDuePosts({ linkedin: fake(async () => { throw new TypeError('fetch failed'); }).provider }, KEY, T0);
    expect(await postRow(p.id)).toMatchObject({ status: 'uncertain' });
    return p.id;
  }

  it('posted: records the remote id and an audit row', async () => {
    const id = await uncertainPost();
    const r = await reconcilePost(id, { outcome: 'posted', remoteId: 'urn:li:share:found', url: 'https://www.example.com/found', note: 'found it on the profile', actor: 'owner', via: 'cli' }, AFTER_LEASE);
    expect(r).toMatchObject({ status: 'posted' });
    expect(await postRow(id)).toMatchObject({ status: 'posted', remote_id: 'urn:li:share:found' });
    expect(await listReconciliations(id)).toMatchObject([{ prior_status: 'uncertain', outcome: 'posted', new_status: 'posted', note: 'found it on the profile', actor: 'owner', via: 'cli', attempt_id: expect.any(Number) }]);
    const { rows } = await query<{ public_token: string | null }>(`SELECT public_token FROM social_post_media WHERE post_id = $1`, [id]);
    expect(rows[0]!.public_token).toBeNull();
  });

  it('not posted + requeue: a human decision allows exactly one new send', async () => {
    const id = await uncertainPost();
    await reconcilePost(id, { outcome: 'not_posted', requeue: true, note: 'not on the profile after 1 h', actor: 'owner', via: 'api' }, AFTER_LEASE);
    expect(await postRow(id)).toMatchObject({ status: 'queued', claim_token: null });
    const f = ok();
    await runDuePosts({ linkedin: f.provider }, KEY, AFTER_LEASE);
    await runDuePosts({ linkedin: f.provider }, KEY, AFTER_LEASE);
    expect(f.calls).toHaveLength(1);
    expect((await listAttempts(id)).map((x) => x.state)).toEqual(['uncertain', 'sent']);
  });

  it('not posted without requeue: failed', async () => {
    const id = await uncertainPost();
    await reconcilePost(id, { outcome: 'not_posted', note: 'drop it', actor: 'owner', via: 'cli' }, AFTER_LEASE);
    expect(await postRow(id)).toMatchObject({ status: 'failed' });
  });

  it('refuses a post that is not uncertain, a posted outcome without an id, and an empty note', async () => {
    const id = await uncertainPost();
    await expect(reconcilePost(id, { outcome: 'posted', note: 'x', actor: 'owner', via: 'cli' }, T0)).rejects.toThrow(/remote id/);
    await expect(reconcilePost(id, { outcome: 'not_posted', note: ' ', actor: 'owner', via: 'cli' }, T0)).rejects.toThrow(/note/);
    await reconcilePost(id, { outcome: 'not_posted', note: 'gone', actor: 'owner', via: 'cli' }, T0);
    await expect(reconcilePost(id, { outcome: 'not_posted', note: 'again', actor: 'owner', via: 'cli' }, T0)).rejects.toThrow(/not uncertain/);
    expect(await listReconciliations(id)).toHaveLength(1);
  });

  it('concurrent reconciliations: exactly one wins', async () => {
    const id = await uncertainPost();
    const settled = await Promise.allSettled(
      Array.from({ length: 5 }, () => reconcilePost(id, { outcome: 'not_posted', requeue: true, note: 'race', actor: 'owner', via: 'api' }, T0)),
    );
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    expect(await listReconciliations(id)).toHaveLength(1);
  });
});

describe('API (authenticated social router)', () => {
  beforeEach(truncateAll);

  function app() {
    return createApp({ modules: new Set(['social']), social: { providers: {}, tokenEncKey: KEY, redirectBaseUrl: 'https://brain.example.com' } });
  }
  const body = (accountId: number, extra: Record<string, unknown> = {}) => ({
    accountId,
    body: 'From the API',
    scheduledFor: T0.toISOString(),
    media: [{ filename: 'chart.png', altText: 'a chart', dataBase64: PNG.toString('base64') }],
    ...extra,
  });

  it('201 then 200 with the same id; a mismatch is 409; legacy requests are untouched', async () => {
    const a = await connect();
    const first = await request(app()).post('/api/social/posts').send(body(a, { idempotencyKey: 'api-1' }));
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ created: true, post: { idempotency_key: 'api-1' } });
    const replay = await request(app()).post('/api/social/posts').send(body(a, { idempotencyKey: 'api-1' }));
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ created: false, post: { id: first.body.post.id } });
    const conflict = await request(app()).post('/api/social/posts').send(body(a, { idempotencyKey: 'api-1', body: 'changed' }));
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toMatch(/idempotency key/);
    expect(conflict.body.postId).toBe(first.body.post.id);
    const legacy1 = await request(app()).post('/api/social/posts').send(body(a));
    const legacy2 = await request(app()).post('/api/social/posts').send(body(a));
    expect([legacy1.status, legacy2.status]).toEqual([201, 201]);
    expect(legacy1.body.post.id).not.toBe(legacy2.body.post.id);
  });

  it('accepts the key as an Idempotency-Key header; a header that disagrees with the body is 400', async () => {
    const a = await connect();
    const h1 = await request(app()).post('/api/social/posts').set('Idempotency-Key', 'hdr-1').send(body(a));
    const h2 = await request(app()).post('/api/social/posts').send(body(a, { idempotencyKey: 'hdr-1' }));
    expect([h1.status, h2.status]).toEqual([201, 200]);
    expect(h2.body.post.id).toBe(h1.body.post.id);
    const bad = await request(app()).post('/api/social/posts').set('Idempotency-Key', 'hdr-2').send(body(a, { idempotencyKey: 'hdr-3' }));
    expect(bad.status).toBe(400);
  });

  it('concurrent API requests with one key create one post', async () => {
    const a = await connect();
    const server = app();
    const res = await Promise.all(Array.from({ length: 6 }, () => request(server).post('/api/social/posts').send(body(a, { idempotencyKey: 'api-race' }))));
    expect(res.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
    expect(new Set(res.map((r) => r.body.post.id)).size).toBe(1);
  });

  it('POST /posts/:id/reconcile resolves an uncertain post and records the audit row', async () => {
    const a = await connect();
    const p = await queuePost(a, 'maybe', [], T0);
    await runDuePosts({ linkedin: fake(async () => ({ remoteId: '' })).provider }, KEY, T0);
    const notYet = await request(app()).post(`/api/social/posts/${p.id}/reconcile`).send({ outcome: 'posted', note: 'no id' });
    expect(notYet.status).toBe(400);
    const res = await request(app()).post(`/api/social/posts/${p.id}/reconcile`).send({ outcome: 'posted', remoteId: 'urn:li:share:9', note: 'checked the profile' });
    expect(res.status).toBe(200);
    expect(res.body.post).toMatchObject({ status: 'posted', remote_id: 'urn:li:share:9' });
    expect(await listReconciliations(p.id)).toMatchObject([{ via: 'api', actor: 'owner' }]);
    const again = await request(app()).post(`/api/social/posts/${p.id}/reconcile`).send({ outcome: 'not_posted', note: 'x' });
    expect(again.status).toBe(409);
  });
});

describe('CLI parity', () => {
  beforeEach(truncateAll);

  const SERVER = resolve(import.meta.dirname, '..');
  async function cli(args: string[]): Promise<{ code: number; out: string }> {
    try {
      const { stdout, stderr } = await exec(join(SERVER, '..', 'node_modules', '.bin', 'tsx'), ['src/cli-social.ts', ...args], {
        cwd: SERVER,
        env: { ...process.env, DATABASE_URL: config.databaseUrl },
      });
      return { code: 0, out: stdout + stderr };
    } catch (err) {
      const e = err as { code: number; stdout: string; stderr: string };
      return { code: e.code, out: e.stdout + e.stderr };
    }
  }

  it('the CLI and the API share one key space and one fingerprint', async () => {
    const a = await connect();
    const dir = mkdtempSync(join(tmpdir(), 'sb-social-'));
    writeFileSync(join(dir, 'chart.png'), PNG);
    const args = ['queue', '--account', String(a), '--body', 'From the API', '--image', join(dir, 'chart.png'), '--alt', 'a chart', '--at', T0.toISOString(), '--idempotency-key', 'parity-1'];

    const first = await cli(args);
    expect(first.code, first.out).toBe(0);
    const id = Number(/queued post (\d+)/.exec(first.out)![1]);

    const again = await cli(args);
    expect(again.code, again.out).toBe(0);
    expect(again.out).toContain(`already queued post ${id}`);

    // The same request through the API is the same post.
    const server = createApp({ modules: new Set(['social']), social: { providers: {}, tokenEncKey: KEY, redirectBaseUrl: 'https://brain.example.com' } });
    const api = await request(server).post('/api/social/posts').send({
      accountId: a, body: 'From the API', scheduledFor: T0.toISOString(), idempotencyKey: 'parity-1',
      media: [{ filename: 'chart.png', altText: 'a chart', dataBase64: readFileSync(join(dir, 'chart.png')).toString('base64') }],
    });
    expect(api.status).toBe(200);
    expect(api.body.post.id).toBe(id);

    const conflict = await cli([...args.slice(0, 4), 'From the CLI', ...args.slice(5)]);
    expect(conflict.code).toBe(1);
    expect(conflict.out).toMatch(/idempotency key parity-1 .*post \d+/);

    const noAt = await cli(['queue', '--account', String(a), '--body', 'x', '--idempotency-key', 'parity-2']);
    expect(noAt.code).toBe(1);
    expect(noAt.out).toMatch(/--at/);

    expect((await query(`SELECT 1 FROM social_posts`)).rowCount).toBe(1);
  });

  it('cli-social reconcile resolves an uncertain post with an audit row', async () => {
    const a = await connect();
    const p = await queuePost(a, 'maybe', [], T0);
    await runDuePosts({ linkedin: fake(async () => { throw new TypeError('fetch failed'); }).provider }, KEY, T0);
    const listed = await cli(['posts', '--status', 'uncertain']);
    expect(listed.out).toContain(`${p.id}  uncertain`);
    const missingNote = await cli(['reconcile', String(p.id), '--not-posted']);
    expect(missingNote.code).toBe(1);
    const res = await cli(['reconcile', String(p.id), '--not-posted', '--requeue', '--note', 'not on the profile', '--actor', 'agent-test']);
    expect(res.code, res.out).toBe(0);
    expect(res.out).toContain(`post ${p.id}: queued`);
    expect(await listReconciliations(p.id)).toMatchObject([{ outcome: 'not_posted', new_status: 'queued', via: 'cli', actor: 'agent-test' }]);
  });
});

describe('provider outcome classification (fake fetch, no network)', () => {
  const li: StoredAccount = {
    id: 1, provider: 'linkedin', transport: 'direct', providerAccountId: 'urn:li:person:fake', displayName: 'Test',
    accessToken: 'tok', accessTokenExpiresAt: T0, refreshToken: null, refreshTokenExpiresAt: null,
  };
  const post = (media: PostMedia[] = []): QueuedPost => ({ id: 1, accountId: 1, body: 'x', media, options: {}, attemptCount: 0 });

  it('linkedin: an image upload failure is NotSentError (the post request never went out)', async () => {
    let posts = 0;
    const f = (async (url: string) => {
      if (String(url).includes('/images')) return new Response('down', { status: 503 });
      posts++;
      return new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:1' } });
    }) as unknown as typeof fetch;
    const err = await linkedinProvider({ clientId: 'c', clientSecret: 's', fetchFn: f }).publish(li, post([image()])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotSentError);
    expect(posts).toBe(0);
  });

  it('linkedin: a failure of the post request itself is not NotSentError (ambiguous)', async () => {
    for (const f of [
      (async () => new Response('oops', { status: 500 })) as unknown as typeof fetch,
      (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch,
      (async () => new Response(null, { status: 201 })) as unknown as typeof fetch,
    ]) {
      const err = await linkedinProvider({ clientId: 'c', clientSecret: 's', fetchFn: f }).publish(li, post()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(NotSentError);
      expect(err).not.toBeInstanceOf(RejectedError);
    }
  });

  const buf: StoredAccount = { ...li, provider: 'x', transport: 'buffer', providerAccountId: 'chan1' };
  const gql = (reply: unknown) => (async () => new Response(JSON.stringify({ data: reply }), { status: 200 })) as unknown as typeof fetch;

  it('buffer: a media file without a public URL is NotSentError', async () => {
    const err = await bufferProvider({ apiKey: 'k', fetchFn: gql({}) }).publish(buf, post([image()])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotSentError);
  });

  it('buffer: a MutationError is RejectedError; an accepted post without an id and a transport failure are ambiguous', async () => {
    const refused = await bufferProvider({ apiKey: 'k', fetchFn: gql({ createPost: { __typename: 'InvalidInputError', message: 'bad channel' } }) })
      .publish(buf, post()).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(RejectedError);
    const noId = await bufferProvider({ apiKey: 'k', fetchFn: gql({ createPost: { __typename: 'PostActionSuccess', post: { id: '', status: 'sending', externalLink: null, error: null } } }) })
      .publish(buf, post()).catch((e: unknown) => e);
    expect(noId).toBeInstanceOf(Error);
    expect(noId).not.toBeInstanceOf(NotSentError);
    expect(noId).not.toBeInstanceOf(RejectedError);
    const reset = await bufferProvider({ apiKey: 'k', fetchFn: (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch })
      .publish(buf, post()).catch((e: unknown) => e);
    expect(reset).not.toBeInstanceOf(NotSentError);
    expect(reset).not.toBeInstanceOf(RejectedError);
  });
});

describe('migration 1756000020900 up and down', () => {
  beforeEach(truncateAll);

  const FILE = readFileSync(resolve(import.meta.dirname, '..', '..', 'db', 'migrations', '1756000020900_social-queue-idempotency.sql'), 'utf8');
  const [UP, DOWN] = FILE.split('-- Down Migration');

  it('down maps uncertain to failed and removes the new schema; up restores it', async () => {
    const a = await connect();
    const p = await queuePost(a, 'maybe', [], T0);
    await runDuePosts({ linkedin: fake(async () => { throw new TypeError('fetch failed'); }).provider }, KEY, T0);
    await enqueuePost(a, 'keyed', [], T0, {}, 'queued', { idempotencyKey: 'mig-1' });
    try {
      await query(DOWN!);
      const cols = await query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'social_posts' AND column_name IN ('idempotency_key', 'request_fingerprint', 'claim_token')`,
      );
      expect(cols.rows).toEqual([]);
      expect((await query<{ t: string | null }>(`SELECT to_regclass('public.social_post_attempts') AS t`)).rows[0]!.t).toBeNull();
      const { rows } = await query<{ status: string; last_error: string }>(`SELECT status, last_error FROM social_posts WHERE id = $1`, [p.id]);
      expect(rows[0]).toMatchObject({ status: 'failed', last_error: expect.stringMatching(/^uncertain: /) });
      await expect(query(`UPDATE social_posts SET status = 'uncertain' WHERE id = $1`, [p.id])).rejects.toThrow(/status_check/);
    } finally {
      await query(UP!);
    }
    // Up again on data the down left behind: legacy rows have no key, and new keyed rows work.
    expect((await query(`SELECT 1 FROM social_posts WHERE idempotency_key IS NULL`)).rowCount).toBe(2);
    const again = await enqueuePost(a, 'keyed', [], T0, {}, 'queued', { idempotencyKey: 'mig-1' });
    expect(again.created).toBe(true);
  });

  it('node-pg-migrate itself runs this migration down one step and up again', async () => {
    const { runner } = await import('node-pg-migrate');
    const opts = {
      databaseUrl: config.databaseUrl,
      dir: resolve(import.meta.dirname, '..', '..', 'db', 'migrations'),
      migrationsTable: 'pgmigrations',
      useGlob: false,
      checkOrder: false,
      log: () => undefined,
      count: 1,
    } as const;
    const latest = await query<{ name: string }>(`SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1`);
    // One step down only reaches this migration while it is the newest; the SQL-level test above
    // keeps covering its up and down sections after later migrations land.
    if (latest.rows[0]!.name !== '1756000020900_social-queue-idempotency') return;
    try {
      const down = await runner({ ...opts, direction: 'down' } as Parameters<typeof runner>[0]);
      expect(down.map((m) => m.name)).toEqual(['1756000020900_social-queue-idempotency']);
      expect((await query<{ t: string | null }>(`SELECT to_regclass('public.social_post_attempts') AS t`)).rows[0]!.t).toBeNull();
    } finally {
      const up = await runner({ ...opts, direction: 'up' } as Parameters<typeof runner>[0]);
      expect(up.map((m) => m.name)).toEqual(['1756000020900_social-queue-idempotency']);
    }
    expect((await query<{ t: string | null }>(`SELECT to_regclass('public.social_post_attempts') AS t`)).rows[0]!.t).toBe('social_post_attempts');
  });
});
