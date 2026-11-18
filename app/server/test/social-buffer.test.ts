import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { PostOptionsSchema } from '../src/routes/social.js';
import { asset, bufferMetadata, bufferProvider } from '../src/social/providers/buffer.js';
import type { PostMedia, SocialProvider, StoredAccount } from '../src/social/providers/types.js';
import { checkPost, imageSize, instagramLength, xWeightedLength } from '../src/social/rules.js';
import { pollHandedOff, publicMediaUrl, runDuePosts } from '../src/social/scheduler.js';
import {
  accountIdForProvider,
  approvePost,
  cancelPost,
  disconnectMissingBufferAccounts,
  listPosts,
  movePost,
  queuePost,
  saveConnectedAccount,
} from '../src/social/store.js';
import { query } from '../src/db.js';
import { truncateAll } from './helpers.js';

const KEY = '0'.repeat(63) + '1';
const T0 = new Date('2026-10-20T00:00:00Z');
const BASE = 'https://brain.example.com';
const LIMITS = { xMaxChars: 280 };

const PNG_1080x1350 = (() => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(1080, 16);
  b.writeUInt32BE(1350, 20);
  return b;
})();
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(64, 1)]);

function png(width: number, height: number): Buffer {
  const b = Buffer.from(PNG_1080x1350);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

const image = (bytes = PNG_1080x1350): PostMedia => ({ filename: 'a.png', contentType: 'image/png', bytes, altText: 'a diagram' });
const video = (): PostMedia => ({ filename: 'reel.mp4', contentType: 'video/mp4', bytes: MP4, altText: '' });

function account(provider: StoredAccount['provider']): StoredAccount {
  return {
    id: 1,
    provider,
    transport: 'buffer',
    providerAccountId: 'chan123',
    displayName: 'test',
    accessToken: 'buffer',
    accessTokenExpiresAt: new Date('9999-12-31T00:00:00Z'),
    refreshToken: null,
    refreshTokenExpiresAt: null,
  };
}

/** Records each GraphQL request and answers from `reply`. */
function fakeBuffer(reply: (body: { query: string; variables?: Record<string, unknown> }) => unknown) {
  const calls: { query: string; variables?: Record<string, unknown>; auth: string | null }[] = [];
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { query: string; variables?: Record<string, unknown> };
    calls.push({ ...body, auth: new Headers(init?.headers).get('authorization') });
    return Response.json({ data: reply(body) });
  }) as typeof fetch;
  return { calls, provider: bufferProvider({ apiKey: 'test-key', fetchFn }) };
}

async function connect(provider: 'instagram' | 'youtube' | 'x', channel = `chan-${provider}`): Promise<number> {
  return saveConnectedAccount(
    provider,
    { providerAccountId: channel, displayName: provider, tokens: { accessToken: 'buffer', accessTokenExpiresAt: new Date('9999-12-31T00:00:00Z'), refreshToken: null, refreshTokenExpiresAt: null } },
    KEY,
    'buffer',
  );
}

