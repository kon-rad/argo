import { beforeEach, describe, expect, it } from 'vitest';
import { parseOllamaMachines } from '../src/config.js';
import { parsePresets } from '../src/llm/presets.js';
import { buildChatProvider, discoverMachineModels, machineProviders, pickProvider, providerCatalogWithMachines, resetMachineCache } from '../src/llm/registry.js';
import { complete } from '../src/llm/types.js';

const PRESETS = parsePresets({
  defaultProvider: 'ollama',
  systemPrompt: 'base',
  providers: {
    ollama: { label: 'Ollama', protocol: 'openai', env: null, baseUrl: 'http://127.0.0.1:11434/v1', default: 'llama3.1', models: [{ id: 'llama3.1' }] },
  },
});

const BOX1 = { name: 'box1', url: 'http://192.0.2.10:11434' };
const BOX2 = { name: 'box2', url: 'http://192.0.2.11:11434' };

const TAGS = {
  models: [
    { name: 'qwen3:8b', details: { family: 'qwen3' } },
    { name: 'nomic-embed-text:latest', details: { family: 'nomic-bert' } },
    { name: 'bge-m3:latest', details: { family: 'bert' } },
    { name: 'someorg/model-embed:1b', details: { family: 'llama' } },
    { name: 'hf.co/acme/chat-gguf:Q4_K_M', details: { family: 'llama' } },
  ],
};

/** box1 answers with TAGS; anything else refuses the connection. */
const fakeFetch = (async (url: string | URL | Request) => {
  if (String(url) === `${BOX1.url}/api/tags`) return new Response(JSON.stringify(TAGS), { status: 200 });
  throw new TypeError('fetch failed');
}) as typeof fetch;

beforeEach(() => resetMachineCache());

describe('parseOllamaMachines', () => {
  it('reads name=url pairs and skips the invalid ones', () => {
    const { machines, skipped } = parseOllamaMachines(
      ' box1=http://192.0.2.10:11434/ ,Bad_Name=http://192.0.2.11:11434,noequals,box3=,box4=not-a-url,box1=http://192.0.2.12:11434,box2=http://192.0.2.11:11434',
    );
    expect(machines).toEqual([BOX1, BOX2]);
    expect(skipped).toEqual(['Bad_Name=http://192.0.2.11:11434', 'noequals', 'box3=', 'box4=not-a-url', 'box1=http://192.0.2.12:11434']);
  });

  it('is empty for an unset variable', () => {
    expect(parseOllamaMachines('')).toEqual({ machines: [], skipped: [] });
  });
});

describe('machine discovery', () => {
  it('keeps chat models, drops embedding models, and uses the tag name as id and label', async () => {
    const models = await discoverMachineModels(BOX1, fakeFetch);
    expect(models).toEqual([
      { id: 'qwen3:8b', label: 'qwen3:8b' },
      { id: 'hf.co/acme/chat-gguf:Q4_K_M', label: 'hf.co/acme/chat-gguf:Q4_K_M' },
    ]);
  });

  it('lists an offline machine as configured: false without throwing', async () => {
    const providers = await machineProviders([BOX1, BOX2], fakeFetch);
    expect(providers.map((p) => [p.id, p.label, p.configured])).toEqual([
      ['ollama-box1', 'Ollama · box1', true],
      ['ollama-box2', 'Ollama · box2', false],
    ]);
    expect(providers[0]).toMatchObject({ machine: true, env: null, default: 'qwen3:8b' });
    expect(providers[1]).toMatchObject({ machine: true, offline: true, models: [], default: '' });
  });

  it('treats a non-200 answer and bad JSON as offline', async () => {
    const f = (async (url: string | URL | Request) => (String(url).includes('10:') ? new Response('nope', { status: 500 }) : new Response('{not json', { status: 200 }))) as typeof fetch;
    const providers = await machineProviders([BOX1, BOX2], f);
    expect(providers.every((p) => !p.configured)).toBe(true);
  });

  it('caches the answer for a while and forgets it on reset', async () => {
    let n = 0;
    const f = (async () => (n++, new Response(JSON.stringify(TAGS), { status: 200 }))) as typeof fetch;
    await machineProviders([BOX1], f);
    await machineProviders([BOX1], f);
    expect(n).toBe(1);
    resetMachineCache();
    await machineProviders([BOX1], f);
    expect(n).toBe(2);
  });

  it('adds machines after the presets and pickProvider can choose them', async () => {
    const cat = await providerCatalogWithMachines({ presets: PRESETS, environment: {}, machines: [BOX1, BOX2], fetchFn: fakeFetch });
    expect(cat.providers.map((p) => p.id)).toEqual(['ollama', 'ollama-box1', 'ollama-box2']);
    expect(pickProvider(cat, 'ollama-box1')!.id).toBe('ollama-box1');
    expect(pickProvider(cat, 'ollama-box2')!.id).toBe('ollama'); // offline: falls back to the default
  });
});

describe('buildChatProvider for a machine', () => {
  it('posts to <url>/v1/chat/completions with no key', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init! });
      const body = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n');
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    const p = buildChatProvider('ollama-box1', 'qwen3:8b', { presets: PRESETS, environment: {}, machines: [BOX1], fetchFn });
    expect(p.id).toBe('ollama-box1');
    const { text } = await complete(p, { messages: [{ role: 'user', content: 'hi' }] });
    expect(text).toBe('hi');
    expect(seen[0]!.url).toBe('http://192.0.2.10:11434/v1/chat/completions');
    expect(JSON.parse(seen[0]!.init.body as string).model).toBe('qwen3:8b');
    expect((seen[0]!.init.headers as Record<string, string>)['authorization']).toBeUndefined();
  });

  it('throws for a machine that is not configured', () => {
    expect(() => buildChatProvider('ollama-box9', 'm', { presets: PRESETS, environment: {}, machines: [BOX1] })).toThrow(/unknown/);
  });
});
