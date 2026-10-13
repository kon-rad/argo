import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const TOKEN = 'h'.repeat(40);
let hub: Server;
let hubUrl = '';
const seen: { method: string; url: string; auth: string; body: string }[] = [];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

beforeAll(async () => {
  hub = createServer(async (req, res) => {
    const body = await readBody(req);
    seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization ?? '', body });
    res.setHeader('Content-Type', 'application/json');
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: 'unauthorized' }));
    }
    if (req.url === '/tasks' && req.method === 'POST') {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "unknown agent 'nobody'" }));
    }
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise<void>((r) => hub.listen(0, '127.0.0.1', r));
  hubUrl = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => hub.close(() => r())));

describe('/api/hub', () => {
  it('forwards allowed routes with the token and only known query keys', async () => {
    const app = createApp({ deployment: 'local', hub: { url: hubUrl, token: TOKEN } });
    const res = await request(app).get('/api/hub/board?board=exo&evil=1').expect(200);
    expect(res.body).toEqual({ ok: true, path: '/board?board=exo' });
    expect(seen.at(-1)!.auth).toBe(`Bearer ${TOKEN}`);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('forwards POST bodies', async () => {
    const app = createApp({ deployment: 'local', hub: { url: hubUrl, token: TOKEN } });
    await request(app).post('/api/hub/telegram').send({ default: 'hermes' }).expect(200);
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({ default: 'hermes' });
  });

  it('refuses routes outside the allowlist and malformed ids', async () => {
    const app = createApp({ deployment: 'local', hub: { url: hubUrl, token: TOKEN } });
    const before = seen.length;
    await request(app).get('/api/hub/health').expect(404);
    await request(app).get('/api/hub/tasks/../../etc/passwd').expect(404);
    await request(app).post('/api/hub/chats/zzz/messages').send({ text: 'x' }).expect(404);
    await request(app).delete('/api/hub/chats').expect(404);
    expect(seen.length).toBe(before);
  });

  it("passes the hub's errors through in the app's shape", async () => {
    const app = createApp({ deployment: 'local', hub: { url: hubUrl, token: TOKEN } });
    const res = await request(app).post('/api/hub/tasks').send({ title: 'x', assignee: 'nobody' }).expect(400);
    expect(res.body.error.message).toBe("unknown agent 'nobody'");
  });

  it('a token mismatch is a server fault (502), not an expired browser session', async () => {
    const app = createApp({ deployment: 'local', hub: { url: hubUrl, token: 'w'.repeat(40) } });
    await request(app).get('/api/hub/agents').expect(502);
  });

  it('answers 503 where no hub is configured (the Mac)', async () => {
    const app = createApp({ deployment: 'local', hub: {} });
    const res = await request(app).get('/api/hub/board').expect(503);
    expect(res.body.error.message).toMatch(/droplet/);
  });

  it('answers 502 when the hub is down', async () => {
    const app = createApp({ deployment: 'local', hub: { url: 'http://127.0.0.1:9', token: TOKEN, timeoutMs: 2000 } });
    await request(app).get('/api/hub/agents').expect(502);
  });
});