describe('rules', () => {
  it('weighs X text the way X does', () => {
    expect(xWeightedLength('hello')).toBe(5);
    expect(xWeightedLength('see https://example.com/a/very/long/path?x=1')).toBe(4 + 23);
    expect(xWeightedLength('日本')).toBe(4);
    expect(xWeightedLength('🚀')).toBe(2);
  });

  it('counts an Instagram line break as 2', () => {
    expect(instagramLength('a\nb')).toBe(4);
  });

  it('reads PNG and JPEG sizes', () => {
    expect(imageSize(PNG_1080x1350)).toEqual({ width: 1080, height: 1350 });
    // Minimal JPEG: SOI, APP0 (len 16), SOF0 with height 1920, width 1080.
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
      Buffer.alloc(14),
      Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x07, 0x80, 0x04, 0x38]),
      Buffer.alloc(12),
    ]);
    expect(imageSize(jpeg)).toEqual({ width: 1080, height: 1920 });
  });

  it('holds X to the configured limit, thread posts included', () => {
    expect(() => checkPost('x', 'x'.repeat(280), [], {}, LIMITS)).not.toThrow();
    expect(() => checkPost('x', 'x'.repeat(281), [], {}, LIMITS)).toThrow(/281 weighted/);
    expect(() => checkPost('x', 'x'.repeat(5000), [], {}, { xMaxChars: 25000 })).not.toThrow();
    expect(() => checkPost('x', 'first', [], { thread: ['ok', 'y'.repeat(300)] }, LIMITS)).toThrow(/thread post 3/);
  });

  it('wants media on Instagram, a video for a reel, and a feed-sized image', () => {
    expect(() => checkPost('instagram', 'caption', [], {}, LIMITS)).toThrow(/needs an image or a video/);
    expect(() => checkPost('instagram', 'caption', [image()], { instagramType: 'reel' }, LIMITS)).toThrow(/reel needs a video/);
    expect(() => checkPost('instagram', 'caption', [image()], {}, LIMITS)).not.toThrow(); // 0.8 exactly
    expect(() => checkPost('instagram', 'caption', [image(png(1080, 1920))], {}, LIMITS)).toThrow(/0\.8 to 1\.91/);
    expect(() => checkPost('instagram', 'caption', [video()], {}, LIMITS, [{ width: 1080, height: 1920, seconds: 3 }])).toThrow(/5 s to 15 min/);
    expect(() => checkPost('instagram', 'caption', [video()], {}, LIMITS, [{ width: 1080, height: 1920, seconds: 45 }])).not.toThrow();
  });

  it('wants one 9:16 or square video and a title on YouTube', () => {
    const vertical = [{ width: 1080, height: 1920, seconds: 60 }];
    expect(() => checkPost('youtube', 'desc', [video()], {}, LIMITS, vertical)).toThrow(/title is required/);
    expect(() => checkPost('youtube', 'desc', [video()], { title: 'A Short' }, LIMITS, vertical)).not.toThrow();
    expect(() => checkPost('youtube', 'desc', [image()], { title: 'A Short' }, LIMITS)).toThrow(/exactly one video/);
    expect(() => checkPost('youtube', 'desc', [video()], { title: 'A Short' }, LIMITS, [{ width: 1078, height: 1920, seconds: 60 }])).toThrow(/9:16 or 1:1/);
    expect(() => checkPost('youtube', 'desc', [video()], { title: 'A Short' }, LIMITS, [{ width: 1080, height: 1920, seconds: 200 }])).toThrow(/3 min/);
    expect(() => checkPost('youtube', 'desc', [video()], { title: 'x'.repeat(101) }, LIMITS)).toThrow(/100 at most/);
  });

  it('keeps LinkedIn to images and its own length rule', () => {
    expect(() => checkPost('linkedin', 'hi', [video()], {}, LIMITS)).toThrow(/video/);
    expect(() => checkPost('linkedin', 'x'.repeat(3001), [], {}, LIMITS)).toThrow(/3000/);
  });
});

describe('bufferMetadata', () => {
  it('makes a video an Instagram reel shared to the feed', () => {
    expect(bufferMetadata('instagram', { body: 'b', media: [video()], options: {} })).toEqual({ instagram: { type: 'reel', shouldShareToFeed: true } });
  });

  it('fills YouTube defaults around the title', () => {
    expect(bufferMetadata('youtube', { body: 'b', media: [video()], options: { title: 'T', privacy: 'unlisted' } })).toEqual({
      youtube: { title: 'T', categoryId: '28', madeForKids: false, notifySubscribers: true, privacy: 'unlisted' },
    });
  });

  it('sends an X thread with the body as its first post, and nothing for a plain post', () => {
    expect(bufferMetadata('x', { body: 'one', media: [], options: {} })).toBeUndefined();
    expect(bufferMetadata('x', { body: 'one', media: [], options: { thread: ['two'] } })).toEqual({
      twitter: { thread: [{ text: 'one', assets: [] }, { text: 'two', assets: [] }] },
    });
  });
});

