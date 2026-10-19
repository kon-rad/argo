import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { checkBodyLength, checkImageCount, MAX_IMAGE_BYTES, sniffImageType, toPostMedia } from '../src/social/media.js';
import { linkedinProvider, toLittleText } from '../src/social/providers/linkedin.js';
import type { PostMedia, QueuedPost, SocialProvider } from '../src/social/providers/types.js';
import { runDuePosts } from '../src/social/scheduler.js';
import { dueQueuedPosts, listPosts, markPublishing, postMedia, queuePost, saveConnectedAccount } from '../src/social/store.js';
import { truncateAll } from './helpers.js';

const KEY = '0'.repeat(63) + '1';
const T0 = new Date('2026-10-18T00:00:00Z');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 9)]);
const ACCOUNT = {
  id: 1, provider: 'linkedin' as const, providerAccountId: 'urn:li:person:abc123', displayName: 'Konrad',
  accessToken: 'tok', accessTokenExpiresAt: T0, refreshToken: null, refreshTokenExpiresAt: null,
};

function img(filename = 'a.png', bytes = PNG, altText = 'A diagram'): PostMedia {
  return toPostMedia(filename, bytes, altText);
}

function post(media: PostMedia[], body = 'Hello LinkedIn'): QueuedPost {
  return { id: 1, accountId: 1, body, media, attemptCount: 0 };
}

interface Call { method: string; url: string; headers: Record<string, string>; body: unknown }

/** A fake LinkedIn that records every call and answers the Images and Posts APIs. */
function fakeLinkedIn(opts: { failPut?: boolean } = {}) {
  const calls: Call[] = [];
  let n = 0;
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init?.body instanceof Uint8Array ? Buffer.from(init.body) : init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? 'GET', url, headers, body });
    if (url.includes('/rest/images?action=initializeUpload')) {
      n++;
      return Response.json({ value: { uploadUrl: `https://upload.example/img${n}`, image: `urn:li:image:IMG${n}` } });
    }
    if (url.startsWith('https://upload.example/')) return new Response(null, { status: opts.failPut ? 500 : 201 });
    if (url.includes('/rest/posts')) return new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:42' } });
    throw new Error(`unhandled fetch: ${url}`);
  }) as typeof fetch;
  return { f, calls };
}

describe('social images: validation', () => {
  it('sniffs JPEG, PNG and GIF from the bytes, not the name', () => {
    expect(sniffImageType(JPG)).toBe('image/jpeg');
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(Buffer.from('GIF89a......'))).toBe('image/gif');
    expect(sniffImageType(Buffer.from('<svg></svg>'))).toBeNull();
    expect(toPostMedia('photo.png', JPG, 'x').contentType).toBe('image/jpeg');
  });

  it('keeps only the file name, never the folder it came from', () => {
    expect(toPostMedia('/home/hermes/secondBrain/Areas/x/photo.jpg', JPG, 'alt').filename).toBe('photo.jpg');
  });

  it('rejects a missing alt text, a non-image, an empty or oversized file, and too many images', () => {
    expect(() => toPostMedia('a.png', PNG, '   ')).toThrow(/alt text is required/);
    expect(() => toPostMedia('a.txt', Buffer.from('hello'), 'alt')).toThrow(/not a JPEG, PNG or GIF/);
    expect(() => toPostMedia('a.png', Buffer.alloc(0), 'alt')).toThrow(/empty/);
    expect(() => toPostMedia('a.png', Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]), 'alt')).toThrow(/over the/);
    expect(() => checkImageCount(5)).toThrow(/at most 4/);
  });

  it('checks the length LinkedIn will count: the text after escaping', () => {
    expect(() => checkBodyLength('x'.repeat(3000))).not.toThrow();
    expect(() => checkBodyLength('x'.repeat(2990) + '(((((((')).toThrow(/once escaped/);
  });
});

describe('social images: LinkedIn little text', () => {
  it('escapes reserved characters so LinkedIn does not truncate at a parenthesis', () => {
    expect(toLittleText('Keys (AES-256-GCM) and a_b * c @ [x] {y} <z> | ~ \\')).toBe(
      'Keys \\(AES-256-GCM\\) and a\\_b \\* c \\@ \\[x\\] \\{y\\} \\<z\\> \\| \\~ \\\\',
    );
  });

  it('keeps hashtags as hashtags and escapes a # that is not one', () => {
    expect(toLittleText('#AIagents #open_source\nissue#4')).toBe('{hashtag|\\#|AIagents} {hashtag|\\#|open\\_source}\nissue\\#4');
    expect(toLittleText('We are #1 (#AI)')).toBe('We are \\#1 \\({hashtag|\\#|AI}\\)');
  });

  it('leaves URLs, arrows and plain text alone', () => {
    const text = 'Read it: https://myargoquest.com/blog/let-your-agent-post-to-linkedin\n→ done.';
    expect(toLittleText(text)).toBe(text);
  });
});

