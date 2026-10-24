import type { LoadedSchema } from './schema.js';

/**
 * TypeSafe's System One protocol, as pi-ai 1.4.0 speaks it (api/system-one-shared.js): one POST to
 * `<base>/systemone` with the state and the questions, bearer auth, calibrated answers back. OpenRouter
 * serves the same protocol under its own base URL and model ids (`typesafe/jev-1.14`), so the owner's
 * one OpenRouter key is enough; a direct TypeSafe key is the other option.
 */
export type ClassifyProvider = 'openrouter' | 'typesafe';

export const BASE_URLS: Record<ClassifyProvider, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  typesafe: 'https://api.typesafe.ai/v1',
};

/** `openrouter/typesafe/jev-1.14` → `typesafe/jev-1.14` on OpenRouter, `jev-1.14` on TypeSafe directly. */
export function modelIdFor(provider: ClassifyProvider, spec: string): string {
  const parts = spec.split('/').filter(Boolean);
  if (provider === 'typesafe') return parts[parts.length - 1]!;
  return parts[0] === 'openrouter' ? parts.slice(1).join('/') : parts.join('/');
}

/** The wire question: pi-ai's ClassifierQuestion with `bool` written as the wire-level `noul`. */
export type WireQuestion =
  | { type: 'noul'; instructions: string; criteria: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

export function wireQuestion(s: LoadedSchema): WireQuestion {
  if (s.primitive === 'bool') {
    const c = (s.criteria && !Array.isArray(s.criteria) ? s.criteria : {}) as Record<string, string>;
    return { type: 'noul', instructions: s.question, criteria: { true: c['true'] ?? 'yes', false: c['false'] ?? 'no' } };
  }
  if (s.primitive === 'choice') {
    const c = (s.criteria && !Array.isArray(s.criteria) ? s.criteria : {}) as Record<string, string>;
    return { type: 'choice', instructions: s.question, criteria: Object.fromEntries(s.options!.map((o) => [o, c[o] ?? o])) };
  }
  const levels = Array.isArray(s.criteria) ? s.criteria : Array.from({ length: s.max! - s.min! + 1 }, (_, i) => String(s.min! + i));
  return { type: 'score', instructions: s.question, criteria: levels };
}

export interface WireRequest {
  model: string;
  state: Record<string, unknown>;
  questions: { answer: WireQuestion };
}

export type WireAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; confidence: number };

export interface JevReply {
  answer: WireAnswer;
  inputTokens: number | null;
  latencyMs: number;
}

export interface JevOptions {
  provider: ClassifyProvider;
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  baseUrl?: string;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function parseAnswer(raw: unknown, s: LoadedSchema): WireAnswer {
  const a = raw as Record<string, unknown> | undefined;
  if (!a || typeof a !== 'object') throw new Error('no answer in the response');
  if (s.primitive === 'bool') {
    if (a.type !== 'noul' || !isNum(a.noul)) throw new Error('expected a noul answer');
    return { type: 'noul', noul: a.noul };
  }
  if (s.primitive === 'choice') {
    if (a.type !== 'choice' || typeof a.choice !== 'string' || !isNum(a.confidence) || !a.probabilities || typeof a.probabilities !== 'object') {
      throw new Error('expected a choice answer');
    }
    const probabilities: Record<string, number> = {};
    for (const [k, v] of Object.entries(a.probabilities as Record<string, unknown>)) {
      if (!isNum(v)) throw new Error(`probability for ${k} is not a number`);
      probabilities[k] = v;
    }
    return { type: 'choice', choice: a.choice, probabilities, confidence: a.confidence };
  }
  if (a.type !== 'score' || !isNum(a.score) || !isNum(a.confidence)) throw new Error('expected a score answer');
  return { type: 'score', score: a.score, confidence: a.confidence };
}

/**
 * One classification, 2 s per attempt, one retry on a network error or a 5xx. Throws on failure; the
 * caller turns that into a fallthrough row. A 4xx is final: the request is wrong, not the network.
 */
export async function askJev(s: LoadedSchema, state: Record<string, unknown>, modelSpec: string, opts: JevOptions): Promise<JevReply> {
  const f = opts.fetch ?? fetch;
  const timeout = opts.timeoutMs ?? 2000;
  const base = (opts.baseUrl ?? BASE_URLS[opts.provider]).replace(/\/+$/, '');
  const body: WireRequest = { model: modelIdFor(opts.provider, modelSpec), state, questions: { answer: wireQuestion(s) } };
  const started = Date.now();
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await f(`${base}/systemone`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      if (res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const json = (await res.json()) as { answers?: Record<string, unknown>; usage?: { input_tokens?: unknown } };
      const answer = parseAnswer(json.answers?.answer, s);
      const inputTokens = isNum(json.usage?.input_tokens) ? json.usage!.input_tokens : null;
      return { answer, inputTokens, latencyMs: Date.now() - started };
    } catch (err) {
      const e = err as Error;
      // Only a timeout or a connection failure is worth a second try; a bad answer is not.
      if (e.name === 'AbortError') lastErr = new Error('timeout');
      else if (/^HTTP 4|expected a|no answer|not a number/.test(e.message)) throw e;
      else lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new Error('classifier failed');
}
