import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { scanVault } from '../src/connectors/vault/scan.js';
import { truncateAll, vaultSourceId } from './helpers.js';

let root: string;
let app: ReturnType<typeof createApp>;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03, 0x04]);

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'browse-'));
  await mkdir(join(root, 'notes/sub'), { recursive: true });
  await mkdir(join(root, 'media'), { recursive: true });

  await writeFile(
    join(root, 'notes/alpha.md'),
    '---\ntitle: Alpha Note\ntags: [research, kids]\n---\n\n# Ignored\n\nSee [[beta]] and [[nowhere]].\n',
  );
  await writeFile(join(root, 'notes/beta.md'), '# Beta\n\nThe quick brown fox.\n');
  await writeFile(join(root, 'notes/sub/gamma.md'), '# Gamma\n\nnested\n');
  await writeFile(join(root, 'notes/delta.md'), '# Delta\n\nalso links to [[beta]]\n');
  await writeFile(join(root, 'media/diagram.png'), PNG);
  await writeFile(join(root, 'top.md'), '# Top\n\nroot level\n');

  await truncateAll();
  await scanVault({ root, sourceId: await vaultSourceId() });
  app = createApp({ vaultRoot: root });
});

afterAll(() => rm(root, { recursive: true, force: true }));

describe('GET /api/tree', () => {
  it('returns immediate dirs and files with child counts', async () => {
    const res = await request(app).get('/api/tree');
    expect(res.status).toBe(200);
    expect(res.body.dirs.map((d: { name: string }) => d.name)).toEqual(['media', 'notes']);
    expect(res.body.dirs.find((d: { name: string }) => d.name === 'notes').child_count).toBe(4);
    expect(res.body.files.map((f: { name: string }) => f.name)).toEqual(['top.md']);
    expect(res.body.total).toBe(1);
    expect(res.body.has_more).toBe(false);
  });

  it('descends into a subdirectory', async () => {
    const res = await request(app).get('/api/tree').query({ path: 'notes' });
    expect(res.body.dirs.map((d: { name: string }) => d.name)).toEqual(['sub']);
    expect(res.body.files.map((f: { name: string }) => f.name)).toEqual([
      'alpha.md',
      'beta.md',
      'delta.md',
    ]);
    expect(res.body.files[0].is_markdown).toBe(true);
    expect(res.body.files[0].path).toBe('notes/alpha.md');
    expect(typeof res.body.files[0].size_bytes).toBe('number');
  });

  it('pages children', async () => {
    const res = await request(app).get('/api/tree').query({ path: 'notes', limit: 1 });
    expect(res.body.files).toHaveLength(1);
    expect(res.body.total).toBe(3);
    expect(res.body.has_more).toBe(true);

    const page2 = await request(app).get('/api/tree').query({ path: 'notes', limit: 1, offset: 2 });
    expect(page2.body.files.map((f: { name: string }) => f.name)).toEqual(['delta.md']);
    expect(page2.body.has_more).toBe(false);
  });

  it('rejects a traversal path', async () => {
    const res = await request(app).get('/api/tree').query({ path: '../etc' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/file/resolve', () => {
  it('answers each ref with the path the link graph would use', async () => {
    const res = await request(app).get('/api/file/resolve').query({
      ref: ['notes/beta.md', 'notes/sub/gamma', 'delta', 'nowhere', 'NOTES/BETA.MD'],
    });
    expect(res.status).toBe(200);
    expect(res.body.resolved).toEqual({
      'notes/beta.md': 'notes/beta.md',
      'notes/sub/gamma': 'notes/sub/gamma.md',
      delta: 'notes/delta.md',
      nowhere: null,
      'NOTES/BETA.MD': 'notes/beta.md',
    });
  });

  it('resolves a folder ref ending in a slash to the folder, and an empty one to null', async () => {
    const res = await request(app).get('/api/file/resolve').query({ ref: ['notes/sub/', 'notes/', 'nope/none/'] });
    expect(res.body.resolved).toEqual({ 'notes/sub/': 'notes/sub/', 'notes/': 'notes/', 'nope/none/': null });
  });

  it('takes a single ref, none, and refuses a flood', async () => {
    expect((await request(app).get('/api/file/resolve').query({ ref: 'top' })).body.resolved).toEqual({ top: 'top.md' });
    expect((await request(app).get('/api/file/resolve')).body.resolved).toEqual({});
    const flood = Array.from({ length: 101 }, (_, i) => `n${i}`);
    expect((await request(app).get('/api/file/resolve').query({ ref: flood })).status).toBe(400);
  });
});

describe('GET /api/file', () => {
  it('returns frontmatter, tags, links and BACKLINKS', async () => {
    const res = await request(app).get('/api/file').query({ path: 'notes/beta.md' });
    expect(res.status).toBe(200);
    expect(res.body.file.title).toBe('Beta');
    expect(res.body.file.body).toContain('quick brown fox');
    expect(res.body.backlinks.map((b: { path: string }) => b.path).sort()).toEqual([
      'notes/alpha.md',
      'notes/delta.md',
    ]);
  });

  it('returns frontmatter title, tags and resolved plus unresolved links', async () => {
    const res = await request(app).get('/api/file').query({ path: 'notes/alpha.md' });
    expect(res.body.file.title).toBe('Alpha Note');
    expect(res.body.frontmatter.title).toBe('Alpha Note');
    expect(res.body.tags.sort()).toEqual(['kids', 'research']);

    const links = res.body.links as { target_raw: string; path: string | null }[];
    expect(links.find((l) => l.target_raw === 'beta')?.path).toBe('notes/beta.md');
    expect(links.find((l) => l.target_raw === 'nowhere')?.path).toBeNull();
  });

  it('404s an unindexed path', async () => {
    const res = await request(app).get('/api/file').query({ path: 'notes/ghost.md' });
    expect(res.status).toBe(404);
  });

  it('400s a traversal path', async () => {
    const res = await request(app).get('/api/file').query({ path: '../../etc/passwd' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/raw', () => {
  it('streams a binary with the right content-type', async () => {
    const res = await request(app).get('/api/raw').query({ path: 'media/diagram.png' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-length']).toBe(String(PNG.length));
    expect(Buffer.from(res.body)).toEqual(PNG);
  });

  it('serves a byte range as 206', async () => {
    const res = await request(app)
      .get('/api/raw')
      .query({ path: 'media/diagram.png' })
      .set('Range', 'bytes=2-5');
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 2-5/${PNG.length}`);
    expect(Buffer.from(res.body)).toEqual(PNG.subarray(2, 6));
  });

  it('416s an unsatisfiable range', async () => {
    const res = await request(app)
      .get('/api/raw')
      .query({ path: 'media/diagram.png' })
      .set('Range', 'bytes=999-1200');
    expect(res.status).toBe(416);
  });

  it('rejects a real file that exists on disk but is NOT in the index', async () => {
    // The scanner prunes `app/`, so this file is real, inside the root, and
    // still must not be served. The index is the allowlist.
    await mkdir(join(root, 'app'), { recursive: true });
    await writeFile(join(root, 'app/package.json'), '{"private":true}');
    const res = await request(app).get('/api/raw').query({ path: 'app/package.json' });
    expect(res.status).toBe(404);
  });

  it('rejects traversal with 400', async () => {
    const res = await request(app).get('/api/raw').query({ path: '../../etc/passwd' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/system', () => {
  it('reports the vault root and index counts', async () => {
    const res = await request(app).get('/api/system');
    expect(res.status).toBe(200);
    expect(res.body.vault_root).toBe(root);
    expect(res.body.counts.files).toBe(6);
  });
});
