import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { stubTarget } from '../src/routes/b2.js';
import { scanVault } from '../src/connectors/vault/scan.js';
import { truncateAll, vaultSourceId } from './helpers.js';

/** Stands in for `b2store serve`: one object, single-range support, like rclone. */
const OBJECT = Buffer.from('0123456789abcdefghij');
const OBJECT_PATH = '/media/remote only.mp4';
let upstream: Server;
let upstreamUrl: string;
const seen: string[] = [];

let root: string;
let app: ReturnType<typeof createApp>;

const stub = (b2Path: string) => `---\ntype: b2-media\nb2_path: ${b2Path}\nbytes: 20\n---\n# stub\n`;

beforeAll(async () => {
  upstream = createServer((req, res) => {
    seen.push(req.url!);
    if (decodeURIComponent(req.url!) !== OBJECT_PATH) {
      res.writeHead(404).end('not found');
      return;
    }
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    if (m) {
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : OBJECT.length - 1;
      res.writeHead(206, {
        'Content-Type': 'video/mp4',
        'Content-Range': `bytes ${start}-${end}/${OBJECT.length}`,
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
        'X-Rclone-Internal': 'leak',
      });
      res.end(OBJECT.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': OBJECT.length, 'X-Rclone-Internal': 'leak' });
    res.end(OBJECT);
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  root = await mkdtemp(join(tmpdir(), 'b2-'));
  await mkdir(join(root, 'media'), { recursive: true });
  await writeFile(join(root, 'media/remote only.mp4.b2.md'), stub('vault/media/remote only.mp4'));
  await writeFile(join(root, 'media/local.mp4'), Buffer.from('local bytes'));
  await writeFile(join(root, 'media/local.mp4.b2.md'), stub('vault/media/local.mp4'));
  await writeFile(join(root, 'media/gone.mp4.b2.md'), stub('vault/media/gone.mp4'));
  await writeFile(join(root, 'media/escape.b2.md'), stub('vault/../secrets/.env'));
  await writeFile(join(root, 'media/plain.md'), '# just a note\n');

  await truncateAll();
  await scanVault({ root, sourceId: await vaultSourceId() });
  app = createApp({ vaultRoot: root, b2: { serveUrl: upstreamUrl } });
});

afterAll(async () => {
  await new Promise<void>((r) => upstream.close(() => r()));
  await rm(root, { recursive: true, force: true });
});

describe('stubTarget', () => {
  it('accepts only clean paths under vault/', () => {
    expect(stubTarget('vault/Areas/x/clip.mp4')).toBe('Areas/x/clip.mp4');
    expect(stubTarget('vault/../x')).toBeNull();
    expect(stubTarget('vault/a//b')).toBeNull();
    expect(stubTarget('instagram/x.jpg')).toBeNull();
    expect(stubTarget('vault/')).toBeNull();
    expect(stubTarget(42)).toBeNull();
  });
});

describe('GET /api/b2', () => {
  it('streams a B2-only file through the serve URL, dropping rclone-internal headers', async () => {
    const res = await request(app).get('/api/b2').query({ path: 'media/remote only.mp4.b2.md' }).buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('video/mp4');
    expect(res.headers['x-rclone-internal']).toBeUndefined();
    expect(Buffer.from(res.body).toString()).toBe(OBJECT.toString());
    expect(seen.at(-1)).toBe('/media/remote%20only.mp4');
  });

  it('passes a Range through so the player can seek', async () => {
    const res = await request(app)
      .get('/api/b2')
      .query({ path: 'media/remote only.mp4.b2.md' })
      .set('Range', 'bytes=5-9')
      .buffer(true);
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 5-9/20');
    expect(Buffer.from(res.body).toString()).toBe('56789');
  });

  it('sets an attachment name for downloads', async () => {
    const res = await request(app).get('/api/b2').query({ path: 'media/remote only.mp4.b2.md', download: '1' });
    expect(res.headers['content-disposition']).toContain('filename="remote only.mp4"');
  });

  it('redirects to the local original when it is still on disk', async () => {
    const res = await request(app).get('/api/b2').query({ path: 'media/local.mp4.b2.md' });
    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('/api/raw?path=media%2Flocal.mp4');
  });

  it('404s when B2 does not have the object', async () => {
    const res = await request(app).get('/api/b2').query({ path: 'media/gone.mp4.b2.md' });
    expect(res.status).toBe(404);
  });

  it('refuses a stub whose b2_path climbs out of vault/', async () => {
    const before = seen.length;
    const res = await request(app).get('/api/b2').query({ path: 'media/escape.b2.md' });
    expect(res.status).toBe(404);
    expect(seen.length).toBe(before);
  });

  it('refuses a note that is not a stub', async () => {
    const res = await request(app).get('/api/b2').query({ path: 'media/plain.md' });
    expect(res.status).toBe(404);
  });

  it('503s when no serve URL is configured', async () => {
    const bare = createApp({ vaultRoot: root, b2: {} });
    const res = await request(bare).get('/api/b2').query({ path: 'media/remote only.mp4.b2.md' });
    expect(res.status).toBe(503);
  });
});