describe('reel cover (coverAt)', () => {
  it('sends an Instagram reel cover as thumbnailOffset in ms, and no cover elsewhere', () => {
    const v = { ...video(), publicUrl: `${BASE}/api/social/media/tok/reel.mp4` };
    expect(asset(v, 'instagram', { coverAt: 4.25 })).toEqual({ video: { url: v.publicUrl, metadata: { thumbnailOffset: 4250 } } });
    expect(asset(v, 'instagram', {})).toEqual({ video: { url: v.publicUrl } });
    expect(asset(v, 'youtube', { title: 'T' })).toEqual({ video: { url: v.publicUrl, metadata: { title: 'T' } } });
  });

  it('checks coverAt: a video on Instagram, inside its length, and nowhere else', () => {
    const reel = [{ width: 1080, height: 1920, seconds: 45 }];
    expect(() => checkPost('instagram', 'c', [video()], { coverAt: 4 }, LIMITS, reel)).not.toThrow();
    expect(() => checkPost('instagram', 'c', [video()], { coverAt: 50 }, LIMITS, reel)).toThrow(/video is 45\.0 s/);
    expect(() => checkPost('instagram', 'c', [image()], { coverAt: 1 }, LIMITS)).toThrow(/has none/);
    expect(() => checkPost('youtube', 'd', [video()], { title: 'T', coverAt: 1 }, LIMITS, reel)).toThrow(/Instagram only/);
    expect(() => checkPost('x', 'post', [], { coverAt: 1 }, LIMITS)).toThrow(/Instagram only/);
  });

  it('accepts coverAt as a number in the options schema', () => {
    expect(PostOptionsSchema.safeParse({ coverAt: 3.5 }).success).toBe(true);
    expect(PostOptionsSchema.safeParse({ coverAt: -1 }).success).toBe(false);
    expect(PostOptionsSchema.safeParse({ coverAt: '3' }).success).toBe(false);
  });
});

describe('bufferProvider', () => {
  it('creates a post now on the channel, with media by public URL, and reports it pending', async () => {
    const { calls, provider } = fakeBuffer(() => ({ createPost: { __typename: 'PostActionSuccess', post: { id: 'bp1', status: 'sending', externalLink: null, error: null } } }));
    const result = await provider.publish(account('youtube'), {
      id: 1,
      accountId: 1,
      body: 'description',
      media: [{ ...video(), publicUrl: `${BASE}/api/social/media/tok/reel.mp4` }],
      options: { title: 'My Short' },
      attemptCount: 0,
    });
    expect(result).toEqual({ remoteId: 'bp1', url: undefined, pending: true });
    expect(calls[0]!.auth).toBe('Bearer test-key');
    const input = calls[0]!.variables!.input as Record<string, unknown>;
    expect(input).toMatchObject({
      channelId: 'chan123',
      text: 'description',
      mode: 'shareNow',
      schedulingType: 'automatic',
      needsApproval: false,
      assets: [{ video: { url: `${BASE}/api/social/media/tok/reel.mp4`, metadata: { title: 'My Short' } } }],
      metadata: { youtube: { title: 'My Short', categoryId: '28' } },
    });
  });

  it('turns a MutationError into a thrown error', async () => {
    const { provider } = fakeBuffer(() => ({ createPost: { __typename: 'InvalidInputError', message: 'Instagram posts need media' } }));
    await expect(provider.publish(account('instagram'), { id: 1, accountId: 1, body: 'b', media: [], options: {}, attemptCount: 0 })).rejects.toThrow(
      /Instagram posts need media/,
    );
  });

  it('refuses media with no public URL rather than sending a broken post', async () => {
    const { provider } = fakeBuffer(() => ({}));
    await expect(provider.publish(account('instagram'), { id: 1, accountId: 1, body: 'b', media: [image()], options: {}, attemptCount: 0 })).rejects.toThrow(/no public URL/);
  });

  it('maps Buffer post status to sent, error and pending', async () => {
    let status = 'sent';
    const { provider } = fakeBuffer(() => ({ post: { id: 'bp1', status, externalLink: 'https://x.com/a/status/1', error: status === 'error' ? { message: 'token revoked' } : null } }));
    expect(await provider.status!(account('x'), 'bp1')).toEqual({ state: 'sent', url: 'https://x.com/a/status/1' });
    status = 'error';
    expect(await provider.status!(account('x'), 'bp1')).toEqual({ state: 'error', message: 'buffer: token revoked' });
    status = 'scheduled';
    expect(await provider.status!(account('x'), 'bp1')).toEqual({ state: 'pending' });
  });

  it('lists channels across organizations and names the network for each', async () => {
    const { provider } = fakeBuffer((b) =>
      b.query.includes('organizations')
        ? { account: { organizations: [{ id: 'org1' }] } }
        : {
            channels: [
              { id: 'c1', name: 'argo', displayName: 'argo', service: 'twitter', externalLink: null, isDisconnected: false, isLocked: false },
              { id: 'c2', name: 'argo', displayName: null, service: 'pinterest', externalLink: null, isDisconnected: false, isLocked: false },
            ],
          },
    );
    const channels = await provider.listChannels();
    expect(channels.map((c) => [c.id, c.provider])).toEqual([
      ['c1', 'x'],
      ['c2', null],
    ]);
  });
});

