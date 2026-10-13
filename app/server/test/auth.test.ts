import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { LoginLimiter } from '../src/auth/limiter.js';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { base32Decode, base32Encode, codeAt, currentStep, generateSecret, verifyTotp } from '../src/auth/totp.js';
import { scanVault } from '../src/connectors/vault/scan.js';
import { query } from '../src/db.js';
import { truncateAll, vaultSourceId } from './helpers.js';

const ORIGIN = 'https://sb.test';
const PASSWORD = 'correct horse battery staple';
const SECRET = generateSecret();

let root: string;
let passwordHash: string;
let clock = Date.now();

function makeApp(limiter = new LoginLimiter()) {
  return createApp({
    vaultRoot: root,
    deployment: 'server',
    auth: { passwordHash, totpSecret: SECRET, publicOrigin: ORIGIN, secureCookie: false, limiter, now: () => clock },
  });
}

/** A fresh code each call: the replay guard rejects a step it has already seen. */
function nextCode(): string {
  clock += 30_000;
  return codeAt(SECRET, currentStep(clock));
}

async function login(app: ReturnType<typeof createApp>): Promise<string> {
  const res = await request(app)
    .post('/api/auth/login')
    .set('Origin', ORIGIN)
    .send({ password: PASSWORD, code: nextCode() });
  expect(res.status).toBe(200);
  const cookie = res.headers['set-cookie']?.[0];
  expect(cookie).toMatch(/HttpOnly/i);
  expect(cookie).toMatch(/SameSite=Strict/i);
  return cookie!.split(';')[0]!;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'auth-'));
  await mkdir(join(root, 'notes'), { recursive: true });
  await writeFile(join(root, 'notes/a.md'), '# A\n\nhello\n');
  await truncateAll();
  await scanVault({ root, sourceId: await vaultSourceId() });
  passwordHash = await hashPassword(PASSWORD);
});

beforeEach(async () => {
  await query('TRUNCATE auth_sessions, auth_totp_state');
});

afterAll(() => rm(root, { recursive: true, force: true }));

describe('password hashing', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    expect(await verifyPassword(PASSWORD, passwordHash)).toBe(true);
    expect(await verifyPassword(PASSWORD + '!', passwordHash)).toBe(false);
    expect(await verifyPassword(PASSWORD, 'garbage')).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashPassword('x'.repeat(16))).not.toBe(await hashPassword('x'.repeat(16)));
  });
});