describe('social images: LinkedIn publish', () => {
  it('uploads one image, then posts with content.media and its alt text', async () => {
    const { f, calls } = fakeLinkedIn();
    const result = await linkedinProvider({ clientId: 'c', clientSecret: 's', fetchFn: f }).publish(ACCOUNT, post([img('a.jpg', JPG, 'The flow')], 'Hi (there)'));
    expect(result.remoteId).toBe('urn:li:share:42');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST https://api.linkedin.com/rest/images?action=initializeUpload',
      'PUT https://upload.example/img1',
      'POST https://api.linkedin.com/rest/posts',
    ]);
    expect(calls[0]!.body).toEqual({ initializeUploadRequest: { owner: 'urn:li:person:abc123' } });
    expect(calls[0]!.headers['linkedin-version']).toMatch(/^\d{6}$/);
    expect(calls[1]!.headers['content-type']).toBe('image/jpeg');
    expect(Buffer.compare(calls[1]!.body as Buffer, JPG)).toBe(0);
    expect(calls[2]!.body).toMatchObject({
      author: 'urn:li:person:abc123',
      commentary: 'Hi \\(there\\)',
      content: { media: { id: 'urn:li:image:IMG1', altText: 'The flow' } },
    });
  });

  it('uploads several images in order and posts them as multiImage', async () => {
    const { f, calls } = fakeLinkedIn();
    await linkedinProvider({ clientId: 'c', clientSecret: 's', fetchFn: f }).publish(ACCOUNT, post([img('1.png', PNG, 'first'), img('2.jpg', JPG, 'second')]));
    expect(calls.filter((c) => c.url.includes('initializeUpload'))).toHaveLength(2);
    expect(calls.at(-1)!.body).toMatchObject({
      content: { multiImage: { images: [{ id: 'urn:li:image:IMG1', altText: 'first' }, { id: 'urn:li:image:IMG2', altText: 'second' }] } },
    });
  });

  it('sends no content field on a text-only post', async () => {
    const { f, calls } = fakeLinkedIn();
    await linkedinProvider({ clientId: 'c', clientSecret: 's', fetchFn: f }).publish(ACCOUNT, post([]));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).not.toHaveProperty('content');
  });

  it('a failed upload throws before any post is created', async () => {
    const { f, calls } = fakeLinkedIn({ failPut: true });
    await expect(linkedinProvider({ clientId: 'c', clientSecret: 's', fetchFn: f }).publish(ACCOUNT, post([img()]))).rejects.toThrow(/image upload of a.png failed: HTTP 500/);
    expect(calls.some((c) => c.url.includes('/rest/posts'))).toBe(false);
  });
});

describe('social images: store and scheduler', () => {
  beforeEach(truncateAll);

  async function connect() {
    return saveConnectedAccount(
      'linkedin',
      { providerAccountId: 'urn:li:person:abc', displayName: 'Konrad', tokens: { accessToken: 'tok', accessTokenExpiresAt: new Date(T0.getTime() + 3600_000), refreshToken: null, refreshTokenExpiresAt: null } },
      KEY,
    );
  }

  it('stores images with the post; listings show a summary, the scheduler gets the bytes in order', async () => {
    const accountId = await connect();
    const queued = await queuePost(accountId, 'with images', [img('1.png', PNG, 'first'), img('2.jpg', JPG, 'second')], T0);
    expect(queued.media).toEqual([
      { position: 0, filename: '1.png', contentType: 'image/png', size: PNG.length, altText: 'first' },
      { position: 1, filename: '2.jpg', contentType: 'image/jpeg', size: JPG.length, altText: 'second' },
    ]);
    expect(JSON.stringify(await listPosts())).not.toContain('bytes');

    const [due] = await dueQueuedPosts(T0);
    expect(due).not.toHaveProperty('media'); // bytes are loaded one post at a time
    const media = await postMedia(due!.id);
    expect(media.map((m) => m.filename)).toEqual(['1.png', '2.jpg']);
    expect(Buffer.compare(media[1]!.bytes, JPG)).toBe(0);
  });

  it('a post whose image the database refuses is not queued at all', async () => {
    const accountId = await connect();
    const bad = { ...img(), altText: '' }; // bypasses toPostMedia; the column CHECK refuses it
    await expect(queuePost(accountId, 'half a post', [img(), bad], T0)).rejects.toThrow();
    expect(await listPosts()).toEqual([]);
  });

  it('a post left publishing by a killed run is failed after 15 minutes, never requeued', async () => {
    const accountId = await connect();
    const p = await queuePost(accountId, 'interrupted', [], T0);
    await markPublishing(p.id, T0);
    const provider = { publish: async () => ({ remoteId: 'x' }) } as unknown as SocialProvider;
    await runDuePosts({ linkedin: provider }, KEY, new Date(T0.getTime() + 10 * 60_000));
    expect((await listPosts('publishing')).map((r) => r.id)).toEqual([p.id]); // 10 minutes: still in flight
    await runDuePosts({ linkedin: provider }, KEY, new Date(T0.getTime() + 16 * 60_000));
    expect((await listPosts('failed'))[0]).toMatchObject({ id: p.id, last_error: expect.stringMatching(/check LinkedIn/) });
  });

  it('starts no new post once the pass is over its time budget', async () => {
    const accountId = await connect();
    await queuePost(accountId, 'first', [], T0);
    await queuePost(accountId, 'second', [], T0);
    let t = 0;
    const provider = { publish: async () => { t += 50_000; return { remoteId: 'x' }; } } as unknown as SocialProvider;
    expect(await runDuePosts({ linkedin: provider }, KEY, T0, 40_000, () => t)).toEqual({ posted: 1, failed: 0 });
    expect((await listPosts('queued')).map((r) => r.body)).toEqual(['second']);
  });

  it('runDuePosts hands the provider the post with its images', async () => {
    const accountId = await connect();
    await queuePost(accountId, 'with an image', [img('a.png', PNG, 'alt')], T0);
    const seen: QueuedPost[] = [];
    const provider: SocialProvider = {
      id: 'linkedin',
      authUrl: () => '',
      exchangeCode: async () => { throw new Error('unused'); },
      refresh: async () => { throw new Error('unused'); },
      publish: async (_a, p) => { seen.push(p); return { remoteId: 'urn:li:share:1' }; },
    };
    expect(await runDuePosts({ linkedin: provider }, KEY, T0)).toEqual({ posted: 1, failed: 0 });
    expect(seen[0]!.media).toHaveLength(1);
    expect(seen[0]!.media[0]!.altText).toBe('alt');
  });
});

