import { setTimeout as sleep } from 'node:timers/promises';

export type ProviderId = 'together' | 'ollama';

export interface ProviderConfig {
  provider: ProviderId;
  model: string;
  dimensions: number;
  /** Together only. Read from the vault-root .env by config.ts. */
  apiKey?: string | undefined;
  baseUrl?: string;
  maxRetries?: number;
  retryBaseMs?: number;
  timeoutMs?: number;
}

export interface EmbeddingProvider {
  id: ProviderId;
  model: string;
  dimensions: number;
  /** Vectors come back in the order the inputs went in. */
  embed(texts: readonly string[]): Promise<number[][]>;
}

/**
 * Carries the HTTP status and never the credential. The API key is a request
 * header, so the naive `throw new Error(await res.text())` is one upstream
 * change away from writing a key into a log line the user then pastes into a
 * bug report.
 */
export class ProviderError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The input exceeded the encoder's context window; the caller can split. */
    readonly tooLong = false,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/**
 * The provider's own words for "that input was too long". Recognising it is
 * what lets the pipeline split and retry instead of failing a whole run over
 * one dense note — see embedChunks().
 */
export function isContextLengthError(err: unknown): boolean {
  return err instanceof ProviderError && err.tooLong;
}

const TOO_LONG_RE = /maximum context length|too long|exceeds .*(token|length)|reduce the length/i;

/**
 * Scrubs anything credential-shaped out of a provider's error text before it
 * reaches a log line or an API response.
 *
 * The upstream body is server-generated and should never contain the request's
 * Authorization header — but "should never" is doing load-bearing work in that
 * sentence, and the cost of being wrong is a key in a log file the user later
 * pastes into a bug report. The body is worth surfacing (it is what diagnosed
 * the 512-token failure), so surface it scrubbed.
 */
function redact(text: string, apiKey?: string): string {
  let out = text;
  if (apiKey && apiKey.length >= 8) out = out.split(apiKey).join('[redacted]');
  return out
    .replace(/\b(?:sk|pk|rk|api|key|token)[-_][A-Za-z0-9_-]{8,}/gi, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer [redacted]');
}

const DEFAULTS = { maxRetries: 4, retryBaseMs: 500, timeoutMs: 60_000 };

/** 408/429 and 5xx are transient. 4xx otherwise means the request is wrong. */
function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  cfg: Required<Pick<ProviderConfig, 'maxRetries' | 'retryBaseMs' | 'timeoutMs'>>,
  label: string,
  apiKey?: string,
): Promise<unknown> {
  let lastStatus = 0;
  let lastBody = '';
  let attempts = 0;
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    attempts++;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
    } catch (err) {
      // A timeout or a dropped connection is the transient case by definition.
      if (attempt === cfg.maxRetries) {
        throw new ProviderError(0, `${label}: request failed — ${(err as Error).message}`);
      }
      await sleep(cfg.retryBaseMs * 2 ** attempt);
      continue;
    }

    if (res.ok) return res.json();

    lastStatus = res.status;
    // The response body is the server's own error text and never echoes a
    // request header, so it is safe to surface — and it is the only thing that
    // says *why* a 400 happened.
    lastBody = await res.text().catch(() => '');
    if (!isRetryable(res.status) || attempt === cfg.maxRetries) break;
    // Honour Retry-After when the server sends one; guessing is worse.
    const after = Number(res.headers.get('retry-after'));
    await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : cfg.retryBaseMs * 2 ** attempt);
  }
  let detail = '';
  try {
    const parsed = JSON.parse(lastBody) as { error?: { message?: string } | string };
    detail = typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message ?? '');
  } catch {
    detail = lastBody.slice(0, 200);
  }
  detail = redact(detail, apiKey);
  throw new ProviderError(
    lastStatus,
    `${label}: HTTP ${lastStatus} after ${attempts} attempt${attempts === 1 ? '' : 's'}` +
      (detail ? ` — ${detail}` : ''),
    TOO_LONG_RE.test(detail),
  );
}

function assertShape(vectors: number[][], expected: number, count: number, label: string): number[][] {
  if (vectors.length !== count) {
    throw new ProviderError(0, `${label}: asked for ${count} vectors, got ${vectors.length}`);
  }
  for (const v of vectors) {
    if (v.length !== expected) {
      throw new ProviderError(0, `${label}: dimension mismatch — expected ${expected}, got ${v.length}`);
    }
  }
  return vectors;
}

export function createProvider(cfg: ProviderConfig): EmbeddingProvider {
  const retry = {
    maxRetries: cfg.maxRetries ?? DEFAULTS.maxRetries,
    retryBaseMs: cfg.retryBaseMs ?? DEFAULTS.retryBaseMs,
    timeoutMs: cfg.timeoutMs ?? DEFAULTS.timeoutMs,
  };

  if (cfg.provider === 'together') {
    if (!cfg.apiKey) {
      throw new Error(
        'TOGETHER_API_KEY is not set. Add it to the vault-root .env, or set the embeddings source provider to "ollama".',
      );
    }
    const url = `${cfg.baseUrl ?? 'https://api.together.xyz/v1'}/embeddings`;
    const key = cfg.apiKey;
    return {
      id: 'together',
      model: cfg.model,
      dimensions: cfg.dimensions,
      async embed(texts) {
        if (texts.length === 0) return [];
        const body = (await postJson(
          url,
          { model: cfg.model, input: [...texts] },
          { Authorization: `Bearer ${key}` },
          retry,
          'together',
          key,
        )) as { data?: { index: number; embedding: number[] }[] };

        // The API does not promise response order matches request order, and
        // a silently transposed batch would mis-attribute every vector to the
        // wrong chunk — a bug that looks like "search is just bad".
        const out: number[][] = new Array(texts.length);
        for (const row of body.data ?? []) out[row.index] = row.embedding;
        if (out.some((v) => v === undefined)) {
          throw new ProviderError(0, 'together: response skipped an input index');
        }
        return assertShape(out, cfg.dimensions, texts.length, 'together');
      },
    };
  }

  const url = `${cfg.baseUrl ?? 'http://127.0.0.1:11434'}/api/embed`;
  return {
    id: 'ollama',
    model: cfg.model,
    dimensions: cfg.dimensions,
    async embed(texts) {
      if (texts.length === 0) return [];
      const body = (await postJson(url, { model: cfg.model, input: [...texts] }, {}, retry, 'ollama')) as {
        embeddings?: number[][];
      };
      return assertShape(body.embeddings ?? [], cfg.dimensions, texts.length, 'ollama');
    },
  };
}
