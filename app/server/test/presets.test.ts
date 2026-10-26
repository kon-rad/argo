import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { query } from '../src/db.js';

/** /api/presets stores the Chat tab's saved launch settings; it validates the shape and never calls the hub. */
const app = createApp();

beforeEach(async () => {
  await query('TRUNCATE chat_presets');
});

describe('/api/presets', () => {
  it('starts empty, then lists what was saved', async () => {
    expect((await request(app).get('/api/presets')).body).toEqual({ presets: [] });
    const put = await request(app).put('/api/presets/default').send({ harness: 'zen-agent', config: { persona: 'ops-lead', model: 'anthropic/claude-sonnet-4-6', tools: 'read-only', thinking: 'low' } });
    expect(put.status).toBe(200);
    const list = await request(app).get('/api/presets');
    expect(list.headers['cache-control']).toBe('no-store');
    expect(list.body.presets).toHaveLength(1);
    expect(list.body.presets[0]).toMatchObject({ name: 'default', harness: 'zen-agent', config: { persona: 'ops-lead', tools: 'read-only' } });
  });

  it('replaces a preset in place, including switching harness', async () => {
    await request(app).put('/api/presets/default').send({ harness: 'zen-agent', config: { persona: 'ops-lead' } });
    await request(app).put('/api/presets/default').send({ harness: 'claude-code', config: { model: 'sonnet', role: 'ops-lead' } });
    const { body } = await request(app).get('/api/presets');
    expect(body.presets).toHaveLength(1);
    expect(body.presets[0]).toMatchObject({ harness: 'claude-code', config: { model: 'sonnet', role: 'ops-lead' } });
  });

  it.each([
    ['an unknown harness', { harness: 'hermes', config: {} }],
    ['an unknown key', { harness: 'zen-agent', config: { apiKey: 'sk-pasted' } }],
    ['a Claude model that is not offered', { harness: 'claude-code', config: { model: 'gpt-5' } }],
    ['a zen model without a provider', { harness: 'zen-agent', config: { model: 'just-a-model' } }],
    ['a tools value outside full and read-only', { harness: 'zen-agent', config: { tools: 'shell' } }],
    ['a role that is not a name', { harness: 'claude-code', config: { role: '../etc/passwd' } }],
  ])('rejects %s', async (_what, body) => {
    const r = await request(app).put('/api/presets/default').send(body);
    expect(r.status).toBe(400);
    expect((await request(app).get('/api/presets')).body.presets).toEqual([]);
  });

  it('rejects a preset name that is not a slug', async () => {
    const r = await request(app).put('/api/presets/Bad_Name').send({ harness: 'claude-code', config: {} });
    expect(r.status).toBe(400);
  });

  it('keeps several presets and deletes one by name', async () => {
    await request(app).put('/api/presets/coo').send({ harness: 'zen-agent', config: { persona: 'ops-lead' } });
    await request(app).put('/api/presets/quick').send({ harness: 'claude-code', config: { model: 'haiku' } });
    expect((await request(app).get('/api/presets')).body.presets.map((p: { name: string }) => p.name)).toEqual(['coo', 'quick']);
    expect((await request(app).delete('/api/presets/coo')).status).toBe(200);
    expect((await request(app).get('/api/presets')).body.presets.map((p: { name: string }) => p.name)).toEqual(['quick']);
    expect((await request(app).delete('/api/presets/coo')).status).toBe(404);
  });
});
