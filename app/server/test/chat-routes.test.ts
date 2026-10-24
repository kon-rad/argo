import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { query } from '../src/db.js';
import { embedVault } from '../src/embeddings/embed.js';
import type { ProviderCatalog } from '../src/llm/registry.js';
import type { ChatEvent, ChatProvider, ChatRequest } from '../src/llm/types.js';
import { importOrg } from '../src/org.js';
import { fakeProvider } from './embedProvider.js';
import { truncateAll } from './helpers.js';

const CATALOG: ProviderCatalog = {
  defaultProvider: 'anthropic',
  systemPrompt: 'BASE PROMPT',
  providers: [
    { id: 'anthropic', label: 'Anthropic', configured: false, env: 'ANTHROPIC_API_KEY', default: 'claude-opus-5-5', models: [{ id: 'claude-opus-5-5' }] },
    { id: 'together', label: 'Together', configured: true, env: 'TOGETHER_API_KEY', default: 'm1', models: [{ id: 'm1' }, { id: 'm2' }] },
  ],
};

const asked: { id: string; model: string; req: ChatRequest }[] = [];
let answer = 'The electric one [1].';
let fail = false;

function fakeModel(id: string, model: string): ChatProvider {
  return {
    id,
    model,
    async *stream(req: ChatRequest): AsyncGenerator<ChatEvent> {
      asked.push({ id, model, req });
      // The condenser's call answers with JSON; the answer call with prose.
      if (req.system?.includes('search queries')) {
        yield { type: 'delta', text: '{"query":"garage heater choice","alternates":[]}' };
        yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'stop' };
        return;
      }
      if (fail) throw new Error('model exploded');
      for (const piece of answer.split(' ')) yield { type: 'delta', text: `${piece} ` };
      yield { type: 'done', usage: { inputTokens: 100, outputTokens: 5 }, stopReason: 'stop' };
    },
  };
}

const vaultRoot = mkdtempSync(join(tmpdir(), 'sb-chat-'));
mkdirSync(join(vaultRoot, '.claude', 'agents'), { recursive: true });
writeFileSync(join(vaultRoot, '.claude', 'agents', 'ada.md'), '---\nname: ada\n---\nYou are Ada, the careful researcher.\n');

const app = createApp({
  modules: new Set(['chat', 'org']),
  vaultRoot,
  embeddingProvider: () => fakeProvider(),
  chat: { catalog: () => CATALOG, buildProvider: fakeModel, reranker: () => null },
});

/** Parses a buffered SSE body into [event, data] pairs. */
function events(text: string): [string, Record<string, unknown>][] {
  return text
    .split('\n\n')
    .filter((b) => b.trim())
    .map((block) => {
      const ev = /^event: (.*)$/m.exec(block)![1]!;
      const data = /^data: (.*)$/m.exec(block)![1]!;
      return [ev, JSON.parse(data) as Record<string, unknown>];
    });
}

beforeEach(async () => {
  await truncateAll();
  asked.length = 0;
  answer = 'The electric one [1].';
  fail = false;
  await query(
    `INSERT INTO vault_files (path,parent_path,name,title,ext,is_markdown,size_bytes,mtime,content_hash,body)
     VALUES ('heater.md','','heater.md','Garage Heater','.md',true,80,now(),'h1','## Decision\n\nWe picked the electric unit over diesel: cheaper to run and no fumes.')`,
  );
  await embedVault({ provider: fakeProvider(), maxChunkTokens: 200, overlapTokens: 20, batchSize: 8 });
});

describe('GET /api/chat/options', () => {
  it('lists providers with their configured flag, the personas, and the resolved settings', async () => {
    const res = await request(app).get('/api/chat/options');
    expect(res.status).toBe(200);
    expect(res.body.providers.map((p: { id: string; configured: boolean }) => [p.id, p.configured])).toEqual([['anthropic', false], ['together', true]]);
    expect(res.body.personas[0]).toMatchObject({ id: 'default', builtin: true });
    // The default provider has no key here, so the settings resolve to the one that does.
    expect(res.body.settings.resolved).toMatchObject({ provider: 'together', model: 'm1', system_prompt: 'BASE PROMPT', embeddings: true });
    expect(res.body.embeddings.chunks).toBeGreaterThan(0);
    expect(res.body.default_system_prompt).toBe('BASE PROMPT');
  });

  it('lists the org agents as personas once an org is imported', async () => {
    await importOrg({
      version: '1', company: 'Test Co', ceo: 'owner',
      agents: { owner: { runtime: 'human', role: 'Owner' }, ada: { role: 'Researcher', team: 'research', reports_to: 'owner', expertise: 'papers' } },
      teams: { research: { name: 'Research', lead: 'ada' } },
      channels: {},
    });
    const res = await request(app).get('/api/chat/options');
    expect(res.body.personas.map((p: { id: string }) => p.id)).toEqual(['default', 'ada']);
    expect(res.body.personas[1]).toMatchObject({ role: 'Researcher', team: 'research', builtin: false });
  });
});

