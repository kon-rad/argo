import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { query, withTransaction } from '../src/db.js';
import { sha256 } from '../src/archive/clean.js';
import * as archive from '../src/archive/store.js';
import type { ParsedMessage, SessionInput } from '../src/archive/types.js';
import { ALL_MODULES, truncateAll } from './helpers.js';

const app = createApp({ modules: ALL_MODULES });

const sess: SessionInput = {
  source: 'claude-code', host: 'mac', externalId: 'sess-1', parentExternalId: null, project: 'p',
  title: 'Debug the guard hook', model: null, startedAt: null, endedAt: null, messageCount: null,
  inputTokens: null, outputTokens: null, costUsd: null, meta: {}, b2Path: null,
};
const msg = (seq: number, id: string, text: string): ParsedMessage => ({
  seq, externalId: id, parentExternalId: null, role: 'user', kind: 'user', ts: new Date('2026-10-18T10:00:00Z'),
  contentText: text, raw: { type: 'user', message: { content: text } }, rawSha: sha256(text), isSidechain: false,
});

beforeEach(async () => {
  await truncateAll();
  await query('TRUNCATE inventory_items RESTART IDENTITY');
  await query(`INSERT INTO inventory_items (name, brand, category, location) VALUES ('Oscilloscope', 'Rigol', 'test-gear', 'garage shelf')`);
  await query(`INSERT INTO vault_files (path,parent_path,name,title,ext,is_markdown,size_bytes,mtime,content_hash,body)
               VALUES ('n.md','','n.md','Garage tidy','.md',true,10,now(),'h','Sort the garage this weekend')`);
  await withTransaction(async (tx) => {
    const s = await archive.upsertSession(tx, sess);
    await archive.upsertMessages(tx, s.id, [
      msg(1, 'u1', 'why does the guard hook block <script>alert(1)</script> garage commands'),
      msg(2, 'u2', 'unrelated message about lunch'),
    ]);
  });
});

describe('GET /api/search/global', () => {
  it('returns one section per scope, each with its own hits', async () => {
    const res = await request(app).get('/api/search/global').query({ q: 'garage', mode: 'keyword' });
    expect(res.status).toBe(200);
    expect(res.body.notes.results[0].ref_path).toBe('n.md');
    expect(res.body.records.results[0]).toMatchObject({ table: 'inventory_items', title: 'Oscilloscope' });
    expect(res.body.agents.results).toHaveLength(1);
    expect(res.body.agents.results[0]).toMatchObject({ host: 'mac', external_id: 'sess-1', seq: 1, session_title: 'Debug the guard hook' });
  });

  it('escapes markup in agent snippets and highlights the match', async () => {
    const res = await request(app).get('/api/search/global').query({ q: 'garage', scopes: 'agents' });
    const snippet: string = res.body.agents.results[0].snippet;
    expect(snippet).toContain('<b>garage</b>');
    expect(snippet).not.toMatch(/<script/i);
    expect(res.body.notes).toBeUndefined();
  });

  it('keeps the other sections when one scope fails', async () => {
    const noProvider = createApp({ modules: ALL_MODULES, embeddingProvider: () => { throw new Error('no key'); } });
    const res = await request(noProvider).get('/api/search/global').query({ q: 'garage', mode: 'semantic' });
    expect(res.status).toBe(200);
    expect(res.body.notes.error).toMatch(/no key/);
    expect(res.body.records.results).toHaveLength(1);
    expect(res.body.agents.results).toHaveLength(1);
  });

  it('does not offer agent logs when neither agents nor usage is enabled', async () => {
    const core = createApp({ modules: new Set() });
    const res = await request(core).get('/api/search/global').query({ q: 'garage', mode: 'keyword', scopes: 'notes,agents' });
    expect(res.body.available).toEqual(['notes', 'records']);
    expect(res.body.agents).toBeUndefined();
  });

  it('rejects an unknown scope and an empty query', async () => {
    expect((await request(app).get('/api/search/global').query({ q: 'x', scopes: 'bank' })).status).toBe(400);
    expect((await request(app).get('/api/search/global').query({ q: ' ' })).status).toBe(400);
  });

  it('treats % and _ in a records query as literal characters', async () => {
    const res = await request(app).get('/api/search/global').query({ q: '%%', scopes: 'records' });
    expect(res.body.records.results).toHaveLength(0);
  });
});
