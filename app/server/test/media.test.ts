import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { mediaKind } from '../src/routes/media.js';
import { scanVault } from '../src/connectors/vault/scan.js';
import { truncateAll, vaultSourceId } from './helpers.js';

let root: string;
let app: ReturnType<typeof createApp>;

const stub = (b2Path: string) => `---\ntype: b2-media\nb2_path: ${b2Path}\nbytes: 20\n---\n# stub\n`;

async function put(rel: string, body: string | Buffer, mtime: string): Promise<void> {
  const abs = join(root, rel);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, body);
  const t = new Date(mtime);
  await utimes(abs, t, t);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'media-'));
  await put('Areas/photos/cat.jpg', Buffer.from('jpg'), '2026-01-03T00:00:00Z');
  await put('Areas/photos/Diagram.PNG', Buffer.from('png'), '2026-01-02T00:00:00Z');
  await put('Areas/clips/talk.mp4', Buffer.from('mp4 bytes'), '2026-01-05T00:00:00Z');
  await put('Areas/clips/talk.mp4.b2.md', stub('vault/Areas/clips/talk.mp4'), '2026-01-05T00:00:00Z');
  await put('Areas/clips/remote only.mov.b2.md', stub('vault/Areas/clips/remote only.mov'), '2026-01-04T00:00:00Z');
  await put('Areas/clips/escape.b2.md', stub('vault/../secrets/x.mp4'), '2026-01-04T00:00:00Z');
  await put('Projects/pod/episode.mp3', Buffer.from('mp3'), '2026-01-01T00:00:00Z');
  await put('Projects/pod/notes.md', '# notes\n', '2026-01-06T00:00:00Z');
  await put('Projects/pod/data.json', '{}', '2026-01-06T00:00:00Z');
  await put('100%_done/odd.webp', Buffer.from('webp'), '2025-12-31T00:00:00Z');

  await truncateAll();
  await scanVault({ root, sourceId: await vaultSourceId() });
  app = createApp({ vaultRoot: root, modules: new Set(['media']) });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('mediaKind', () => {
  it('maps extensions to image, video or audio', () => {
    expect(mediaKind('.JPG')).toBe('image');
    expect(mediaKind('.mov')).toBe('video');
    expect(mediaKind('.m4a')).toBe('audio');
    expect(mediaKind('.md')).toBeNull();
    expect(mediaKind('.pdf')).toBeNull();
  });
});

describe('GET /api/media', () => {
  it('lists every image, video and audio file, newest first, and nothing else', async () => {
    const res = await request(app).get('/api/media');
    expect(res.status).toBe(200);
    const paths = res.body.items.map((i: { path: string }) => i.path);
    expect(paths).toEqual([
      'Areas/clips/talk.mp4',
      'Areas/clips/remote only.mov.b2.md',
      'Areas/photos/cat.jpg',
      'Areas/photos/Diagram.PNG',
      'Projects/pod/episode.mp3',
      '100%_done/odd.webp',
    ]);
    expect(res.body.total).toBe(6);
    expect(res.body.counts).toEqual({ image: 3, video: 2, audio: 1 });
  });

  it('serves files on disk through /api/raw and remote-only stubs through /api/b2', async () => {
    const res = await request(app).get('/api/media');
    const byPath = Object.fromEntries(res.body.items.map((i: { path: string }) => [i.path, i]));
    expect(byPath['Areas/photos/cat.jpg']).toMatchObject({
      name: 'cat.jpg', kind: 'image', source: 'local', url: '/api/raw?path=Areas%2Fphotos%2Fcat.jpg',
    });
    // A stub stands for the file it names: its kind and name come from b2_path.
    expect(byPath['Areas/clips/remote only.mov.b2.md']).toMatchObject({
      name: 'remote only.mov', kind: 'video', source: 'b2', url: '/api/b2?path=Areas%2Fclips%2Fremote+only.mov.b2.md',
    });
  });

  it('marks a file the index lists but this disk no longer has', async () => {
    await rm(join(root, 'Areas/photos/Diagram.PNG'));
    const res = await request(app).get('/api/media?path=Areas/photos');
    const byName = Object.fromEntries(res.body.items.map((i: { name: string }) => [i.name, i]));
    expect(byName['cat.jpg'].available).toBe(true);
    expect(byName['Diagram.PNG'].available).toBe(false);
    await put('Areas/photos/Diagram.PNG', Buffer.from('png'), '2026-01-02T00:00:00Z');
  });

  it('never lists a stub whose original is indexed next to it, or a stub that points outside vault/', async () => {
    const res = await request(app).get('/api/media');
    const paths = res.body.items.map((i: { path: string }) => i.path);
    expect(paths).not.toContain('Areas/clips/talk.mp4.b2.md');
    expect(paths).not.toContain('Areas/clips/escape.b2.md');
  });

  it('filters by kind, folder and name', async () => {
    const video = await request(app).get('/api/media?kind=video');
    expect(video.body.items.map((i: { name: string }) => i.name)).toEqual(['talk.mp4', 'remote only.mov']);
    // counts always describe the whole folder and search, so the tabs can show them
    expect(video.body.counts).toEqual({ image: 3, video: 2, audio: 1 });

    const folder = await request(app).get('/api/media?path=Areas/photos');
    expect(folder.body.items.map((i: { name: string }) => i.name)).toEqual(['cat.jpg', 'Diagram.PNG']);

    // a folder name with LIKE wildcards in it is matched literally
    const odd = await request(app).get('/api/media?path=100%25_done');
    expect(odd.body.items.map((i: { name: string }) => i.name)).toEqual(['odd.webp']);

    const q = await request(app).get('/api/media?q=diagram');
    expect(q.body.items.map((i: { name: string }) => i.name)).toEqual(['Diagram.PNG']);
  });

  it('sorts by name and pages', async () => {
    const page1 = await request(app).get('/api/media?sort=name&limit=2');
    expect(page1.body.items.map((i: { name: string }) => i.name)).toEqual(['cat.jpg', 'Diagram.PNG']);
    expect(page1.body.has_more).toBe(true);
    const page3 = await request(app).get('/api/media?sort=name&limit=2&offset=4');
    expect(page3.body.items.map((i: { name: string }) => i.name)).toEqual(['remote only.mov', 'talk.mp4']);
    expect(page3.body.has_more).toBe(false);
  });

  it('lists the top folders that hold media, for the folder picker', async () => {
    const res = await request(app).get('/api/media');
    expect(res.body.folders).toEqual([
      { path: '100%_done', count: 1 },
      { path: 'Areas/clips', count: 2 },
      { path: 'Areas/photos', count: 2 },
      { path: 'Projects/pod', count: 1 },
    ]);
  });

  it('rejects a folder that climbs out of the vault and a bad kind', async () => {
    expect((await request(app).get('/api/media?path=../etc')).status).toBe(400);
    expect((await request(app).get('/api/media?kind=pdf')).status).toBe(400);
  });

  it('is not mounted when the module is off', async () => {
    const off = createApp({ vaultRoot: root, modules: new Set() });
    expect((await request(off).get('/api/media')).status).toBe(404);
  });
});
