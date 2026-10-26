import type { createModels, Models } from '@earendil-works/pi-ai';
import type { MachineConfig, ProviderConfig, ProviderModelConfig, ZenConfig } from './config.js';
import { customProvider } from './models.js';

/**
 * Connected computers: machines that run Ollama and that this process can reach over the network. Each becomes a
 * provider `ollama-<name>` whose models are whatever the machine has installed right now (`GET /api/tags`), so a model
 * pulled on the machine shows up here without editing a file. The endpoint is Ollama's OpenAI-compatible `/v1`.
 */

export const machineProviderId = (name: string): string => `ollama-${name}`;

const NAME = /^[a-z0-9][a-z0-9_-]*$/;

/** `box1=http://192.0.2.10:11434,box2=...` (the OLLAMA_MACHINES variable). Bad entries are skipped. */
export function parseMachines(raw: string | undefined): Record<string, MachineConfig> {
  const out: Record<string, MachineConfig> = {};
  for (const part of (raw ?? '').split(',')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    const url = part.slice(eq + 1).trim().replace(/\/+$/, '');
    if (NAME.test(name) && /^https?:\/\/\S+$/.test(url)) out[name] = { url };
  }
  return out;
}

/** The provider config a machine's discovered models make. */
export function machineProvider(name: string, m: MachineConfig, models: ProviderModelConfig[]): ProviderConfig {
  return { api: 'openai-completions', baseUrl: `${m.url.replace(/\/+$/, '')}/v1`, name: `Ollama · ${m.name ?? name}`, apiKeyEnv: null, models };
}

interface Tag { name?: string; model?: string; details?: { family?: string; families?: string[] | null } }
interface Show { capabilities?: string[]; model_info?: Record<string, unknown> }

const DEFAULT_CONTEXT = 32_000;
const MAX_TOKENS = 8_192;

async function getJson<T>(f: typeof fetch, url: string, ms: number, init?: RequestInit): Promise<T> {
  const res = await f(url, { ...init, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * The chat models a machine has installed, or null when it does not answer. Embedding models are left out. The
 * context window is the smaller of the model's own and `m.contextWindow` (default 32 000): the OpenAI-compatible
 * endpoint cannot ask for a window, the server's `OLLAMA_CONTEXT_LENGTH` decides, so set it to that.
 */
export async function discoverMachine(m: MachineConfig, f: typeof fetch = fetch, ms = 2500): Promise<ProviderModelConfig[] | null> {
  const base = m.url.replace(/\/+$/, '');
  let tags: Tag[];
  try {
    tags = (await getJson<{ models?: Tag[] }>(f, `${base}/api/tags`, ms)).models ?? [];
  } catch {
    return null;
  }
  const cap = m.contextWindow ?? DEFAULT_CONTEXT;
  const rows = await Promise.all(
    tags.map(async (t): Promise<ProviderModelConfig | null> => {
      const id = t.model ?? t.name;
      if (!id) return null;
      let show: Show | null = null;
      try {
        show = await getJson<Show>(f, `${base}/api/show`, ms, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: id }) });
      } catch {
        // An older server or a slow one: fall back to the names.
      }
      const caps = show?.capabilities;
      const families = [t.details?.family ?? '', ...(t.details?.families ?? [])].join(' ');
      const embedding = caps ? !caps.includes('completion') : /bert/i.test(families) || /embed/i.test(id);
      if (embedding) return null;
      const info = show?.model_info ?? {};
      const arch = typeof info['general.architecture'] === 'string' ? (info['general.architecture'] as string) : null;
      const own = arch ? Number(info[`${arch}.context_length`]) : NaN;
      const noTools = caps ? !caps.includes('tools') : false;
      return {
        id,
        name: noTools ? `${id} (no tool calling)` : id,
        contextWindow: Number.isFinite(own) && own > 0 ? Math.min(own, cap) : cap,
        maxTokens: MAX_TOKENS,
        reasoning: caps ? caps.includes('thinking') : false,
        input: caps?.includes('vision') ? ['text', 'image'] : ['text'],
      };
    }),
  );
  return rows.filter((r): r is ProviderModelConfig => r !== null).sort((a, b) => a.id.localeCompare(b.id));
}

/** What `createModels()` returns: the catalogue with its writer. `buildModels` hands it out typed as the read-only `Models`. */
type Registry = ReturnType<typeof createModels>;

/**
 * Probes every configured machine and (re)registers its provider in `models`. A machine that stops answering keeps
 * the models it had last time, so the picker can grey them out instead of dropping them; one never seen is
 * registered empty. Returns the providers registered, keyed by provider id, for the catalogue.
 */
export async function refreshMachines(
  models: Models,
  machines: ZenConfig['machines'],
  known: Map<string, ProviderModelConfig[]>,
  f: typeof fetch = fetch,
  ms = 2500,
): Promise<Map<string, { config: ProviderConfig; reachable: boolean }>> {
  const out = new Map<string, { config: ProviderConfig; reachable: boolean }>();
  await Promise.all(
    Object.entries(machines).map(async ([name, m]) => {
      const found = await discoverMachine(m, f, ms);
      const id = machineProviderId(name);
      if (found) known.set(id, found);
      const config = machineProvider(name, m, found ?? known.get(id) ?? []);
      (models as Registry).setProvider(customProvider(id, config));
      out.set(id, { config, reachable: found !== null });
    }),
  );
  return out;
}
