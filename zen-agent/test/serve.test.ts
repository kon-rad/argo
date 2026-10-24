import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall, type Models } from '@earendil-works/pi-ai';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { loadConfig, type ZenConfig } from '../src/config.js';
import { ChatHost, startServer, type ChatEvent, type ChatRecord } from '../src/serve.js';

const TOKEN = 'test-token-0123456789abcdef';

interface World { cfg: ZenConfig; faux: ReturnType<typeof fauxProvider>; models: Models; dir: string; probes: string[] }

function world(): World {
  const dir = mkdtempSync(join(tmpdir(), 'zen-serve-'));
  writeFileSync(join(dir, 'AGENTS.md'), '# Rules\nBe brief.');
  writeFileSync(join(dir, 'hello.txt'), 'hello\nworld\n');
  mkdirSync(join(dir, '.agents', 'org'), { recursive: true });
  writeFileSync(join(dir, '.agents', 'org', 'org.json'), JSON.stringify({ agents: { atlas: { role: 'Researcher', team: 'research' }, owner: { runtime: 'human', role: 'Owner' } }, teams: { research: { name: 'Research', lead: 'atlas' } } }));
  mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'agents', 'atlas.md'), '---\nname: atlas\n---\nYou research things.');
  mkdirSync(join(dir, '.agents', 'skills', 'summarize'), { recursive: true });
  writeFileSync(join(dir, '.agents', 'skills', 'summarize', 'SKILL.md'), '---\nname: summarize\ndescription: Sum things up.\n---\nBe short.');
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const cfg = loadConfig({
    workdir: dir,
    env: {},
    overrides: {
      model: 'faux/faux-1',
      tools: ['fs', 'shell', 'skills'],
      guard: { local: null, log: null, hooks: { preToolUse: [], stop: [] } },
      providers: {
        'm1-local': { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: null, models: [{ id: 'qwen-local', contextWindow: 32_000 }] },
        'm1-asleep': { api: 'openai-completions', baseUrl: 'http://127.0.0.1:2/v1', apiKeyEnv: 'M1_KEY', models: [{ id: 'qwen-asleep' }] },
      },
    },
  });
  // The real catalogue would need the custom providers registered too; the host does that itself when models are not injected.
  return { cfg, faux, models, dir, probes: [] };
}

const fakeFetch = (probes: string[]): typeof fetch =>
  (async (input: string | URL | Request) => {
    const url = String(input);
    probes.push(url);
    if (url.startsWith('http://127.0.0.1:1/')) return new Response('{"data":[]}', { status: 401 });
    throw new Error('connect ECONNREFUSED');
  }) as typeof fetch;

let w: World;
let server: Server;
let base = '';
let host: ChatHost;

before(async () => {
  w = world();
  const started = await startServer({ config: w.cfg, token: TOKEN, port: 0, models: w.models, env: {}, fetch: fakeFetch(w.probes), probeMs: 200 });
  server = started.server;
  base = started.url;
  host = started.host;
});
after(() => new Promise<void>((r) => server.close(() => r())));

async function call<T = any>(method: string, path: string, body?: unknown, token = TOKEN): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as T };
}

