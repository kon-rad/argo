import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openAiCompatProvider, sseData } from '../src/llm/openaiCompat.js';
import { mergePresets, parsePresets, PRESETS_FILE } from '../src/llm/presets.js';
import { buildChatProvider, pickProvider, providerCatalog } from '../src/llm/registry.js';
import { complete } from '../src/llm/types.js';

function stream(parts: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(enc.encode(p));
      c.close();
    },
  });
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe('sseData', () => {
  it('splits events on blank lines, joins multi-line data, and survives chunks that cut an event in half', async () => {
    const got = await collect(sseData(stream(['data: a\n\ndata: b1\ndata: b2\n\n: comment\nevent: x\nda', 'ta: c\n\n'])));
    expect(got).toEqual(['a', 'b1\nb2', 'c']);
  });
});

const PRESETS = parsePresets({
  defaultProvider: 'anthropic',
  systemPrompt: 'base',
  providers: {
    anthropic: { label: 'Anthropic', protocol: 'anthropic', env: 'ANTHROPIC_API_KEY', baseUrl: 'https://api.anthropic.com', default: 'claude-opus-5-5', models: [{ id: 'claude-opus-5-5' }] },
    together: { label: 'Together', protocol: 'openai', env: 'TOGETHER_API_KEY', baseUrl: 'https://api.together.xyz/v1', default: 'm1', models: [{ id: 'm1' }, { id: 'm2' }] },
    ollama: { label: 'Ollama', protocol: 'openai', env: null, baseUrl: 'http://127.0.0.1:11434/v1', default: 'llama3.1', models: [{ id: 'llama3.1' }] },
  },
});

describe('openAiCompatProvider', () => {
  it('streams deltas, reads usage from the last chunk and sends the key only as a header', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init! });
      const body = [
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n',
        'data: [DONE]\n\n',
      ];
      return new Response(stream(body), { status: 200 });
    }) as typeof fetch;
    const p = openAiCompatProvider({ id: 'together', model: 'm1', baseUrl: 'https://x.example/v1', apiKey: 'sk-test-secret-value', fetchFn });
    const { text, usage } = await complete(p, { system: 'sys', messages: [{ role: 'user', content: 'hi' }], maxTokens: 50 });
    expect(text).toBe('Hello');
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 2 });
    expect(seen[0]!.url).toBe('https://x.example/v1/chat/completions');
    const sent = JSON.parse(seen[0]!.init.body as string);
    expect(sent.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(sent.stream).toBe(true);
    expect(sent.max_tokens).toBe(50);
    expect((seen[0]!.init.headers as Record<string, string>)['authorization']).toBe('Bearer sk-test-secret-value');
    expect(JSON.stringify(sent)).not.toContain('sk-test');
  });

  it('turns an upstream error into an LlmError with the status and no key in the text', async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ error: { message: 'bad key sk-test-secret-value' } }), { status: 401 })) as typeof fetch;
    const p = openAiCompatProvider({ id: 'openai', model: 'm', baseUrl: 'https://x.example/v1', apiKey: 'sk-test-secret-value', fetchFn });
    await expect(complete(p, { messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({ status: 401 });
    await expect(complete(p, { messages: [{ role: 'user', content: 'hi' }] })).rejects.not.toThrow(/secret-value/);
  });
});

describe('presets', () => {
  it('the shipped presets file is valid and names no key', () => {
    const raw = readFileSync(PRESETS_FILE, 'utf8');
    const presets = parsePresets(JSON.parse(raw));
    expect(Object.keys(presets.providers)).toEqual(expect.arrayContaining(['anthropic', 'openai', 'together', 'openrouter', 'ollama']));
    for (const p of Object.values(presets.providers)) expect(p.models.some((m) => m.id === p.default)).toBe(true);
    expect(raw).not.toMatch(/sk-[A-Za-z0-9]{10}/);
  });

  it('a vault adds models, changes a default and picks the default provider, but cannot invent a provider', () => {
    const merged = mergePresets(PRESETS, {
      defaultProvider: 'together',
      systemPrompt: 'mine',
      providers: { together: { models: [{ id: 'm2' }, { id: 'm3', label: 'Three' }], default: 'm3' }, bogus: { models: [{ id: 'x' }] } },
    });
    expect(merged.defaultProvider).toBe('together');
    expect(merged.systemPrompt).toBe('mine');
    expect(merged.providers.together!.models.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(merged.providers.together!.default).toBe('m3');
    expect(merged.providers.bogus).toBeUndefined();
  });

  it('an unknown default provider falls back to the engine default', () => {
    expect(mergePresets(PRESETS, { defaultProvider: 'nope', providers: {} }).defaultProvider).toBe('anthropic');
  });
});

describe('registry', () => {
  it('marks a provider configured only when its key is set; ollama needs none', () => {
    const cat = providerCatalog(PRESETS, { TOGETHER_API_KEY: 'k' });
    expect(cat.providers.map((p) => [p.id, p.configured])).toEqual([['anthropic', false], ['together', true], ['ollama', true]]);
  });

  it('picks the wanted provider when configured, else the default, else the first configured', () => {
    const cat = providerCatalog(PRESETS, { TOGETHER_API_KEY: 'k' });
    expect(pickProvider(cat, 'together')!.id).toBe('together');
    expect(pickProvider(cat, 'anthropic')!.id).toBe('together');
    expect(pickProvider(providerCatalog(PRESETS, { ANTHROPIC_API_KEY: 'k' }), null)!.id).toBe('anthropic');
    expect(pickProvider(providerCatalog(PRESETS, {}), null)!.id).toBe('ollama');
  });

  it('refuses to build a provider whose key is missing, naming the variable', () => {
    expect(() => buildChatProvider('together', 'm1', { presets: PRESETS, environment: {} })).toThrow(/TOGETHER_API_KEY/);
    expect(() => buildChatProvider('nope', 'm1', { presets: PRESETS, environment: {} })).toThrow(/unknown/);
    expect(buildChatProvider('ollama', 'llama3.1', { presets: PRESETS, environment: {} }).id).toBe('ollama');
    expect(buildChatProvider('anthropic', 'claude-opus-5-5', { presets: PRESETS, environment: { ANTHROPIC_API_KEY: 'k' } }).id).toBe('anthropic');
  });
});
