import { createModels, createProvider, envApiKeyAuth, type Model, type Models } from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import type { ProviderConfig, ZenConfig } from './config.js';

/**
 * The model catalogue: every provider pi-ai ships (keys resolve from the
 * environment, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`,
 * `TOGETHER_API_KEY`, ...) plus the endpoints zen.json adds under `providers`
 * (Ollama, vLLM, a proxy: anything that speaks OpenAI chat completions or
 * Anthropic messages). Changing provider or model is a string.
 */
export function buildModels(cfg: Pick<ZenConfig, 'providers'>): Models {
  const models = createModels();
  for (const p of builtinProviders()) models.setProvider(p);
  for (const [id, p] of Object.entries(cfg.providers)) models.setProvider(customProvider(id, p));
  return models;
}

export function customProvider(id: string, p: ProviderConfig) {
  const name = p.name ?? id;
  const auth = p.apiKeyEnv
    ? { apiKey: envApiKeyAuth(`${name} API key`, [p.apiKeyEnv]) }
    : { apiKey: { name, resolve: async () => ({ auth: {} }) } };
  const list = p.models.map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    api: p.api,
    provider: id,
    baseUrl: p.baseUrl,
    reasoning: m.reasoning ?? false,
    input: m.input ?? ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.contextWindow ?? 128_000,
    maxTokens: m.maxTokens ?? 16_000,
  })) as Model<any>[];
  return createProvider({
    id,
    name,
    baseUrl: p.baseUrl,
    auth,
    models: list,
    api: p.api === 'anthropic-messages' ? anthropicMessagesApi() : openAICompletionsApi(),
  } as Parameters<typeof createProvider>[0]);
}

/** `provider/model`, or a bare model id found in any provider (first match). */
export function pickModel(models: Models, spec: string): Model<any> {
  const slash = spec.indexOf('/');
  if (slash > 0) {
    const provider = spec.slice(0, slash);
    const id = spec.slice(slash + 1);
    const m = models.getModel(provider, id);
    if (m) return m;
    if (models.getProvider(provider)) throw new Error(`model ${id} is not in provider ${provider}'s catalogue`);
    // An OpenRouter-style id ("openai/gpt-5") that belongs to a provider of its own.
  }
  const any = models.getModels().find((m) => m.id === spec);
  if (any) return any;
  throw new Error(`unknown model "${spec}"; use provider/model (zen-agent models lists them)`);
}

/** The configured providers whose key (or keyless auth) resolves right now. */
export async function availableProviders(models: Models): Promise<string[]> {
  const out: string[] = [];
  for (const p of models.getProviders()) {
    try {
      if (await models.getAuth(p.id)) out.push(p.id);
    } catch {
      // A broken credential store entry is "not available", not a crash.
    }
  }
  return out.sort();
}
