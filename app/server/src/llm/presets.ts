import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { config } from '../config.js';
import { settings, type ChatSettingsOverrides } from '../settings.js';

/**
 * Which chat providers exist and which models the app offers for each. The
 * engine ships a generic list in `app/config/llm-presets.json`; a vault adds
 * or replaces models for a provider, or picks its defaults, in
 * `secondbrain.json` under `chat`. Keys never live here: a provider is
 * *available* only when its environment variable is set.
 */

const Model = z.object({
  id: z.string().min(1),
  label: z.string().min(1).optional(),
});

const Provider = z.object({
  label: z.string().min(1),
  protocol: z.enum(['anthropic', 'openai']),
  /** The environment variable that holds the key; null for a local server that needs none. */
  env: z.string().min(1).nullable(),
  baseUrl: z.string().min(1),
  default: z.string().min(1),
  models: z.array(Model).min(1),
});

const Presets = z.object({
  defaultProvider: z.string().min(1),
  systemPrompt: z.string().min(1),
  providers: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), Provider),
});

export type ModelPreset = z.infer<typeof Model>;
export type ProviderPreset = z.infer<typeof Provider>;
export type LlmPresets = z.infer<typeof Presets>;

export const PRESETS_FILE = join(config.appRoot, 'config', 'llm-presets.json');

export function parsePresets(raw: unknown): LlmPresets {
  return Presets.parse(raw);
}

let cached: LlmPresets | null = null;

/** The engine's presets merged with the vault's `chat` overrides. Read once per process. */
export function llmPresets(overrides: ChatSettingsOverrides = settings().chat): LlmPresets {
  if (!cached) cached = parsePresets(JSON.parse(readFileSync(PRESETS_FILE, 'utf8')));
  return mergePresets(cached, overrides);
}

export function resetPresets(): void {
  cached = null;
}

/**
 * A vault's `chat.providers.<id>` entry adds models (by id, deduplicated) and
 * may change the provider's default model or base URL; it cannot invent a
 * protocol. `chat.defaultProvider` and `chat.systemPrompt` replace the
 * engine's. Unknown provider ids are ignored rather than fatal.
 */
export function mergePresets(base: LlmPresets, overrides: ChatSettingsOverrides): LlmPresets {
  const providers: Record<string, ProviderPreset> = {};
  for (const [id, p] of Object.entries(base.providers)) {
    const o = overrides.providers[id];
    if (!o) {
      providers[id] = p;
      continue;
    }
    const seen = new Set(p.models.map((m) => m.id));
    const added = (o.models ?? []).filter((m) => !seen.has(m.id));
    providers[id] = {
      ...p,
      baseUrl: o.baseUrl ?? p.baseUrl,
      default: o.default ?? p.default,
      models: [...p.models, ...added],
    };
  }
  return {
    defaultProvider: overrides.defaultProvider && providers[overrides.defaultProvider] ? overrides.defaultProvider : base.defaultProvider,
    systemPrompt: overrides.systemPrompt ?? base.systemPrompt,
    providers,
  };
}
