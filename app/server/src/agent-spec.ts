/**
 * What an agent may run on. One rule set, used when the roster is imported (org.yaml) and when an override is
 * written (`cli-org set`), so a pair no adapter can run is refused before it costs a wake. Cutover plan 5a, item 5:
 * ravi shipped as zen-agent with model `sonnet`, which zen-agent cannot route (it needs provider/model).
 */

/** Runtimes a dispatcher can start today. `codex` is in the roster schema but has no adapter. */
export const ADAPTER_RUNTIMES: ReadonlySet<string> = new Set(['claude-code', 'zen-agent', 'hermes']);

/** Runtimes nothing claims for: the owner and the vault session. They carry no model rule. */
const UNCLAIMED_RUNTIMES: ReadonlySet<string> = new Set(['human', 'session']);

const ANTHROPIC_ALIAS = /^(opus|sonnet|haiku)(\[1m\])?$|^claude-[a-z0-9][a-z0-9.-]*(\[1m\])?$/;
const PROVIDER_MODEL = /^[a-z0-9][a-z0-9._-]*\/[^\s/][^\s]*$/i;
export const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface AgentSpec {
  runtime: string;
  model?: string | null;
  effort?: string | null;
}

/** Why this runtime, model and effort cannot run, or null when they can. */
export function agentSpecProblem(s: AgentSpec): string | null {
  if (UNCLAIMED_RUNTIMES.has(s.runtime)) return null;
  if (!ADAPTER_RUNTIMES.has(s.runtime)) {
    return `runtime "${s.runtime}" has no adapter; the dispatchers run ${[...ADAPTER_RUNTIMES].sort().join(', ')}`;
  }
  if (s.effort != null && !EFFORTS.includes(s.effort)) return `effort "${s.effort}" is not one of ${EFFORTS.join(', ')}`;
  if (!s.model) return null;
  if (s.runtime === 'claude-code' && !ANTHROPIC_ALIAS.test(s.model)) {
    return `claude-code needs an Anthropic alias (opus, sonnet, haiku or a claude-* id), not "${s.model}"; for another provider use runtime zen-agent`;
  }
  if (s.runtime === 'zen-agent' && !PROVIDER_MODEL.test(s.model)) {
    return `zen-agent needs a provider/model such as openrouter/deepseek/deepseek-v4.1-flash, not "${s.model}"`;
  }
  return null;
}
