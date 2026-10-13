import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { scanVault } from '../src/connectors/vault/scan.js';
import { truncateAll, vaultSourceId } from './helpers.js';

const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
const NOTE = '---\ntitle: Alpha\n---\n\n# Alpha\n\nSee [[beta]].\n';

let root: string;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'edit-'));
  await mkdir(join(root, 'notes'), { recursive: true });
  await writeFile(join(root, 'notes/alpha.md'), NOTE);
  await writeFile(join(root, 'notes/beta.md'), '# Beta\n');
  await writeFile(join(root, 'notes/café — plan.md'), '# Plan\n');
  await writeFile(join(root, 'notes/pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await truncateAll();
  await scanVault({ root, sourceId: await vaultSourceId() });
  app = createApp({ vaultRoot: root, deployment: 'local' });
});

afterEach(() => rm(root, { recursive: true, force: true }));

describe('GET /api/raw?download=1', () => {
  it('marks the response as an attachment with a UTF-8 filename', async () => {
    const res = await request(app).get('/api/raw').query({ path: 'notes/café — plan.md', download: '1' });
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="caf_ _ plan.md"; filename*=UTF-8''caf%C3%A9%20%E2%80%94%20plan.md`,
    );
  });

  it('stays inline without the flag', async () => {
    const res = await request(app).get('/api/raw').query({ path: 'notes/pic.png' });
    expect(res.headers['content-disposition']).toBeUndefined();
  });
});

describe('/api/file/source', () => {
  it('returns the full file from disk, frontmatter included, with its hash', async () => {
    const res = await request(app).get('/api/file/source').query({ path: 'notes/alpha.md' });
    expect(res.status).toBe(200);
    expect(res.body.content).toBe(NOTE);
    expect(res.body.hash).toBe(sha(NOTE));
  });

  it('refuses binary files', async () => {
    const res = await request(app).get('/api/file/source').query({ path: 'notes/pic.png' });
    expect(res.status).toBe(415);
  });

  it('saves, writes to disk, and reindexes immediately', async () => {
    const content = '# Alpha v2\n\nNow see [[café — plan]].\n';
    const res = await request(app)
      .put('/api/file/source')
      .send({ path: 'notes/alpha.md', content, base_hash: sha(NOTE) });
    expect(res.status).toBe(200);
    expect(res.body.hash).toBe(sha(content));
    expect(await readFile(join(root, 'notes/alpha.md'), 'utf8')).toBe(content);

    const file = await request(app).get('/api/file').query({ path: 'notes/alpha.md' });
    expect(file.body.file.title).toBe('Alpha v2');
    expect(file.body.links.map((l: { path: string }) => l.path)).toEqual(['notes/café — plan.md']);

    // No temp file left behind.
    expect((await readdir(join(root, 'notes'))).filter((n) => n.includes('.sb-'))).toEqual([]);
  });

  it('refuses to overwrite a file that changed underneath the editor', async () => {
    await writeFile(join(root, 'notes/alpha.md'), 'edited in Obsidian\n');
    const res = await request(app)
      .put('/api/file/source')
      .send({ path: 'notes/alpha.md', content: 'mine', base_hash: sha(NOTE) });
    expect(res.status).toBe(409);
    expect(res.body.error.current_hash).toBe(sha('edited in Obsidian\n'));
    expect(await readFile(join(root, 'notes/alpha.md'), 'utf8')).toBe('edited in Obsidian\n');
  });

  it('cannot write outside the index', async () => {
    const escape = await request(app)
      .put('/api/file/source')
      .send({ path: '../outside.md', content: 'x', base_hash: sha('') });
    expect(escape.status).toBe(400);
    const unindexed = await request(app)
      .put('/api/file/source')
      .send({ path: 'notes/new.md', content: 'x', base_hash: sha('') });
    expect(unindexed.status).toBe(404);
  });
});
