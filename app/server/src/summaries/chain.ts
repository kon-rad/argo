import { config } from '../config.js';
import { openAiCompatProvider } from '../llm/openaiCompat.js';
import { buildChatProvider } from '../llm/registry.js';
import { llmPresets } from '../llm/presets.js';
import { complete, redactSecrets, type ChatProvider, type ChatRequest, type ChatUsage } from '../llm/types.js';
import type { ChainEntry } from './config.js';

export interface Attempt {
  provider: string;
  model: string;
  ok: boolean;
  /** Why it was skipped or failed; never holds a key (redactSecrets). */
  error?: string;
  ms: number;
}

export interface ChainResult {
  text: string;
  usage: ChatUsage;
  provider: string;
  model: string;
  attempts: Attempt[];
}

export class ChainExhausted extends Error {
  constructor(readonly attempts: Attempt[]) {
    super(`no summary provider answered: ${attempts.map((a) => `${a.provider}/${a.model}: ${a.error ?? 'failed'}`).join('; ')}`);
    this.name = 'ChainExhausted';
  }
}

export interface ChainDeps {
  environment?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
}

/** One chain entry as a provider, or throws why it cannot be used here (no key, unknown provider). */
export function providerFor(entry: ChainEntry, deps: ChainDeps = {}): ChatProvider {
  const environment = deps.environment ?? process.env;
  const preset = llmPresets().providers[entry.provider];
  if (!preset) throw new Error(`unknown provider "${entry.provider}"`);
  const override = entry.baseUrl ?? (entry.baseUrlEnv ? environment[entry.baseUrlEnv]?.trim() : undefined);
  // A home server (or any OpenAI-compatible address) named by the entry or its variable.
  const root = override ?? (entry.provider === 'ollama' ? config.ollamaUrl : null);
  if (root && preset.protocol === 'openai') {
    const trimmed = root.replace(/\/+$/, '');
    return openAiCompatProvider({
      id: entry.provider,
      model: entry.model,
      baseUrl: trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`,
      timeoutMs: entry.timeoutMs,
      body: entry.body,
      apiKey: preset.env ? environment[preset.env]?.trim() || undefined : undefined,
      fetchFn: deps.fetchFn,
    });
  }
  return buildChatProvider(entry.provider, entry.model, { environment, fetchFn: deps.fetchFn });
}

/**
 * Tries each provider in order. A provider that is unconfigured, unreachable, times out or
 * returns an empty answer is skipped with the reason recorded; `accept` lets the caller reject a
 * reply that does not parse so the next provider gets a turn.
 */
export async function completeWithFallback(
  chain: ChainEntry[],
  req: ChatRequest,
  deps: ChainDeps & { accept?: (text: string) => boolean } = {},
): Promise<ChainResult> {
  const attempts: Attempt[] = [];
  for (const entry of chain) {
    const t0 = Date.now();
    try {
      const provider = providerFor(entry, deps);
      const { text, usage } = await complete(provider, req);
      if (!text.trim()) throw new Error('empty answer');
      if (deps.accept && !deps.accept(text)) throw new Error('answer did not match the summary schema');
      attempts.push({ provider: entry.provider, model: entry.model, ok: true, ms: Date.now() - t0 });
      return { text, usage, provider: entry.provider, model: entry.model, attempts };
    } catch (err) {
      attempts.push({ provider: entry.provider, model: entry.model, ok: false, error: redactSecrets((err as Error).message).slice(0, 300), ms: Date.now() - t0 });
    }
  }
  throw new ChainExhausted(attempts);
}
