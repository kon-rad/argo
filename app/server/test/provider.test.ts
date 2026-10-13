import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProvider, ProviderError } from '../src/embeddings/provider.js';

const unit = (n: number): number[] => Array.from({ length: n }, (_, i) => (i === 0 ? 1 : 0));

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const spy = vi.fn(handler as never);
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('together provider', () => {
  const KEY = 'abcdef0123456789abcdef0123456789'; // gitleaks:allow (fake key for tests)
  const cfg = { provider: 'together' as const, model: 'BAAI/bge-large-en-v1.5', dimensions: 4, apiKey: KEY };

  it('posts the batch and returns vectors in request order', async () => {
    const spy = stubFetch(() =>
      json({ data: [{ index: 1, embedding: unit(4) }, { index: 0, embedding: [0, 1, 0, 0] }] }),
    );
    const out = await createProvider(cfg).embed(['a', 'b']);
    expect(out).toEqual([[0, 1, 0, 0], unit(4)]);

    const [url, init] = spy.mock.calls[0]!;
    expect(url).toContain('api.together.xyz');
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(init.body as string).input).toEqual(['a', 'b']);
  });

  it('surfaces the provider error text so a 400 is diagnosable', async () => {
    stubFetch(() => json({ error: { message: 'maximum context length is 512 tokens' } }, 400));
    await expect(createProvider(cfg).embed(['a'])).rejects.toThrow(/maximum context length/);
  });

  it('scrubs anything credential-shaped out of that error text', async () => {
    stubFetch(() => json({ error: `rejected ${KEY} and sk-supersecretvalue123` }, 401));
    const err = await createProvider(cfg).embed(['a']).catch((e: Error) => e);
    expect(err.message).toContain('401');
    expect(err.message).not.toContain(KEY);
    expect(err.message).not.toContain('sk-supersecretvalue123');
    expect(err.message).toContain('[redacted]');
  });

  it('reports the number of attempts it actually made', async () => {
    stubFetch(() => json({ error: 'bad input' }, 400));
    const err = await createProvider({ ...cfg, retryBaseMs: 1 }).embed(['a']).catch((e: Error) => e);
    // A 400 is not retried, so claiming five attempts would be a lie — and it
    // was the lie that hid a real production failure.
    expect(err.message).toContain('1 attempt');
  });

  it('flags a context-length rejection so the caller can split', async () => {
    stubFetch(() => json({ error: { message: 'maximum context length is 512 tokens' } }, 400));
    const err = (await createProvider(cfg).embed(['a']).catch((e: unknown) => e)) as ProviderError;
    expect(err.tooLong).toBe(true);
  });

  it('does not flag an ordinary 400 as a length problem', async () => {
    stubFetch(() => json({ error: { message: 'model not found' } }, 400));
    const err = (await createProvider(cfg).embed(['a']).catch((e: unknown) => e)) as ProviderError;
    expect(err.tooLong).toBe(false);
  });

  it('retries a 429 and then succeeds', async () => {
    let n = 0;
    stubFetch(() => (++n < 3 ? json({ error: 'rate limited' }, 429) : json({ data: [{ index: 0, embedding: unit(4) }] })));
    const out = await createProvider({ ...cfg, retryBaseMs: 1 }).embed(['a']);
    expect(out).toEqual([unit(4)]);
    expect(n).toBe(3);
  });

  it('gives up after the retry budget', async () => {
    stubFetch(() => json({ error: 'boom' }, 503));
    await expect(createProvider({ ...cfg, retryBaseMs: 1, maxRetries: 2 }).embed(['a'])).rejects.toThrow(/503/);
  });

  it('does not retry a 400 — a malformed request will never succeed', async () => {
    let n = 0;
    stubFetch(() => { n++; return json({ error: 'bad input' }, 400); });
    await expect(createProvider({ ...cfg, retryBaseMs: 1 }).embed(['a'])).rejects.toThrow(/400/);
    expect(n).toBe(1);
  });

  it('rejects a vector of the wrong width rather than storing it', async () => {
    stubFetch(() => json({ data: [{ index: 0, embedding: [1, 2, 3] }] }));
    await expect(createProvider(cfg).embed(['a'])).rejects.toThrow(/dimension/i);
  });

  it('returns an empty array without calling the API', async () => {
    const spy = stubFetch(() => json({ data: [] }));
    expect(await createProvider(cfg).embed([])).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses to be built without a key', () => {
    expect(() => createProvider({ ...cfg, apiKey: undefined })).toThrow(/TOGETHER_API_KEY/);
  });
});

describe('ollama provider', () => {
  const cfg = { provider: 'ollama' as const, model: 'nomic-embed-text', dimensions: 4 };

  it('posts to the local daemon and returns the embeddings', async () => {
    const spy = stubFetch(() => json({ embeddings: [unit(4)] }));
    expect(await createProvider(cfg).embed(['a'])).toEqual([unit(4)]);
    expect(spy.mock.calls[0]![0]).toContain('127.0.0.1:11434');
  });
});
