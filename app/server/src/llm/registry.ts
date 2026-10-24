import { config } from '../config.js';
import { anthropicProvider } from './anthropic.js';
import { openAiCompatProvider } from './openaiCompat.js';
import { llmPresets, type LlmPresets, type ModelPreset } from './presets.js';
import type { ChatProvider } from './types.js';

export interface ProviderOption {
  id: string;
  label: string;
  /** Its key is set (or it needs none), so the settings modal may offer it. */
  configured: boolean;
  /** Which variable to set when it is not. */
  env: string | null;
  default: string;
  models: ModelPreset[];
}

export interface ProviderCatalog {
  defaultProvider: string;
  systemPrompt: string;
  providers: ProviderOption[];
}

/** The key for a provider, from the environment the app started with. */
function keyFor(env: string | null, environment: NodeJS.ProcessEnv): string | undefined {
  if (!env) return undefined;
  const v = environment[env];
  return v && v.trim() ? v : undefined;
}

/** What the settings modal shows: every preset, marked configured or not. */
export function providerCatalog(presets: LlmPresets = llmPresets(), environment: NodeJS.ProcessEnv = process.env): ProviderCatalog {
  return {
    defaultProvider: presets.defaultProvider,
    systemPrompt: presets.systemPrompt,
    providers: Object.entries(presets.providers).map(([id, p]) => ({
      id,
      label: p.label,
      configured: p.env === null || Boolean(keyFor(p.env, environment)),
      env: p.env,
      default: p.default,
      models: p.models,
    })),
  };
}

/**
 * The provider to use when settings name none, or name one that is not
 * configured here: the presets' default if its key is set, else the first
 * configured one. Returns null when no chat model can be called at all.
 */
export function pickProvider(catalog: ProviderCatalog, wanted?: string | null): ProviderOption | null {
  const configured = catalog.providers.filter((p) => p.configured);
  return (
    configured.find((p) => p.id === wanted) ??
    configured.find((p) => p.id === catalog.defaultProvider) ??
    configured[0] ??
    null
  );
}

export interface BuildOptions {
  presets?: LlmPresets;
  environment?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
}

/** Throws when the provider is unknown or its key is missing. */
export function buildChatProvider(id: string, model: string, opts: BuildOptions = {}): ChatProvider {
  const presets = opts.presets ?? llmPresets();
  const environment = opts.environment ?? process.env;
  const preset = presets.providers[id];
  if (!preset) throw new Error(`unknown chat provider "${id}"`);
  const apiKey = keyFor(preset.env, environment);
  if (preset.env && !apiKey) throw new Error(`${preset.env} is not set, so the ${preset.label} provider cannot be used`);

  if (preset.protocol === 'anthropic') {
    return anthropicProvider({ model, apiKey: apiKey!, baseUrl: preset.baseUrl, fetchFn: opts.fetchFn });
  }
  // Ollama's OpenAI-compatible endpoint lives under the same host as its native API.
  const baseUrl = id === 'ollama' && !environment['OLLAMA_URL'] ? preset.baseUrl : id === 'ollama' ? `${config.ollamaUrl}/v1` : preset.baseUrl;
  return openAiCompatProvider({
    id,
    model,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    fetchFn: opts.fetchFn,
    ...(id === 'openrouter' ? { headers: { 'X-Title': 'secondbrain' } } : {}),
  });
}
