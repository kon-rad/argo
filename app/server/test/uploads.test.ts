import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { query } from '../src/db.js';
import { ingestUpload } from '../src/uploads/service.js';
import type { VaultRemote } from '../src/uploads/remote.js';
import type { ObjectStore, PartInfo } from '../src/uploads/store.js';
import { ALL_MODULES, truncateAll } from './helpers.js';

const MiB = 1024 ** 2;
const SIZE = 150 * MiB; // 64 + 64 + 22 MiB = 3 parts

/** An in-memory bucket: multipart uploads, an inbox, and the encrypted vault side. */
function fakes() {
  const parts = new Map<string, PartInfo[]>();
  const inbox = new Map<string, number>();
  const vault = new Map<string, Map<string, number>>();
  const store: ObjectStore = {
    createMultipart: async (key) => {
      parts.set(`u:${key}`, []);
      return `up-${key}`;
    },
    presignPart: async (key, _id, n) => `https://b2.example/${key}?part=${n}`,
    listParts: async (key) => parts.get(`u:${key}`) ?? [],
    complete: async (key, _id, ps) => {
      inbox.set(key, ps.reduce((a, p) => a + p.size, 0));
    },
    abort: async (key) => {
      parts.delete(`u:${key}`);
    },
    head: async (key) => (inbox.has(key) ? { size: inbox.get(key)! } : null),
    remove: async (key) => {
      inbox.delete(key);
    },
  };
  const remote: VaultRemote = {
    listFiles: async (dir) => new Map(vault.get(dir) ?? []),
    copyFromInbox: async (key, dest) => {
      const i = dest.lastIndexOf('/');
      const dir = dest.slice(0, i);
      const d = vault.get(dir) ?? new Map<string, number>();
      d.set(dest.slice(i + 1), inbox.get(key)!);
      vault.set(dir, d);
    },
  };
  const putPart = (key: string, n: number, size: number) => parts.get(`u:${key}`)!.push({ partNumber: n, size, etag: `"e${n}"` });
  return { store, remote, putPart, inbox, vault };
}

let root: string;
let f: ReturnType<typeof fakes>;
let kicked: number;
let app: ReturnType<typeof createApp>;

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'uploads-'));
  await truncateAll();
  await query('TRUNCATE uploads');
  f = fakes();
  kicked = 0;
  app = createApp({
    vaultRoot: root,
    modules: ALL_MODULES,
    uploads: { store: f.store, remote: f.remote, maxBytes: 200 * MiB, onUploaded: () => void kicked++ },
    uploadsPullToken: 'pull-token-0123456789',
  });
});

const body = (over: Record<string, unknown> = {}) => ({
  filename: 'day 1.mp4',
  size: SIZE,
  destDir: 'Areas/alex/vlogs',
  description: 'Tokyo day one',
  tags: ['vlog'],
  ...over,
});

async function startUpload(over: Record<string, unknown> = {}) {
  const res = await request(app).post('/api/uploads').send(body(over));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { upload: { id: string; inbox_key: string }; partSize: number; partCount: number };
}

function putAllParts(key: string, partSize: number, count: number) {
  for (let n = 1; n <= count; n++) f.putPart(key, n, n < count ? partSize : SIZE - partSize * (count - 1));
}