describe('settings', () => {
  it('stores a patch, merges retrieval knobs, and resolves the model', async () => {
    const put = await request(app).put('/api/chat/settings').send({ provider: 'together', model: 'm2', retrieval: { top_k: 3 } });
    expect(put.status).toBe(200);
    expect(put.body.settings).toMatchObject({ provider: 'together', model: 'm2', retrieval: { top_k: 3, multi_query: true, rerank: false } });
    expect(put.body.settings.resolved).toMatchObject({ provider: 'together', model: 'm2' });

    const again = await request(app).put('/api/chat/settings').send({ system_prompt: 'MINE' });
    expect(again.body.settings).toMatchObject({ model: 'm2', system_prompt: 'MINE', retrieval: { top_k: 3 } });
    expect(again.body.settings.resolved.system_prompt).toBe('MINE');

    const get = await request(app).get('/api/chat/settings');
    expect(get.body.settings.system_prompt).toBe('MINE');
  });

  it('rejects an unknown provider, an unknown persona and an unknown key', async () => {
    expect((await request(app).put('/api/chat/settings').send({ provider: 'nope' })).status).toBe(400);
    expect((await request(app).put('/api/chat/settings').send({ persona: 'ghost' })).status).toBe(400);
    expect((await request(app).put('/api/chat/settings').send({ bogus: 1 })).status).toBe(400);
  });

  it('a model chosen for another provider is not carried over to the one that answers', async () => {
    await request(app).put('/api/chat/settings').send({ provider: 'anthropic', model: 'claude-opus-5-5' });
    const res = await request(app).get('/api/chat/settings');
    expect(res.body.settings.resolved).toMatchObject({ provider: 'together', model: 'm1' });
  });
});

describe('conversations', () => {
  it('creates, lists, renames and deletes', async () => {
    const created = await request(app).post('/api/chat/conversations').send({});
    expect(created.status).toBe(201);
    const id = created.body.conversation.id as number;
    expect(created.body.conversation).toMatchObject({ title: 'New conversation', persona: 'default', message_count: 0 });

    const list = await request(app).get('/api/chat/conversations');
    expect(list.body.conversations.map((c: { id: number }) => c.id)).toEqual([id]);

    const renamed = await request(app).patch(`/api/chat/conversations/${id}`).send({ title: 'Heaters' });
    expect(renamed.body.conversation.title).toBe('Heaters');

    expect((await request(app).get(`/api/chat/conversations/${id}`)).body.messages).toEqual([]);
    expect((await request(app).delete(`/api/chat/conversations/${id}`)).status).toBe(204);
    expect((await request(app).get(`/api/chat/conversations/${id}`)).status).toBe(404);
  });

  it('refuses a persona that does not exist', async () => {
    expect((await request(app).post('/api/chat/conversations').send({ persona: 'ghost' })).status).toBe(400);
  });
});

