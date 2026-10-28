import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { parseModules } from '../src/config.js';

describe('optional modules', () => {
  it('parses a comma list and drops unknown names', () => {
    expect([...parseModules('ring, agents ,bogus,')]).toEqual(['ring', 'agents']);
    expect([...parseModules('tv,map,org,projects,usage,voice,livestream,media,social')]).toEqual(['projects', 'org', 'usage', 'map', 'tv', 'voice', 'livestream', 'media', 'social']);
    expect([...parseModules('fund,bogus')]).toEqual(['fund']);
    expect([...parseModules('chat')]).toEqual(['chat']);
    expect(parseModules('').size).toBe(0);
  });

  it('a module that is off mounts no API routes', async () => {
    const app = createApp({ modules: new Set() });
    const paths = [
      '/api/ring', '/api/agents/chats', '/api/hub/telegram', '/api/usage/plan', '/api/projects/report',
      '/api/feed/projects', '/api/org/channels', '/api/map/graph', '/api/tv/episodes', '/api/voice/status', '/api/media',
      '/api/social/accounts', '/api/fund', '/api/chat/options', '/api/uploads/config',
    ];
    for (const path of paths) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(404);
      expect(res.body.error?.message, path).toBe('no such endpoint');
    }
  });

  it('a module that is on is mounted', async () => {
    const app = createApp({
      modules: new Set(['ring', 'agents']),
      hub: { url: undefined, token: undefined },
      timers: async () => ({ available: false, timers: [] }),
    });
    expect((await request(app).get('/api/ring')).status).toBe(200);
    expect((await request(app).get('/api/agents/chats')).status).toBe(200);
    expect((await request(app).get('/api/hub/telegram')).body.error?.message).not.toBe('no such endpoint');
  });

  it('/api/meta tells the web app which modules and links to show', async () => {
    const app = createApp({ modules: new Set(['ring']) });
    const res = await request(app).get('/api/meta');
    expect(res.status).toBe(200);
    expect(res.body.modules).toEqual(['ring']);
    expect(typeof res.body.owner).toBe('string');
    expect(res.body).toHaveProperty('devLogPath');
    expect(res.body).toHaveProperty('docsPath');
  });

  it('/api/meta carries the version and commit the running copy was built from', async () => {
    const app = createApp({
      modules: new Set(['ring']),
      buildInfo: { version: '1.2.3', commit: 'abcdef1234567890', commitShort: 'abcdef1', builtAt: '2026-10-23T17:40:00Z' },
    });
    const res = await request(app).get('/api/meta');
    expect(res.body).toMatchObject({
      version: '1.2.3',
      commit: 'abcdef1234567890',
      commitShort: 'abcdef1',
      builtAt: '2026-10-23T17:40:00Z',
    });
  });

  it('wallets are not part of the engine', async () => {
    const res = await request(createApp({ modules: new Set(['ring', 'agents']) })).get('/api/wallets');
    expect(res.status).toBe(404);
  });
});