describe('totp', () => {
  it('matches the RFC 6238 SHA-1 test vector', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    // T = 59 s → step 1 → 94287082, of which authenticators show the last 6.
    expect(codeAt(secret, 1)).toBe('287082');
    expect(codeAt(secret, Math.floor(1111111109 / 30))).toBe('081804');
  });

  it('round-trips base32', () => {
    const buf = Buffer.from([0, 1, 2, 250, 251, 255, 7]);
    expect(base32Decode(base32Encode(buf))).toEqual(buf);
  });

  it('accepts ±1 step and nothing wider', () => {
    const now = 1_700_000_000_000;
    const step = currentStep(now);
    expect(verifyTotp(SECRET, codeAt(SECRET, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(SECRET, codeAt(SECRET, step + 1), now)).toBe(step + 1);
    expect(verifyTotp(SECRET, codeAt(SECRET, step - 2), now)).toBeNull();
    expect(verifyTotp(SECRET, 'abcdef', now)).toBeNull();
  });
});

describe('server deployment', () => {
  it('refuses every data route without a session', async () => {
    const app = makeApp();
    for (const path of ['/api/tree', '/api/file?path=notes/a.md', '/api/raw?path=notes/a.md', '/api/search?q=hello', '/api/system', '/api/sources']) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(401);
    }
    expect((await request(app).get('/api/health')).status).toBe(200);
    expect((await request(app).get('/api/auth/me')).body).toEqual({ required: true, authenticated: false });
  });

  it('logs in with password + code and then serves data', async () => {
    const app = makeApp();
    const cookie = await login(app);
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).body.authenticated).toBe(true);
    const res = await request(app).get('/api/tree').set('Cookie', cookie);
    expect(res.status).toBe(200);
    // The DB never holds the token itself.
    const { rows } = await query<{ token_hash: string }>('SELECT token_hash FROM auth_sessions');
    expect(rows).toHaveLength(1);
    expect(cookie).not.toContain(rows[0]!.token_hash);
  });

  it('rejects a wrong password, a wrong code, and says the same thing for both', async () => {
    const app = makeApp();
    const badPw = await request(app).post('/api/auth/login').set('Origin', ORIGIN).send({ password: 'nope', code: nextCode() });
    const badCode = await request(app).post('/api/auth/login').set('Origin', ORIGIN).send({ password: PASSWORD, code: '000000' });
    expect(badPw.status).toBe(401);
    expect(badCode.status).toBe(401);
    expect(badPw.body).toEqual(badCode.body);
    expect(badPw.headers['set-cookie']).toBeUndefined();
  });

  it('never accepts the same code twice', async () => {
    const app = makeApp();
    const code = nextCode();
    const first = await request(app).post('/api/auth/login').set('Origin', ORIGIN).send({ password: PASSWORD, code });
    const replay = await request(app).post('/api/auth/login').set('Origin', ORIGIN).send({ password: PASSWORD, code });
    expect(first.status).toBe(200);
    expect(replay.status).toBe(401);
  });

  it('locks an IP out after five failures', async () => {
    const app = makeApp(new LoginLimiter({ perIpMax: 5, perIpWindowMs: 60_000, globalMax: 1000, globalWindowMs: 60_000 }));
    for (let i = 0; i < 5; i++) {
      await request(app).post('/api/auth/login').set('Origin', ORIGIN).send({ password: 'nope', code: '000000' });
    }
    const res = await request(app).post('/api/auth/login').set('Origin', ORIGIN).send({ password: PASSWORD, code: nextCode() });
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('refuses cross-origin writes, login included', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/auth/login').set('Origin', 'https://evil.test').send({ password: PASSWORD, code: nextCode() });
    expect(res.status).toBe(403);
    const cookie = await login(app);
    const put = await request(app).put('/api/file/source').set('Cookie', cookie).set('Origin', 'https://evil.test').send({});
    expect(put.status).toBe(403);
  });

  it('logout ends the session server-side', async () => {
    const app = makeApp();
    const cookie = await login(app);
    await request(app).post('/api/auth/logout').set('Origin', ORIGIN).set('Cookie', cookie);
    expect((await request(app).get('/api/tree').set('Cookie', cookie)).status).toBe(401);
  });

  it('logout-all ends every device', async () => {
    const app = makeApp();
    const phone = await login(app);
    const laptop = await login(app);
    const res = await request(app).post('/api/auth/logout-all').set('Origin', ORIGIN).set('Cookie', laptop);
    expect(res.body.ended).toBe(2);
    expect((await request(app).get('/api/tree').set('Cookie', phone)).status).toBe(401);
  });

  it('expires an idle session', async () => {
    const app = makeApp();
    const cookie = await login(app);
    await query(`UPDATE auth_sessions SET last_seen_at = now() - interval '8 days'`);
    expect((await request(app).get('/api/tree').set('Cookie', cookie)).status).toBe(401);
  });

  it('does not mount the Mac-only routes', async () => {
    const app = makeApp();
    const cookie = await login(app);
    expect((await request(app).get('/api/friendly/status').set('Cookie', cookie)).status).toBe(404);
    expect((await request(app).post('/api/shutdown').set('Origin', ORIGIN).set('Cookie', cookie)).status).toBe(501);
  });
});

describe('local deployment', () => {
  it('needs no login and says so', async () => {
    const app = createApp({ vaultRoot: root, deployment: 'local' });
    expect((await request(app).get('/api/auth/me')).body).toEqual({ required: false, authenticated: true });
    expect((await request(app).get('/api/tree')).status).toBe(200);
  });
});