describe('uploads', () => {
  it('starts an upload, hands out part URLs and refuses a bad folder, name or size', async () => {
    const u = await startUpload();
    expect(u.partCount).toBe(3);
    expect(u.upload.inbox_key).toBe(`inbox/${u.upload.id}/day 1.mp4`);
    expect(JSON.stringify(u)).not.toContain('s3_upload_id');

    const parts = await request(app).post(`/api/uploads/${u.upload.id}/parts`).send({ partNumbers: [1, 3] });
    expect(parts.status).toBe(200);
    expect(Object.keys(parts.body.urls)).toEqual(['1', '3']);
    expect((await request(app).post(`/api/uploads/${u.upload.id}/parts`).send({ partNumbers: [4] })).status).toBe(400);

    expect((await request(app).post('/api/uploads').send(body({ destDir: '.hermes/x' }))).status).toBe(400);
    expect((await request(app).post('/api/uploads').send(body({ filename: 'x.b2.md' }))).status).toBe(400);
    expect((await request(app).post('/api/uploads').send(body({ size: 300 * MiB }))).status).toBe(413);
  });

  it('resumes: status lists the parts already in the bucket', async () => {
    const u = await startUpload();
    f.putPart(u.upload.inbox_key, 1, u.partSize);
    const res = await request(app).get(`/api/uploads/${u.upload.id}`);
    expect(res.body.donePartNumbers).toEqual([1]);
  });

  it('refuses to complete with a missing or short part', async () => {
    const u = await startUpload();
    f.putPart(u.upload.inbox_key, 1, u.partSize);
    f.putPart(u.upload.inbox_key, 3, 1);
    const res = await request(app).post(`/api/uploads/${u.upload.id}/complete`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.missing).toEqual([2]);
    expect(res.body.error.wrong).toEqual([3]);
    expect(kicked).toBe(0);
  });

  it('completes, then moves the file into the vault folder and writes a stub', async () => {
    const u = await startUpload({ toM1: true });
    putAllParts(u.upload.inbox_key, u.partSize, u.partCount);
    const done = await request(app).post(`/api/uploads/${u.upload.id}/complete`).send({});
    expect(done.status).toBe(200);
    expect(done.body.upload.status).toBe('uploaded');
    expect(kicked).toBe(1);

    await ingestUpload({ store: f.store, remote: f.remote, vaultRoot: root }, u.upload.id);
    const row = (await request(app).get(`/api/uploads/${u.upload.id}`)).body.upload;
    expect(row.status).toBe('stored');
    expect(row.b2_path).toBe('vault/Areas/alex/vlogs/day 1.mp4');
    expect(row.m1_status).toBe('pending');
    expect(f.inbox.has(u.upload.inbox_key)).toBe(false); // inbox copy deleted after the vault copy checked out
    const stub = await readFile(join(root, 'Areas/alex/vlogs/day 1.mp4.b2.md'), 'utf8');
    expect(stub).toContain('b2_path: vault/Areas/alex/vlogs/day 1.mp4');
    expect(stub).toContain(`bytes: ${SIZE}`);
    expect(stub).toContain('description: "Tokyo day one"');
  });

  it('numbers the file when the name is already in that folder', async () => {
    f.vault.set('Areas/alex/vlogs', new Map([['day 1.mp4', 1]]));
    const u = await startUpload();
    putAllParts(u.upload.inbox_key, u.partSize, u.partCount);
    await request(app).post(`/api/uploads/${u.upload.id}/complete`).send({});
    await ingestUpload({ store: f.store, remote: f.remote, vaultRoot: root }, u.upload.id);
    const row = (await request(app).get(`/api/uploads/${u.upload.id}`)).body.upload;
    expect(row.b2_path).toBe('vault/Areas/alex/vlogs/day 1-2.mp4');
  });

  it('keeps the inbox copy and reports the error when the vault copy is the wrong size, and retry works', async () => {
    const u = await startUpload();
    putAllParts(u.upload.inbox_key, u.partSize, u.partCount);
    await request(app).post(`/api/uploads/${u.upload.id}/complete`).send({});
    const spy = vi.spyOn(f.remote, 'copyFromInbox').mockImplementationOnce(async (_k, dest) => {
      f.vault.set('Areas/alex/vlogs', new Map([[dest.split('/').pop()!, 5]]));
    });
    const deps = { store: f.store, remote: f.remote, vaultRoot: root };
    await ingestUpload(deps, u.upload.id);
    let row = (await request(app).get(`/api/uploads/${u.upload.id}`)).body.upload;
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/does not match/);
    expect(f.inbox.has(u.upload.inbox_key)).toBe(true);

    spy.mockRestore();
    f.vault.clear();
    expect((await request(app).post(`/api/uploads/${u.upload.id}/retry`).send({})).status).toBe(200);
    await ingestUpload(deps, u.upload.id);
    row = (await request(app).get(`/api/uploads/${u.upload.id}`)).body.upload;
    expect(row.status).toBe('stored');
  });

  it('aborts an unfinished upload', async () => {
    const u = await startUpload();
    const res = await request(app).post(`/api/uploads/${u.upload.id}/abort`).send({});
    expect(res.body.upload.status).toBe('aborted');
    expect((await request(app).post(`/api/uploads/${u.upload.id}/parts`).send({ partNumbers: [1] })).status).toBe(409);
  });
});

describe('M1 pull', () => {
  const auth = { Authorization: 'Bearer pull-token-0123456789' };

  async function stored(toM1: boolean) {
    const u = await startUpload({ toM1 });
    putAllParts(u.upload.inbox_key, u.partSize, u.partCount);
    await request(app).post(`/api/uploads/${u.upload.id}/complete`).send({});
    await ingestUpload({ store: f.store, remote: f.remote, vaultRoot: root }, u.upload.id);
    return u.upload.id;
  }

  it('needs the token', async () => {
    expect((await request(app).get('/api/uploads/pull/pending')).status).toBe(401);
    expect((await request(app).get('/api/uploads/pull/pending').set('Authorization', 'Bearer wrong')).status).toBe(401);
  });

  it('lists only stored files that asked for the M1, and tracks a pull to done', async () => {
    const wanted = await stored(true);
    await stored(false);
    const pending = await request(app).get('/api/uploads/pull/pending').set(auth);
    expect(pending.body.uploads.map((r: { id: string }) => r.id)).toEqual([wanted]);
    expect(pending.body.uploads[0].b2_path).toBe('vault/Areas/alex/vlogs/day 1.mp4');

    expect((await request(app).post(`/api/uploads/pull/${wanted}/done`).set(auth).send({ path: '/x' })).status).toBe(409); // not started
    expect((await request(app).post(`/api/uploads/pull/${wanted}/start`).set(auth)).status).toBe(200);
    expect((await request(app).get('/api/uploads/pull/pending').set(auth)).body.uploads).toEqual([]);
    expect((await request(app).post(`/api/uploads/pull/${wanted}/done`).set(auth).send({ path: '/Users/x/Movies/inbox/day 1.mp4' })).status).toBe(200);
    const row = (await request(app).get(`/api/uploads/${wanted}`)).body.upload;
    expect(row.m1_status).toBe('done');
    expect(row.m1_path).toBe('/Users/x/Movies/inbox/day 1.mp4');
  });

  it('a stored file can be sent to the M1 afterwards, and a failed pull can be asked again', async () => {
    const id = await stored(false);
    expect((await request(app).get('/api/uploads/pull/pending').set(auth)).body.uploads).toEqual([]);
    expect((await request(app).post(`/api/uploads/${id}/m1`).send({})).body.upload.m1_status).toBe('pending');
    await request(app).post(`/api/uploads/pull/${id}/start`).set(auth);
    await request(app).post(`/api/uploads/pull/${id}/fail`).set(auth).send({ error: 'disk full' });
    expect((await request(app).get(`/api/uploads/${id}`)).body.upload.m1_status).toBe('failed');
    expect((await request(app).post(`/api/uploads/${id}/m1`).send({})).body.upload.m1_status).toBe('pending');
  });
});
