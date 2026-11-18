import { createModels } from '@earendil-works/pi-ai';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ZenAgent } from '../src/agent.js';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { discoverMachine, machineProviderId, parseMachines, refreshMachines } from '../src/machines.js';
import { ChatHost } from '../src/serve.js';

const BOX = 'http://192.0.2.10:11434';
const GONE = 'http://192.0.2.11:11434';

const SHOW: Record<string, unknown> = {
  'qwen-chat:27b': { capabilities: ['completion', 'tools', 'thinking'], model_info: { 'general.architecture': 'qwen', 'qwen.context_length': 262_144 } },
  'hf.co/some-org/Tiny-GGUF:Q4_K_M': { capabilities: ['completion'], model_info: { 'general.architecture': 'llama', 'llama.context_length': 8192 } },
  'embed-model': { capabilities: ['embedding'], model_info: {} },
  'vision:7b': { capabilities: ['completion', 'tools', 'vision'], model_info: { 'general.architecture': 'qwen', 'qwen.context_length': 32_768 } },
};

/** A fake Ollama at BOX; GONE never answers. */
function fakeOllama(calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (!url.startsWith(BOX)) throw new Error('connect EHOSTUNREACH');
    if (url.endsWith('/api/tags')) return Response.json({ models: Object.keys(SHOW).map((name) => ({ name, model: name, details: { family: name === 'embed-model' ? 'bert' : 'qwen' } })) });
    if (url.endsWith('/api/show')) {
      const { model } = JSON.parse(String(init?.body)) as { model: string };
      return Response.json(SHOW[model] ?? {});
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

test('OLLAMA_MACHINES: name=url pairs, bad ones skipped, trailing slash dropped', () => {
  assert.deepEqual(parseMachines(`box1=${BOX}/, Bad Name=http://x, box2=ftp://nope, noequals, box3=${GONE}`), {
    box1: { url: BOX },
    box3: { url: GONE },
  });
  assert.deepEqual(parseMachines(undefined), {});
});

test('discovery lists installed chat models with their real context, tools, vision and thinking', async () => {
  const found = await discoverMachine({ url: BOX, contextWindow: 65_536 }, fakeOllama());
  assert.ok(found);
  assert.deepEqual(found.map((m) => m.id), ['hf.co/some-org/Tiny-GGUF:Q4_K_M', 'qwen-chat:27b', 'vision:7b'], 'the embedding model is left out');
  const qwen = found.find((m) => m.id === 'qwen-chat:27b')!;
  assert.deepEqual([qwen.contextWindow, qwen.reasoning], [65_536, true], 'capped at the machine setting, not the 262k the model allows');
  assert.equal(found.find((m) => m.id.startsWith('hf.co'))!.contextWindow, 8192, 'a smaller model keeps its own window');
  assert.equal(found.find((m) => m.id.startsWith('hf.co'))!.name, 'hf.co/some-org/Tiny-GGUF:Q4_K_M (no tool calling)');
  assert.deepEqual(found.find((m) => m.id === 'vision:7b')!.input, ['text', 'image']);
  assert.equal(await discoverMachine({ url: GONE }, fakeOllama(), 100), null, 'no answer is null, not an empty list');
});

test('refresh registers a provider per machine, and a machine that goes quiet keeps its last models', async () => {
  const models = createModels();
  const known = new Map();
  const machines = { box: { url: BOX }, gone: { url: GONE } };
  const first = await refreshMachines(models, machines, known, fakeOllama(), 100);
  assert.deepEqual([first.get('ollama-box')!.reachable, first.get('ollama-gone')!.reachable], [true, false]);
  assert.equal(models.getModel('ollama-box', 'qwen-chat:27b')?.baseUrl, `${BOX}/v1`);
  assert.equal(models.getModels().filter((m) => m.provider === 'ollama-gone').length, 0, 'never seen: registered empty');
  const down = (async () => {
    throw new Error('asleep');
  }) as unknown as typeof fetch;
  const second = await refreshMachines(models, machines, known, down, 100);
  assert.equal(second.get('ollama-box')!.reachable, false);
  assert.ok(models.getModel('ollama-box', 'qwen-chat:27b'), 'the models stay so the picker can grey them out');
});

test('the catalogue lists a machine as a custom provider with live reachability, and chats can pick its models', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zen-machines-'));
  const cfg = loadConfig({ workdir: dir, env: { OLLAMA_MACHINES: `box=${BOX},gone=${GONE}` }, overrides: { model: 'ollama-box/qwen-chat:27b', tools: [] } });
  assert.equal(machineProviderId('box'), 'ollama-box');
  const calls: string[] = [];
  const host = new ChatHost({ config: cfg, env: {}, fetch: fakeOllama(calls), probeMs: 100, chatsDir: join(dir, 'chats') });
  const cat = await host.catalog();
  const box = cat.providers.find((p) => p.id === 'ollama-box')!;
  const gone = cat.providers.find((p) => p.id === 'ollama-gone')!;
  assert.deepEqual([box.custom, box.reachable, box.configured, box.base_url, box.name], [true, true, true, `${BOX}/v1`, 'Ollama · box']);
  assert.deepEqual([gone.custom, gone.reachable], [true, false]);
  const row = cat.models.find((m) => m.provider === 'ollama-box' && m.id === 'qwen-chat:27b')!;
  assert.deepEqual([row.reachable, row.configured, row.context_window, row.reasoning], [true, true, 32_000, true]);
  // A model id with slashes and a tag still resolves as provider/model.
  const chat = host.create({ model: 'ollama-box/hf.co/some-org/Tiny-GGUF:Q4_K_M', tools: [] });
  assert.equal(chat.model, 'ollama-box/hf.co/some-org/Tiny-GGUF:Q4_K_M');
  // The probe is cached: a second catalogue call and a refresh do not touch the machines again.
  const n = calls.length;
  await host.catalog();
  await host.refreshMachines();
  assert.equal(calls.length, n);
});

test('no machines configured: nothing is probed and the catalogue is as before', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zen-nomachines-'));
  const cfg = loadConfig({ workdir: dir, env: {}, overrides: { tools: [] } });
  const calls: string[] = [];
  const host = new ChatHost({ config: cfg, env: {}, fetch: fakeOllama(calls), probeMs: 100, chatsDir: join(dir, 'chats') });
  const cat = await host.catalog();
  assert.equal(cat.providers.some((p) => p.id.startsWith('ollama-')), false);
  assert.deepEqual(calls, []);
});

