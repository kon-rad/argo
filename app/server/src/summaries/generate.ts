import { redactor } from '../archive/redact.js';
import { completeWithFallback, type Attempt, type ChainDeps } from './chain.js';
import type { SummaryConfig } from './config.js';
import { parseModelSummary, SYSTEM_PROMPT, type ModelSummary } from './schema.js';

export interface Generated {
  summary: ModelSummary;
  provider: string;
  model: string;
  attempts: Attempt[];
  inputTokens: number | null;
  outputTokens: number | null;
}

export function scrub(s: ModelSummary): ModelSummary {
  const r = redactor();
  return {
    request: r.text(s.request),
    done: r.text(s.done),
    learned: r.text(s.learned),
    open_items: r.text(s.open_items),
    outcome: s.outcome,
    facts: s.facts.map((f) => ({ subject: r.text(f.subject), claim: r.text(f.claim) })),
  };
}

/** The model step alone: compacted transcript in, a parsed and scrubbed summary out. No database. Used by the runner and the evals. */
export async function generate(
  transcript: string,
  meta: { harness?: string | null; host?: string | null; title?: string | null },
  cfg: SummaryConfig,
  deps: ChainDeps = {},
): Promise<Generated> {
  const header = `Session: ${meta.harness ?? 'agent'}${meta.host ? ` on ${meta.host}` : ''}${meta.title ? `, titled "${meta.title}"` : ''}`;
  const result = await completeWithFallback(
    cfg.chain,
    { system: SYSTEM_PROMPT, messages: [{ role: 'user', content: `${header}\n\n${transcript}` }], maxTokens: 1200, temperature: 0.2 },
    { ...deps, accept: (t) => parseModelSummary(t) !== null },
  );
  return {
    summary: scrub(parseModelSummary(result.text)!),
    provider: result.provider,
    model: result.model,
    attempts: result.attempts,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
  };
}
