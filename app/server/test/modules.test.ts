import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { parseModules } from '../src/config.js';

describe('optional modules', () => {
  it('parses a comma list and drops unknown names', () => {
    expect([...parseModules('ring, agents ,bogus,')]).toEqual(['ring', 'agents']);
    expect([...parseModules('tv,map,org,projects,usage,voice,livestream')]).toEqual(['projects', 'org', 'usage', 'map', 'tv', 'voice', 'livestream']);
    expect(parseModules('').size).toBe(0);
  });

  it('a module that is off mounts no API routes', async () => {
    const app = createApp({ modules: new Set() });
    const paths = [
      '/api/ring', '/api/agents/chats', '/api/hub/telegram', '/api/usage/plan', '/api/projects/report',
      '/api/feed/projects', '/api/org/channels', '/api/map/graph', '/api/tv/episodes', '/api/voice/status',
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

  it('wallets are not part of the engine', async () => {
    const res = await request(createApp({ modules: new Set(['ring', 'agents']) })).get('/api/wallets');
    expect(res.status).toBe(404);
  });
});