test('a machines entry that is not a machine (a comment key, a typo) is dropped on load', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zen-badmachines-'));
  writeFileSync(join(dir, 'zen.json'), JSON.stringify({ machines: { $comment: 'notes', Bad: { url: BOX }, nourl: {}, ok: { url: BOX } } }));
  assert.deepEqual(Object.keys(loadConfig({ workdir: dir, env: {} }).machines), ['ok']);
});

test('an agent turn runs on a keyless machine model: it needs a key to call, so a placeholder stands in', async () => {
  const seen: { auth: string | undefined; model: string }[] = [];
  const fake = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({ auth: req.headers.authorization, model: (JSON.parse(raw || '{}') as { model?: string }).model ?? '' });
      res.setHeader('content-type', 'text/event-stream');
      const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'tiny', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.write(chunk({ role: 'assistant', content: 'ready' }));
      res.write(chunk({}, 'stop'));
      res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'tiny', choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
    const dir = mkdtempSync(join(tmpdir(), 'zen-keyless-'));
    const cfg = loadConfig({ workdir: dir, env: { OLLAMA_MACHINES: `box=${url}` }, overrides: { tools: [], guard: { local: null, log: null, hooks: { preToolUse: [], stop: [] } } } });
    // The fake answers /api/tags and /api/show with nothing useful, so serve it through the discovery path by hand.
    const models = createModels();
    const { customProvider } = await import('../src/models.js');
    models.setProvider(customProvider('ollama-box', { api: 'openai-completions', baseUrl: `${url}/v1`, apiKeyEnv: null, models: [{ id: 'tiny', contextWindow: 8000 }] }));
    const zen = new ZenAgent({ config: cfg, models, model: 'ollama-box/tiny' });
    const r = await zen.run('say ready');
    assert.equal(r.error ?? null, null, String(r.error));
    assert.ok(seen.length >= 1, 'the machine was called');
    assert.equal(seen[0]!.model, 'tiny');
    assert.ok(seen[0]!.auth?.startsWith('Bearer '), 'a placeholder bearer was sent');
  } finally {
    fake.close();
  }
});
