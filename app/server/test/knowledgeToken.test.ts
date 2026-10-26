import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth/password.js';
import { generateSecret } from '../src/auth/totp.js';

const ORIGIN = 'https://sb.test';
const TOKEN = 'k'.repeat(48);
let root: string;

function makeApp(knowledgeToken: string | undefined) {
  return createApp({
    vaultRoot: root,
    deployment: 'server',
    knowledgeToken,
    auth: { passwordHash: hashPassword('pw-for-test-only'), totpSecret: generateSecret(), publicOrigin: ORIGIN, secureCookie: false },
  });
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'sb-knowledge-token-'));
  await writeFile(join(root, 'note.md'), '# Note\nhello\n');
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('the knowledge token through the real app', () => {
  it('lets the token through on the read paths, from loopback', async () => {
    const app = makeApp(TOKEN);
    const res = await request(app).get('/api/search').query({ q: 'hello' }).set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.results)).toBe(true);
    // the note is not indexed in this test database, so the route answers 404: past the login gate, which is the point
    expect((await request(app).get('/api/file/source').query({ path: 'note.md' }).set('Authorization', `Bearer ${TOKEN}`)).status).not.toBe(401);
  });

  it('still needs a session without it, with a wrong token, and with no token configured', async () => {
    expect((await request(makeApp(TOKEN)).get('/api/search').query({ q: 'hello' })).status).toBe(401);
    expect((await request(makeApp(TOKEN)).get('/api/search').query({ q: 'hello' }).set('Authorization', 'Bearer wrong')).status).toBe(401);
    expect((await request(makeApp(undefined)).get('/api/search').query({ q: 'hello' }).set('Authorization', `Bearer ${TOKEN}`)).status).toBe(401);
  });

  it('opens nothing else: other API paths, and any request that came through a proxy', async () => {
    const app = makeApp(TOKEN);
    const auth = { Authorization: `Bearer ${TOKEN}` };
    expect((await request(app).get('/api/tree').set(auth)).status).toBe(401);
    expect((await request(app).get('/api/file').query({ path: 'note.md' }).set(auth)).status).toBe(401);
    expect((await request(app).get('/api/search').query({ q: 'hello' }).set(auth).set('X-Forwarded-For', '203.0.113.9')).status).toBe(401);
    // a relay that stripped every forwarding header still carries the public hostname
    expect((await request(app).get('/api/search').query({ q: 'hello' }).set(auth).set('Host', 'sb.example.com')).status).toBe(401);
  });

  it('never opens a write or another method on the same paths, and not look-alike paths', async () => {
    const app = makeApp(TOKEN);
    const auth = { Authorization: `Bearer ${TOKEN}` };
    for (const res of [
      await request(app).put('/api/file/source').set(auth).send({ path: 'note.md', content: 'x' }),
      await request(app).post('/api/search').set(auth).send({ q: 'hello' }),
      await request(app).delete('/api/file/source').set(auth),
    ]) expect([401, 403]).toContain(res.status);
    for (const path of ['/api/search/', '/api/Search', '/api//search', '/api/search/..%2Ftree']) {
      expect((await request(app).get(path).query({ q: 'hello' }).set(auth)).status).toBe(401);
    }
    expect((await request(app).head('/api/search').query({ q: 'hello' }).set(auth)).status).toBe(401);
  });
});
