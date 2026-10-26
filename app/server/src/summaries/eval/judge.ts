import { z } from 'zod';
import { completeWithFallback, type ChainDeps } from '../chain.js';
import type { ChainEntry } from '../config.js';
import type { ModelSummary } from '../schema.js';

/**
 * A model grades a summary against the transcript it came from. Never the only gate: the rubric is
 * fixed, scores are 1 to 5, and a judge from the same family as the writer is a known bias, so the
 * eval config may name a different chain. The deterministic checks (checks.ts) run first and decide CI.
 */
export const RUBRIC_VERSION = 'j1';

const Score = z.coerce.number().int().min(1).max(5);
export const JudgeVerdict = z.object({
  faithful: Score,
  complete: Score,
  concise: Score,
  outcome_correct: Score,
  unsupported: z.array(z.string()).max(8).default([]),
  missed: z.array(z.string()).max(8).default([]),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdict>;

const SYSTEM = `You grade a written summary of an AI agent work session against the transcript it was written from.
Score each from 1 (bad) to 5 (excellent):
- faithful: every statement is supported by the transcript; 1 means invented content.
- complete: the main request, the work done and the open items are all there.
- concise: no filler, no repetition.
- outcome_correct: the stated outcome (finished, partial, blocked, failed, unknown) matches how the transcript ends.
List each unsupported statement in "unsupported" and each important thing the summary left out in "missed" (short phrases).
Answer with one JSON object only: {"faithful":1,"complete":1,"concise":1,"outcome_correct":1,"unsupported":[],"missed":[]}`;

export function parseVerdict(raw: string): JudgeVerdict | null {
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/g, '');
  const a = cleaned.indexOf('{');
  const b = cleaned.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try {
    const v = JudgeVerdict.safeParse(JSON.parse(cleaned.slice(a, b + 1)));
    return v.success ? v.data : null;
  } catch {
    return null;
  }
}

export async function judge(transcript: string, summary: ModelSummary, chain: ChainEntry[], deps: ChainDeps = {}): Promise<{ verdict: JudgeVerdict; provider: string; model: string }> {
  const body = `TRANSCRIPT\n${transcript}\n\nSUMMARY\nrequest: ${summary.request}\ndone: ${summary.done}\nlearned: ${summary.learned}\nopen_items: ${summary.open_items}\noutcome: ${summary.outcome}`;
  const r = await completeWithFallback(chain, { system: SYSTEM, messages: [{ role: 'user', content: body }], maxTokens: 600, temperature: 0 }, { ...deps, accept: (t) => parseVerdict(t) !== null });
  return { verdict: parseVerdict(r.text)!, provider: r.provider, model: r.model };
}

/** 0 to 1: the mean of the four scores, rescaled. Faithfulness counts double because an invented claim costs more than a missing one. */
export function verdictScore(v: JudgeVerdict): number {
  const weighted = (v.faithful * 2 + v.complete + v.concise + v.outcome_correct) / 5;
  return Math.round(((weighted - 1) / 4) * 1000) / 1000;
}
