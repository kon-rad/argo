import { config, type OllamaMachine } from '../config.js';
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
  /** A connected computer running Ollama (id `ollama-<name>`), its models found live. */
  machine?: boolean;
  /** A machine that did not answer: listed, but it cannot be picked. */
  offline?: boolean;
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

const DISCOVERY_TIMEOUT_MS = 2500;
const DISCOVERY_TTL_MS = 20_000;

interface Discovered {
  at: number;
  models: ModelPreset[] | null;
}
const discovery = new Map<string, Discovered>();

/** Forgets what the connected machines reported; tests call it between cases. */
export function resetMachineCache(): void {
  discovery.clear();
}

interface OllamaTag {
  name?: unknown;
  details?: { family?: unknown; families?: unknown };
}

/** Embedding models cannot chat: BERT-family weights or an "embed" in the name. */
function isEmbeddingModel(t: OllamaTag, name: string): boolean {
  const fams = [t.details?.family, ...(Array.isArray(t.details?.families) ? t.details.families : [])];
  return name.toLowerCase().includes('embed') || fams.some((f) => typeof f === 'string' && f.toLowerCase().includes('bert'));
}

/** The chat models one machine reports, or null when it did not answer. Cached ~20 s. */
export async function discoverMachineModels(m: OllamaMachine, fetchFn: typeof fetch = fetch): Promise<ModelPreset[] | null> {
  const hit = discovery.get(m.url);
  if (hit && Date.now() - hit.at < DISCOVERY_TTL_MS) return hit.models;
  let models: ModelPreset[] | null = null;
  try {
    const res = await fetchFn(`${m.url}/api/tags`, { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
    if (res.ok) {
      const body = (await res.json()) as { models?: OllamaTag[] };
      models = (Array.isArray(body.models) ? body.models : [])
        .filter((t): t is OllamaTag & { name: string } => typeof t.name === 'string' && t.name.length > 0)
        .filter((t) => !isEmbeddingModel(t, t.name))
        .map((t) => ({ id: t.name, label: t.name }));
    }
  } catch {
    /* offline or slow: the machine is listed as offline */
  }
  discovery.set(m.url, { at: Date.now(), models });
  return models;
}

/** One provider per connected machine; offline ones stay in the list with configured: false. */
export async function machineProviders(machines: OllamaMachine[] = config.ollamaMachines, fetchFn?: typeof fetch): Promise<ProviderOption[]> {
  const found = await Promise.allSettled(machines.map((m) => discoverMachineModels(m, fetchFn)));
  return machines.map((m, i) => {
    const r = found[i]!;
    const models = r.status === 'fulfilled' && r.value ? r.value : [];
    const up = models.length > 0;
    return {
      id: `ollama-${m.name}`,
      label: `Ollama · ${m.name}`,
      configured: up,
      env: null,
      default: models[0]?.id ?? '',
      models,
      machine: true,
      ...(up ? {} : { offline: true }),
    };
  });
}

export interface AsyncCatalogOptions {
  presets?: LlmPresets;
  environment?: NodeJS.ProcessEnv;
  machines?: OllamaMachine[];
  fetchFn?: typeof fetch;
}

/** The catalog plus the connected machines, discovered live. Never throws because of a machine. */
export async function providerCatalogWithMachines(opts: AsyncCatalogOptions = {}): Promise<ProviderCatalog> {
  const base = providerCatalog(opts.presets, opts.environment);
  const extra = await machineProviders(opts.machines, opts.fetchFn);
  return { ...base, providers: [...base.providers, ...extra] };
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
  /** Connected Ollama machines; defaults to OLLAMA_MACHINES. */
  machines?: OllamaMachine[];
}

/** Throws when the provider is unknown or its key is missing. */
export function buildChatProvider(id: string, model: string, opts: BuildOptions = {}): ChatProvider {
  const presets = opts.presets ?? llmPresets();
  const environment = opts.environment ?? process.env;
  const machine = id.startsWith('ollama-') ? (opts.machines ?? config.ollamaMachines).find((m) => `ollama-${m.name}` === id) : undefined;
  if (machine) return openAiCompatProvider({ id, model, baseUrl: `${machine.url}/v1`, apiKey: undefined, fetchFn: opts.fetchFn });
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