describe('POST /api/chat/conversations/:id/messages', () => {
  it('streams the sources, the answer and a done event, and stores both turns with the sources', async () => {
    const { body: { conversation } } = await request(app).post('/api/chat/conversations').send({});
    const res = await request(app)
      .post(`/api/chat/conversations/${conversation.id}/messages`)
      .send({ content: 'Which heater did I pick for the garage, diesel or electric?' })
      .buffer(true)
      .parse((r, cb) => {
        let text = '';
        r.setEncoding('utf8');
        r.on('data', (c: string) => (text += c));
        r.on('end', () => cb(null, text));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    const evs = events(res.body as string);
    expect(evs[0]![0]).toBe('sources');
    const sources = evs[0]![1]['sources'] as { n: number; path: string; snippet: string }[];
    expect(sources[0]).toMatchObject({ n: 1, path: 'heater.md' });
    expect(sources[0]!.snippet).toContain('electric');
    expect(evs[0]![1]).toMatchObject({ vector: true, keyword: true, reranked: false });

    const deltas = evs.filter(([e]) => e === 'delta').map(([, d]) => d['text']).join('');
    expect(deltas.trim()).toBe('The electric one [1].');
    const done = evs[evs.length - 1]!;
    expect(done[0]).toBe('done');
    expect(done[1]['message']).toMatchObject({ role: 'assistant', sources: [expect.objectContaining({ path: 'heater.md' })] });
    expect((done[1]['conversation'] as { title: string; message_count: number }).title).toBe('Which heater did I pick for the garage, diesel or electric?');
    expect((done[1]['conversation'] as { message_count: number }).message_count).toBe(2);

    // The answer call carried the base prompt, the passages and the question; no condensing on a first turn
    // without alternates... but multi_query is on by default, so the condenser ran once.
    const answerCall = asked.find((a) => !a.req.system?.includes('search queries'))!;
    expect(answerCall.model).toBe('m1');
    expect(answerCall.req.system).toContain('BASE PROMPT');
    expect(answerCall.req.system).toContain('[1] Garage Heater (heater.md › Decision)');
    expect(answerCall.req.messages.at(-1)).toEqual({ role: 'user', content: 'Which heater did I pick for the garage, diesel or electric?' });

    const stored = await request(app).get(`/api/chat/conversations/${conversation.id}`);
    expect(stored.body.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
    expect(stored.body.messages[1].meta).toMatchObject({ provider: 'together', model: 'm1', persona: 'default', usage: { input_tokens: 100 } });
  });

  it('sends the history on a follow-up and lets a message override the model', async () => {
    const { body: { conversation } } = await request(app).post('/api/chat/conversations').send({});
    await request(app).post(`/api/chat/conversations/${conversation.id}/messages`).send({ content: 'Which heater?' });
    asked.length = 0;
    await request(app).post(`/api/chat/conversations/${conversation.id}/messages`).send({ content: 'why?', model: 'm2' });
    const answerCall = asked.find((a) => !a.req.system?.includes('search queries'))!;
    expect(answerCall.model).toBe('m2');
    expect(answerCall.req.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    // The condenser saw the earlier turn.
    const condense = asked.find((a) => a.req.system?.includes('search queries'))!;
    expect(condense.req.messages[0]!.content).toContain('Which heater?');
  });

  it('appends the persona definition to the system prompt', async () => {
    await importOrg({
      version: '1', company: 'Test Co', ceo: 'owner',
      agents: { owner: { runtime: 'human', role: 'Owner' }, ada: { role: 'Researcher', team: 'research', reports_to: 'owner' } },
      teams: { research: { name: 'Research', lead: 'ada' } },
      channels: {},
    });
    const { body: { conversation } } = await request(app).post('/api/chat/conversations').send({ persona: 'ada' });
    await request(app).post(`/api/chat/conversations/${conversation.id}/messages`).send({ content: 'Which heater?' });
    const answerCall = asked.find((a) => !a.req.system?.includes('search queries'))!;
    expect(answerCall.req.system).toContain('You answer as ada (Researcher)');
    expect(answerCall.req.system).toContain('You are Ada, the careful researcher.');
    expect(answerCall.req.system).not.toContain('name: ada');
  });

  it('reports a model failure as an error event and keeps the turn', async () => {
    fail = true;
    const { body: { conversation } } = await request(app).post('/api/chat/conversations').send({});
    const res = await request(app).post(`/api/chat/conversations/${conversation.id}/messages`).send({ content: 'Which heater?' })
      .buffer(true).parse((r, cb) => { let t = ''; r.setEncoding('utf8'); r.on('data', (c: string) => (t += c)); r.on('end', () => cb(null, t)); });
    const evs = events(res.body as string);
    expect(evs.some(([e, d]) => e === 'error' && String(d['message']).includes('model exploded'))).toBe(true);
    const stored = await request(app).get(`/api/chat/conversations/${conversation.id}`);
    expect(stored.body.messages[1]).toMatchObject({ role: 'assistant', meta: { error: 'model exploded' } });
  });

  it('answers 503 before streaming when no provider has a key', async () => {
    const bare = createApp({
      modules: new Set(['chat']),
      vaultRoot,
      embeddingProvider: () => fakeProvider(),
      chat: { catalog: () => ({ ...CATALOG, providers: CATALOG.providers.map((p) => ({ ...p, configured: false })) }), buildProvider: fakeModel },
    });
    const { body: { conversation } } = await request(bare).post('/api/chat/conversations').send({});
    const res = await request(bare).post(`/api/chat/conversations/${conversation.id}/messages`).send({ content: 'hi' });
    expect(res.status).toBe(503);
    expect(res.body.error.message).toContain('no chat provider');
  });

  it('still answers, keyword only, when semantic search is not configured', async () => {
    const noEmbed = createApp({
      modules: new Set(['chat']),
      vaultRoot,
      embeddingProvider: () => { throw new Error('TOGETHER_API_KEY is not set'); },
      chat: { catalog: () => CATALOG, buildProvider: fakeModel },
    });
    const { body: { conversation } } = await request(noEmbed).post('/api/chat/conversations').send({});
    const res = await request(noEmbed).post(`/api/chat/conversations/${conversation.id}/messages`).send({ content: 'electric heater' })
      .buffer(true).parse((r, cb) => { let t = ''; r.setEncoding('utf8'); r.on('data', (c: string) => (t += c)); r.on('end', () => cb(null, t)); });
    const evs = events(res.body as string);
    expect(evs[0]![1]).toMatchObject({ vector: false, keyword: true });
    expect((evs[0]![1]['sources'] as unknown[]).length).toBeGreaterThan(0);
  });
});