describe('relay flow: hand-off, media route, confirmation', () => {
  beforeEach(truncateAll);

  function relay(onPublish: (urls: string[]) => void, status: () => Awaited<ReturnType<NonNullable<SocialProvider['status']>>>): SocialProvider {
    return {
      id: 'x',
      authUrl: () => '',
      exchangeCode: async () => {
        throw new Error('unused');
      },
      refresh: async (a) => ({ accessToken: a.accessToken, accessTokenExpiresAt: a.accessTokenExpiresAt, refreshToken: null, refreshTokenExpiresAt: null }),
      publish: async (_a, post) => {
        onPublish(post.media.map((m) => m.publicUrl ?? ''));
        return { remoteId: 'bp9', pending: true };
      },
      status: async () => status(),
    };
  }

  it('hands a post to the relay, serves its video by token while publishing, then records the URL and drops the bytes', async () => {
    const accountId = await connect('youtube');
    const post = await queuePost(accountId, 'desc', [video()], T0, { title: 'A Short' });
    let urls: string[] = [];
    let state: 'pending' | 'sent' = 'pending';
    const provider = relay(
      (u) => (urls = u),
      () => (state === 'sent' ? { state: 'sent', url: 'https://youtube.com/shorts/abc' } : { state: 'pending' }),
    );

    expect(await runDuePosts({ buffer: provider }, KEY, T0, undefined, undefined, { mediaBaseUrl: BASE })).toEqual({ posted: 0, failed: 0, handedOff: 1 });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(new RegExp(`^${BASE}/api/social/media/[A-Za-z0-9_-]{32}/reel\\.mp4$`));

    const app = createApp({ modules: new Set(['social']), social: { providers: {}, tokenEncKey: KEY, redirectBaseUrl: BASE } });
    const path = new URL(urls[0]!).pathname;
    const full = await request(app).get(path);
    expect(full.status).toBe(200);
    expect(full.headers['content-type']).toBe('video/mp4');
    expect(Buffer.compare(full.body as Buffer, MP4)).toBe(0);
    const part = await request(app).get(path).set('Range', 'bytes=0-11');
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 0-11/${MP4.length}`);
    expect((await request(app).get('/api/social/media/not-a-real-token-at-all-xx')).status).toBe(404);

    // Still pending: stays publishing, not stale-failed after 15 minutes.
    await pollHandedOff({ buffer: provider }, KEY, async () => undefined, new Date(T0.getTime() + 20 * 60_000));
    await runDuePosts({ buffer: provider }, KEY, new Date(T0.getTime() + 20 * 60_000), undefined, undefined, { mediaBaseUrl: BASE });
    expect((await listPosts('publishing')).map((p) => p.id)).toEqual([post.id]);

    state = 'sent';
    expect(await pollHandedOff({ buffer: provider }, KEY, async () => undefined, new Date(T0.getTime() + 30 * 60_000))).toEqual({ posted: 1, failed: 0 });
    const [done] = await listPosts('posted');
    expect(done).toMatchObject({ id: post.id, remote_id: 'bp9', remote_url: 'https://youtube.com/shorts/abc' });
    const { rows } = await query<{ bytes: Buffer | null; purged_at: Date | null; public_token: string | null }>(`SELECT bytes, purged_at, public_token FROM social_post_media WHERE post_id = $1`, [post.id]);
    expect(rows[0]).toMatchObject({ bytes: null, public_token: null });
    expect(rows[0]!.purged_at).not.toBeNull();
    expect((await request(app).get(path)).status).toBe(404);
  });

  it('fails a relayed post on a relay error, once, and pings', async () => {
    const accountId = await connect('x');
    const post = await queuePost(accountId, 'hello', [], T0);
    const provider = relay(() => undefined, () => ({ state: 'error', message: 'buffer: channel disconnected' }));
    await runDuePosts({ buffer: provider }, KEY, T0, undefined, undefined, { mediaBaseUrl: BASE });
    const pings: string[] = [];
    expect(await pollHandedOff({ buffer: provider }, KEY, async (t) => void pings.push(t), T0)).toEqual({ posted: 0, failed: 1 });
    expect((await listPosts('failed'))[0]).toMatchObject({ id: post.id, last_error: 'buffer: channel disconnected' });
    expect(pings[0]).toMatch(/x post \d+ failed: buffer: channel disconnected/);
  });

  it('gives up on a post the relay never confirms within 24 hours', async () => {
    const accountId = await connect('x');
    await queuePost(accountId, 'hello', [], T0);
    const provider = relay(() => undefined, () => ({ state: 'pending' }));
    await runDuePosts({ buffer: provider }, KEY, T0, undefined, undefined, { mediaBaseUrl: BASE });
    expect((await pollHandedOff({ buffer: provider }, KEY, async () => undefined, new Date(T0.getTime() + 23 * 3600_000))).failed).toBe(0);
    expect((await pollHandedOff({ buffer: provider }, KEY, async () => undefined, new Date(T0.getTime() + 25 * 3600_000))).failed).toBe(1);
  });

  it('fails clearly when Buffer is not configured', async () => {
    const accountId = await connect('instagram');
    await queuePost(accountId, 'caption', [image()], T0);
    expect((await runDuePosts({}, KEY, T0, undefined, undefined, { mediaBaseUrl: BASE })).failed).toBe(1);
    expect((await listPosts('queued'))[0]!.last_error).toMatch(/BUFFER_API_KEY/);
  });
});

describe('drafts', () => {
  beforeEach(truncateAll);

  it('never publishes a draft, and approve queues it for the given time', async () => {
    const accountId = await connect('x');
    const draft = await queuePost(accountId, 'wait for me', [], T0, {}, 'draft');
    const provider: SocialProvider = {
      id: 'x',
      authUrl: () => '',
      exchangeCode: async () => {
        throw new Error('unused');
      },
      refresh: async () => {
        throw new Error('unused');
      },
      publish: async () => {
        throw new Error('a draft must not publish');
      },
    };
    expect(await runDuePosts({ buffer: provider }, KEY, T0)).toEqual({ posted: 0, failed: 0, handedOff: 0 });

    const later = new Date(T0.getTime() + 3600_000);
    const approved = await approvePost(draft.id, T0, later);
    expect(approved).toMatchObject({ status: 'queued' });
    expect(new Date(approved!.scheduled_for).toISOString()).toBe(later.toISOString());
    expect(await approvePost(draft.id, T0)).toBeNull(); // already queued
  });

  it('approves into the present, not the past, and drafts can be canceled', async () => {
    const accountId = await connect('x');
    const draft = await queuePost(accountId, 'old', [], T0, {}, 'draft');
    const now = new Date(T0.getTime() + 86_400_000);
    expect(new Date((await approvePost(draft.id, now))!.scheduled_for).toISOString()).toBe(now.toISOString());
    const other = await queuePost(accountId, 'drop me', [], T0, {}, 'draft');
    expect(await cancelPost(other.id)).toBe(true);
  });

  it('drafts and approves over the API, with per-network checks', async () => {
    const accountId = await connect('youtube');
    const app = createApp({ modules: new Set(['social']), social: { providers: {}, tokenEncKey: KEY, redirectBaseUrl: BASE } });
    const noVideo = await request(app).post('/api/social/posts').send({ accountId, body: 'd', scheduledFor: T0.toISOString(), options: { title: 'T' } });
    expect(noVideo.status).toBe(400);
    expect(JSON.stringify(noVideo.body)).toMatch(/exactly one video/);
    const unknownOption = await request(app).post('/api/social/posts').send({ accountId, body: 'd', scheduledFor: T0.toISOString(), options: { colour: 'red' } });
    expect(unknownOption.status).toBe(400);

    const x = await connect('x');
    const created = await request(app).post('/api/social/posts').send({ accountId: x, body: 'hi', scheduledFor: T0.toISOString(), draft: true });
    expect(created.status).toBe(201);
    expect(created.body.post.status).toBe('draft');
    const ok = await request(app).post(`/api/social/posts/${created.body.post.id}/approve`).send({});
    expect(ok.status).toBe(200);
    expect(ok.body.post.status).toBe('queued');
  });

  it('builds media URLs under /api/social/media', () => {
    expect(publicMediaUrl('https://b.example.com/', 'tok', 'a b.mp4')).toBe('https://b.example.com/api/social/media/tok/a%20b.mp4');
  });
});

describe('channel swap', () => {
  beforeEach(truncateAll);

  it('disconnects a Buffer account whose channel left Buffer, counts what still waits on it, and moves those posts', async () => {
    const oldYt = await connect('youtube', 'chan-old');
    const x = await connect('x');
    const queued = await queuePost(oldYt, 'short', [], T0, { title: 't' }, 'queued');
    const draft = await queuePost(oldYt, 'draft short', [], T0, { title: 't' }, 'draft');
    const posted = await queuePost(oldYt, 'done', [], T0, { title: 't' }, 'queued');
    await query(`UPDATE social_posts SET status = 'posted' WHERE id = $1`, [posted.id]);

    const newYt = await connect('youtube', 'chan-new');
    expect(await disconnectMissingBufferAccounts(['chan-new', 'chan-x'])).toEqual([{ id: oldYt, provider: 'youtube', waiting: 2 }]);
    expect(await accountIdForProvider('youtube')).toBe(newYt);

    expect(await movePost(queued.id, newYt)).toBe(true);
    expect(await movePost(draft.id, newYt)).toBe(true);
    expect(await movePost(posted.id, newYt)).toBe(false); // already out
    expect(await movePost(queued.id, x)).toBe(false); // another network
    expect(await movePost(queued.id, oldYt)).toBe(false); // disconnected
    const rows = await listPosts();
    expect(rows.find((r) => r.id === queued.id)).toMatchObject({ account_id: newYt, status: 'queued' });
    expect(rows.find((r) => r.id === draft.id)).toMatchObject({ account_id: newYt, status: 'draft' });
  });

  it('changes nothing on an empty channel list, and never touches direct accounts', async () => {
    const yt = await connect('youtube');
    expect(await disconnectMissingBufferAccounts([])).toEqual([]);
    const li = await saveConnectedAccount(
      'linkedin',
      { providerAccountId: 'li-1', displayName: 'li', tokens: { accessToken: 'a', accessTokenExpiresAt: new Date('9999-12-31T00:00:00Z'), refreshToken: null, refreshTokenExpiresAt: null } },
      KEY,
    );
    expect(await disconnectMissingBufferAccounts(['chan-other'])).toEqual([{ id: yt, provider: 'youtube', waiting: 0 }]);
    expect(await accountIdForProvider('linkedin')).toBe(li);
  });
});
