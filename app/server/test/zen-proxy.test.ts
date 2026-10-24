import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

/** /api/zen forwards to `zen-agent serve` the way /api/hub forwards to agent-hub: allowlist, token, no-store. */
const TOKEN = 'z'.repeat(40);
let zen: Server;
let zenUrl = '';
const seen: { method: string; url: string; auth: string; body: string }[] = [];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

beforeAll(async () => {
  zen = createServer(async (req, res) => {
    const body = await readBody(req);
    seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization ?? '', body });
    res.setHeader('Content-Type', 'application/json');
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: 'unauthorized' }));
    }
    if (req.url === '/zen/chats' && req.method === 'POST') {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: 'unknown model "nope/none"' }));
    }
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise<void>((r) => zen.listen(0, '127.0.0.1', r));
  zenUrl = `http://127.0.0.1:${(zen.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => zen.close(() => r())));

describe('/api/zen', () => {
  it('forwards allowed routes under /zen with the token and only the offset query key', async () => {
    const app = createApp({ deployment: 'local', zen: { url: zenUrl, token: TOKEN } });
    const res = await request(app).get('/api/zen/chats/0123456789ab/events?offset=7&evil=1').expect(200);
    expect(res.body).toEqual({ ok: true, path: '/zen/chats/0123456789ab/events?offset=7' });
    expect(seen.at(-1)!.auth).toBe(`Bearer ${TOKEN}`);
    expect(res.headers['cache-control']).toBe('no-store');
    await request(app).get('/api/zen/models').expect(200);
    expect(seen.at(-1)!.url).toBe('/zen/models');
  });

  it('forwards POST bodies (messages, steer, interrupt)', async () => {
    const app = createApp({ deployment: 'local', zen: { url: zenUrl, token: TOKEN } });
    await request(app).post('/api/zen/chats/0123456789ab/steer').send({ text: 'also the date' }).expect(200);
    expect(seen.at(-1)).toMatchObject({ method: 'POST', url: '/zen/chats/0123456789ab/steer', body: JSON.stringify({ text: 'also the date' }) });
    await request(app).post('/api/zen/chats/0123456789ab/interrupt').expect(200);
    await request(app).post('/api/zen/chats/0123456789ab/messages').send({ text: 'hi' }).expect(200);
  });

  it('refuses routes outside the allowlist and malformed ids', async () => {
    const app = createApp({ deployment: 'local', zen: { url: zenUrl, token: TOKEN } });
    const before = seen.length;
    await request(app).get('/api/zen/health').expect(404);
    await request(app).get('/api/zen/chats/zzz/events').expect(404);
    await request(app).post('/api/zen/chats/0123456789ab/settings').send({}).expect(404);
    await request(app).delete('/api/zen/chats/0123456789ab').expect(404);
    expect(seen.length).toBe(before);
  });

  it("passes the host's errors through in the app's shape", async () => {
    const app = createApp({ deployment: 'local', zen: { url: zenUrl, token: TOKEN } });
    const res = await request(app).post('/api/zen/chats').send({ model: 'nope/none' }).expect(400);
    expect(res.body.error.message).toBe('unknown model "nope/none"');
  });

  it('a token mismatch is a server fault (502)', async () => {
    const app = createApp({ deployment: 'local', zen: { url: zenUrl, token: 'w'.repeat(40) } });
    await request(app).get('/api/zen/chats').expect(502);
  });

  it('answers 503 with the variables to set where no host is configured', async () => {
    const app = createApp({ deployment: 'local', zen: {} });
    const res = await request(app).get('/api/zen/chats').expect(503);
    expect(res.body.error.message).toMatch(/ZEN_AGENT_URL/);
  });

  it('is not mounted when the agents module is off', async () => {
    const app = createApp({ deployment: 'local', zen: { url: zenUrl, token: TOKEN }, modules: new Set() });
    await request(app).get('/api/zen/chats').expect(404);
  });
});
