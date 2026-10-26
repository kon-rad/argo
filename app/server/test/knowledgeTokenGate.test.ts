import { describe, it, expect } from 'vitest';
import type { Request, Response } from 'express';
import { knowledgeTokenGate, READ_PATHS } from '../src/auth/knowledgeToken.js';

const TOKEN = 'a'.repeat(48);

function run(over: { method?: string; path?: string; auth?: string | undefined; addr?: string; headers?: Record<string, string>; token?: string | undefined }) {
  const req = {
    method: over.method ?? 'GET',
    path: over.path ?? '/search',
    headers: { host: '127.0.0.1:5123', ...(over.auth !== undefined ? { authorization: over.auth } : { authorization: `Bearer ${TOKEN}` }), ...(over.headers ?? {}) },
    socket: { remoteAddress: over.addr ?? '127.0.0.1' },
  } as unknown as Request;
  const res = { locals: {} as Record<string, unknown> } as unknown as Response;
  let nexted = 0;
  knowledgeTokenGate('token' in over ? over.token : TOKEN)(req, res, () => void nexted++);
  return { flagged: res.locals.knowledgeToken === true, nexted };
}

describe('knowledgeTokenGate', () => {
  it('flags a good token on each of the three read paths, from loopback, and always calls next', () => {
    for (const path of READ_PATHS) expect(run({ path })).toEqual({ flagged: true, nexted: 1 });
    expect([...READ_PATHS].sort()).toEqual(['/file/source', '/search', '/search/global']);
  });

  it('accepts the IPv6 loopback forms', () => {
    expect(run({ addr: '::1' }).flagged).toBe(true);
    expect(run({ addr: '::ffff:127.0.0.1' }).flagged).toBe(true);
  });

  it('does nothing for a wrong, missing or malformed token', () => {
    expect(run({ auth: 'Bearer nope' }).flagged).toBe(false);
    expect(run({ auth: `Bearer ${TOKEN}x` }).flagged).toBe(false);
    expect(run({ auth: TOKEN }).flagged).toBe(false); // no "Bearer "
    expect(run({ auth: 'Basic abc' }).flagged).toBe(false);
  });

  it('never opens a write, another method, or a path outside the three', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(run({ method, path: '/file/source' }).flagged).toBe(false);
    for (const path of ['/tree', '/file', '/raw', '/search/', '/search/x', '/db', '/board', '/projects', '/auth/login', '/file/source/extra']) {
      expect(run({ path }).flagged).toBe(false);
    }
  });

  it('refuses a request that did not come from this machine, even with the right token', () => {
    expect(run({ addr: '203.0.113.9' }).flagged).toBe(false);
    expect(run({ addr: '' }).flagged).toBe(false);
  });

  it('refuses a request that came through a proxy, even from loopback (Caddy adds a forwarding header)', () => {
    for (const h of ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'forwarded', 'x-real-ip']) {
      expect(run({ headers: { [h]: '203.0.113.9' } }).flagged).toBe(false);
    }
  });

  it('refuses a request whose Host is not a loopback name, even with no forwarding header (a relay that stripped them)', () => {
    for (const host of ['sb.example.com', 'sb.example.com:443', '127.0.0.1.evil.example', 'localhost.example.com', '203.0.113.9:5123', '']) {
      expect(run({ headers: { host } }).flagged).toBe(false);
    }
    for (const host of ['127.0.0.1', '127.0.0.1:5123', 'localhost:3000', 'LOCALHOST', '[::1]:5123']) {
      expect(run({ headers: { host } }).flagged).toBe(true);
    }
  });

  it('is a no-op when no token is configured', () => {
    expect(run({ token: undefined })).toEqual({ flagged: false, nexted: 1 });
  });
});
