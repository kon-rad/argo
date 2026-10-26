import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { StepPart } from '../../archive/steps.js';
import { OUTCOMES } from '../schema.js';

/**
 * A golden case is a hand-checked fake transcript with what a good summary must contain. Fixtures are
 * invented data (the engine repo never holds real transcripts); a vault can point `--golden` at a folder of its own.
 */
const Part = z.object({
  step: z.enum(['prompt', 'response', 'thinking', 'tool_call', 'tool_result', 'system', 'meta']),
  text: z.string(),
  toolName: z.string().nullable().default(null),
  isError: z.boolean().nullable().default(null),
});

export const GoldenCase = z.object({
  id: z.string().min(1),
  note: z.string().default(''),
  harness: z.string().default('claude-code'),
  parts: z.array(Part).min(1),
  expect: z.object({
    outcome: z.enum(OUTCOMES).optional(),
    mustMention: z.array(z.array(z.string().min(1)).min(1)).optional(),
    mustNotMention: z.array(z.string().min(1)).optional(),
    filesEdited: z.array(z.string()).optional(),
    cards: z.array(z.string()).optional(),
  }),
  /** A hand-written summary used to prove the checks themselves: it must score at or above `minScore`. */
  reference: z.object({
    request: z.string(), done: z.string(), learned: z.string().default(''), open_items: z.string().default(''),
    outcome: z.enum(OUTCOMES), facts: z.array(z.object({ subject: z.string(), claim: z.string() })).default([]),
  }).optional(),
  minScore: z.number().min(0).max(1).default(0.8),
});
export type GoldenCase = z.infer<typeof GoldenCase>;

export function toParts(c: GoldenCase): StepPart[] {
  return c.parts.map((p, i) => ({ key: `${c.id}:${i}`, step: p.step, text: p.text, toolName: p.toolName, toolCallId: null, isError: p.isError }));
}

export function loadGolden(dir: string): GoldenCase[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => GoldenCase.parse(JSON.parse(readFileSync(join(dir, f), 'utf8'))));
}