describe('social images: queue API', () => {
  beforeEach(truncateAll);

  function app() {
    const { f } = fakeLinkedIn();
    return createApp({
      modules: new Set(['social']),
      social: { providers: { linkedin: linkedinProvider({ clientId: 'c', clientSecret: 's', fetchFn: f }) }, tokenEncKey: KEY, redirectBaseUrl: 'https://brain.example.com' },
    });
  }

  it('queues a post with a base64 image and refuses one without alt text or that is not an image', async () => {
    const accountId = await saveConnectedAccount(
      'linkedin',
      { providerAccountId: 'urn:li:person:abc', displayName: 'Konrad', tokens: { accessToken: 'tok', accessTokenExpiresAt: new Date(Date.now() + 3600_000), refreshToken: null, refreshTokenExpiresAt: null } },
      KEY,
    );
    const a = app();
    const scheduledFor = new Date(Date.now() + 3600_000).toISOString();

    const ok = await request(a)
      .post('/api/social/posts')
      .send({ accountId, body: 'Hello', scheduledFor, media: [{ filename: 'a.jpg', altText: 'The flow', dataBase64: JPG.toString('base64') }] });
    expect(ok.status).toBe(201);
    expect(ok.body.post.media).toEqual([{ position: 0, filename: 'a.jpg', contentType: 'image/jpeg', size: JPG.length, altText: 'The flow' }]);

    const noAlt = await request(a)
      .post('/api/social/posts')
      .send({ accountId, body: 'Hello', scheduledFor, media: [{ filename: 'a.jpg', altText: '', dataBase64: JPG.toString('base64') }] });
    expect(noAlt.status).toBe(400);

    const notImage = await request(a)
      .post('/api/social/posts')
      .send({ accountId, body: 'Hello', scheduledFor, media: [{ filename: 'a.jpg', altText: 'x', dataBase64: Buffer.from('<html>').toString('base64') }] });
    expect(notImage.status).toBe(400);
    expect((await listPosts()).length).toBe(1);
  });

  it('accepts a body over the 1 MB global JSON limit (a real-sized image)', async () => {
    const accountId = await saveConnectedAccount(
      'linkedin',
      { providerAccountId: 'urn:li:person:abc', displayName: 'Konrad', tokens: { accessToken: 'tok', accessTokenExpiresAt: new Date(Date.now() + 3600_000), refreshToken: null, refreshTokenExpiresAt: null } },
      KEY,
    );
    const big = Buffer.concat([JPG, Buffer.alloc(2 * 1024 * 1024, 1)]);
    const res = await request(app())
      .post('/api/social/posts')
      .send({ accountId, body: 'Hello', scheduledFor: new Date().toISOString(), media: [{ filename: 'big.jpg', altText: 'big', dataBase64: big.toString('base64') }] });
    expect(res.status).toBe(201);
    expect(res.body.post.media[0].size).toBe(big.length);
  });
});