async function settle(id: string, ms = 5000): Promise<ChatRecord> {
  const until = Date.now() + ms;
  for (;;) {
    const { body } = await call<ChatRecord>('GET', `/zen/chats/${id}`);
    if (body.status !== 'working') return body;
    if (Date.now() > until) throw new Error('chat did not settle');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const types = (events: ChatEvent[]): string[] => events.map((e) => e.type);
const text = (events: ChatEvent[], kind: 'text' | 'thinking'): string => events.filter((e): e is Extract<ChatEvent, { type: 'delta' }> => e.type === 'delta').map((e) => e[kind] ?? '').join('');

test('needs the token; unknown routes are 404', async () => {
  assert.equal((await call('GET', '/zen/chats', undefined, 'wrong')).status, 401);
  assert.equal((await call('GET', '/zen/nothing')).status, 404);
  assert.equal((await call('DELETE', '/zen/chats')).status, 404);
  assert.deepEqual((await call('GET', '/health')).body, { ok: true });
});

test('the catalogue says which providers have a key and which custom endpoints answer', async () => {
  const { status, body } = await call('GET', '/zen/models');
  assert.equal(status, 200);
  const faux = body.providers.find((p: any) => p.id === 'faux');
  assert.equal(faux.configured, true);
  assert.equal(faux.custom, false);
  assert.equal(faux.reachable, null);
  const m1 = body.models.find((m: any) => m.id === 'qwen-local');
  assert.equal(m1, undefined, 'custom providers are not in an injected test catalogue');
  // The probe ran for every custom provider in the config, with a timeout, and the catalogue is cached.
  assert.deepEqual([...w.probes].sort(), ['http://127.0.0.1:1/v1/models', 'http://127.0.0.1:2/v1/models']);
  await call('GET', '/zen/models');
  assert.equal(w.probes.length, 2);
  assert.ok(body.models.some((m: any) => m.provider === 'faux' && m.configured === true));
});

test('a real catalogue carries the custom endpoints with their key variable and reachability', async () => {
  const h = new ChatHost({ config: w.cfg, env: {}, fetch: fakeFetch([]), probeMs: 200, chatsDir: mkdtempSync(join(tmpdir(), 'zen-chats-')) });
  const cat = await h.catalog();
  const up = cat.providers.find((p) => p.id === 'm1-local')!;
  const down = cat.providers.find((p) => p.id === 'm1-asleep')!;
  assert.deepEqual([up.custom, up.reachable, up.key_env, up.configured, up.base_url], [true, true, null, true, 'http://127.0.0.1:1/v1']);
  assert.deepEqual([down.custom, down.reachable, down.key_env, down.configured], [true, false, 'M1_KEY', false]);
  const model = cat.models.find((m) => m.id === 'qwen-asleep')!;
  assert.deepEqual([model.provider, model.reachable, model.configured, model.context_window], ['m1-asleep', false, false, 128_000]);
  assert.ok(cat.providers.some((p) => p.id === 'anthropic' && p.key_name));
});

test('personas and skills come from the vault', async () => {
  assert.deepEqual((await call('GET', '/zen/personas')).body.personas, [{ name: 'atlas', role: 'Researcher', team: 'research', runtime: 'claude-code' }]);
  assert.deepEqual((await call('GET', '/zen/skills')).body.skills, [{ name: 'summarize', description: 'Sum things up.' }]);
});

test('creating a chat checks its config up front', async () => {
  assert.match((await call('POST', '/zen/chats', { model: 'nope/none' })).body.error, /unknown model/);
  assert.match((await call('POST', '/zen/chats', { persona: 'ghost' })).body.error, /no persona "ghost"/);
  assert.match((await call('POST', '/zen/chats', { tools: ['fs', 'lasers'] })).body.error, /unknown tool set "lasers"/);
  assert.match((await call('POST', '/zen/chats', { thinking: 'loud' })).body.error, /thinking must be one of/);
  assert.match((await call('POST', '/zen/chats', { from: 'abcdefabcdef' })).body.error, /no chat/);
  const { status, body } = await call<ChatRecord>('POST', '/zen/chats', { persona: 'atlas', tools: 'read-only', thinking: 'low', title: ' Plans ' });
  assert.equal(status, 200);
  assert.match(body.id, /^[0-9a-f]{12}$/);
  assert.deepEqual([body.persona, body.model, body.tools, body.thinking, body.title, body.status, body.from], ['atlas', 'faux/faux-1', ['skills', 'knowledge'], 'low', 'Plans', 'idle', null]);
  assert.ok(body.session_id.startsWith('atlas-'));
  // The record is on disk and the trace already has its meta line, which is the first event.
  assert.equal(JSON.parse(readFileSync(join(host.chatsDir, `${body.id}.json`), 'utf8')).id, body.id);
  const page = (await call('GET', `/zen/chats/${body.id}/events`)).body;
  assert.deepEqual(types(page.events), ['meta']);
  assert.equal(page.events[0].persona, 'atlas');
  assert.deepEqual(page.events[0].tools, ['read_skill']);
  assert.equal(page.offset, 1);
  assert.equal(page.epoch, host.epoch);
});

test('a turn: the event log shows thinking, the answer typed, the tool call, its result and the end', async () => {
  w.faux.setResponses([
    fauxAssistantMessage([fauxThinking('Let me look.'), fauxToolCall('read_file', { path: 'hello.txt' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxText('It says hello world.')]),
  ]);
  const chat = (await call<ChatRecord>('POST', '/zen/chats', {})).body;
  assert.equal(chat.title, '');
  const sent = await call<ChatRecord>('POST', `/zen/chats/${chat.id}/messages`, { text: 'What does hello.txt say?\nSecond line.' });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.status, 'working');
  assert.equal(sent.body.title, 'What does hello.txt say?');
  const done = await settle(chat.id);
  assert.equal(done.status, 'idle');
  assert.equal(done.turns, 2);
  assert.ok(done.usage.total > 0);

  const page = (await call('GET', `/zen/chats/${chat.id}/events`)).body;
  const ev: ChatEvent[] = page.events;
  const kinds = types(ev);
  assert.equal(kinds[0], 'meta');
  assert.equal(kinds[1], 'message');
  assert.equal((ev[1] as any).message.role, 'user');
  assert.equal(kinds.at(-1), 'end');
  assert.equal((ev.at(-1) as any).stopped, 'done');
  assert.equal(text(ev, 'thinking'), 'Let me look.');
  assert.equal(text(ev, 'text'), 'It says hello world.');
  const tool = ev.find((e) => e.type === 'tool') as any;
  assert.deepEqual([tool.name, tool.args.path, tool.isError], ['read_file', 'hello.txt', false]);
  const roles = ev.filter((e) => e.type === 'message').map((e: any) => e.message.role);
  assert.deepEqual(roles, ['user', 'assistant', 'toolResult', 'assistant']);
  // Deltas land before the message they belong to.
  const firstDelta = kinds.indexOf('delta');
  const firstAssistant = ev.findIndex((e: any) => e.type === 'message' && e.message.role === 'assistant');
  assert.ok(firstDelta < firstAssistant);
  // Paging by offset returns only what is new.
  const tail = (await call('GET', `/zen/chats/${chat.id}/events?offset=${page.offset - 2}`)).body;
  assert.equal(tail.events.length, 2);
  assert.equal(tail.offset, page.offset);
  assert.equal(tail.size, page.offset);
  assert.equal((await call('GET', `/zen/chats/${chat.id}/events?offset=999`)).body.events.length, 0);
  // The list has it first.
  assert.equal((await call('GET', '/zen/chats')).body.chats[0].id, chat.id);
});

test('the guard shows up as a blocked event', async () => {
  w.faux.setResponses([
    fauxAssistantMessage([fauxToolCall('bash', { command: 'cat .env' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxText('I cannot.')]),
  ]);
  const chat = (await call<ChatRecord>('POST', '/zen/chats', {})).body;
  await call('POST', `/zen/chats/${chat.id}/messages`, { text: 'print the env' });
  await settle(chat.id);
  const ev: ChatEvent[] = (await call('GET', `/zen/chats/${chat.id}/events`)).body.events;
  const blocked = ev.find((e) => e.type === 'blocked') as any;
  assert.equal(blocked.name, 'bash');
  assert.match(blocked.reason, /^guard:/);
});

test('while working: a second message is refused, a steer is read, a stop aborts', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  w.faux.setResponses([
    async () => {
      await gate;
      return fauxAssistantMessage([fauxToolCall('bash', { command: 'echo hi' })], { stopReason: 'toolUse' });
    },
    fauxAssistantMessage([fauxText('never')]),
  ]);
  const chat = (await call<ChatRecord>('POST', '/zen/chats', {})).body;
  assert.equal((await call('POST', `/zen/chats/${chat.id}/steer`, { text: 'early' })).status, 409);
  await call('POST', `/zen/chats/${chat.id}/messages`, { text: 'go' });
  assert.equal((await call('POST', `/zen/chats/${chat.id}/messages`, { text: 'again' })).status, 409);
  assert.equal((await call('POST', `/zen/chats/${chat.id}/steer`, { text: 'also check the date' })).status, 200);
  const stop = await call('POST', `/zen/chats/${chat.id}/interrupt`);
  assert.equal(stop.status, 200);
  release();
  const done = await settle(chat.id);
  assert.equal(done.status, 'idle');
  const ev: ChatEvent[] = (await call('GET', `/zen/chats/${chat.id}/events`)).body.events;
  assert.ok(ev.some((e) => e.type === 'steer' && e.text === 'also check the date'));
  assert.equal((ev.at(-1) as any).type, 'end');
  assert.equal((ev.at(-1) as any).stopped, 'aborted');
  w.faux.setResponses([]);
});

test('after a restart the chats are listed, the log is rebuilt from the trace, and the conversation continues', async () => {
  w.faux.setResponses([fauxAssistantMessage([fauxText('First answer.')])]);
  const chat = (await call<ChatRecord>('POST', '/zen/chats', { persona: 'atlas' })).body;
  await call('POST', `/zen/chats/${chat.id}/messages`, { text: 'first' });
  await settle(chat.id);

  const again = new ChatHost({ config: w.cfg, models: w.models, env: {}, fetch: fakeFetch([]), chatsDir: host.chatsDir });
  assert.notEqual(again.epoch, host.epoch);
  assert.ok(again.list().some((c) => c.id === chat.id));
  const page = again.page(chat.id, 0);
  assert.deepEqual(types(page.events), ['meta', 'message', 'message', 'end'], 'no deltas: they were never on disk');

  w.faux.setResponses([fauxAssistantMessage([fauxText('Second answer.')])]);
  again.send(chat.id, 'second');
  for (let i = 0; i < 200 && again.get(chat.id).status === 'working'; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(again.get(chat.id).status, 'idle');
  const trace = readFileSync(join(w.cfg.sessionsDir, `${chat.session_id}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const metas = trace.filter((l) => l.type === 'meta');
  assert.equal(metas.length, 2, 'the resumed run appended its own meta line to the same trace');
  assert.equal(metas[1].resumed, chat.session_id);
  const roles = trace.filter((l) => l.type === 'message').map((l) => l.message.role);
  assert.deepEqual(roles, ['user', 'assistant', 'user', 'assistant']);
  const events = again.page(chat.id, 0).events;
  assert.equal(types(events).filter((t) => t === 'meta').length, 2);
  assert.equal(events.filter((e) => e.type === 'delta').map((e: any) => e.text ?? '').join(''), 'Second answer.');
});

test('continuing with another model is a new chat, a new session and a new trace, seeded from the old one', async () => {
  w.faux.setResponses([fauxAssistantMessage([fauxText('Noted.')])]);
  const old = (await call<ChatRecord>('POST', '/zen/chats', { title: 'Plans' })).body;
  await call('POST', `/zen/chats/${old.id}/messages`, { text: 'remember the plan' });
  await settle(old.id);
  const oldTrace = readFileSync(join(w.cfg.sessionsDir, `${old.session_id}.jsonl`), 'utf8');

  w.faux.setResponses([fauxAssistantMessage([fauxText('The plan, as noted.')])]);
  const fork = (await call<ChatRecord>('POST', '/zen/chats', { from: old.id, tools: 'read-only', thinking: 'high' })).body;
  assert.notEqual(fork.id, old.id);
  assert.notEqual(fork.session_id, old.session_id);
  assert.deepEqual([fork.from, fork.title, fork.tools, fork.thinking], [old.id, 'Plans', ['skills', 'knowledge'], 'high']);
  const meta = (await call('GET', `/zen/chats/${fork.id}/events`)).body.events[0];
  assert.equal(meta.resumed, old.session_id);
  assert.equal(meta.id, fork.session_id);
  await call('POST', `/zen/chats/${fork.id}/messages`, { text: 'what was the plan?' });
  await settle(fork.id);
  const forkTrace = readFileSync(join(w.cfg.sessionsDir, `${fork.session_id}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  // The new trace holds only the new run's lines; the old messages were replayed into the model's context, not copied.
  assert.deepEqual(forkTrace.map((l) => l.type), ['meta', 'message', 'message', 'end']);
  assert.equal(readFileSync(join(w.cfg.sessionsDir, `${old.session_id}.jsonl`), 'utf8'), oldTrace, 'the old trace is untouched');
  assert.ok(w.faux.state.callCount > 0);
});
