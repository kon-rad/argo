import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { config } from '../config.js';
import { settings } from '../settings.js';

/**
 * Where summaries are written and by whom. The engine ships `app/config/summaries.json`
 * (a home server's local model first, then two paid fallbacks); a vault overrides any
 * field under `summaries` in `secondbrain.json`. Keys and addresses are never here: a
 * provider's key is its preset's environment variable, a home server's address is read from
 * the variable `baseUrlEnv` names.
 */
const Entry = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  baseUrl: z.string().min(1).optional(),
  baseUrlEnv: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
  /** Extra request fields for this provider, e.g. {"reasoning_effort": "none"} so a thinking model answers directly. */
  body: z.record(z.string(), z.unknown()).optional(),
});
const File = z.object({
  chain: z.array(Entry).min(1),
  minSteps: z.number().int().min(1),
  quietMinutes: z.number().int().min(1),
  maxInputChars: z.number().int().min(2000),
});

export type ChainEntry = z.infer<typeof Entry>;
export type SummaryConfig = z.infer<typeof File>;

export const SUMMARIES_FILE = join(config.appRoot, 'config', 'summaries.json');

let cached: SummaryConfig | null = null;

export function summaryConfig(overrides: ReturnType<typeof settings>['summaries'] = settings().summaries): SummaryConfig {
  if (!cached) cached = File.parse(JSON.parse(readFileSync(SUMMARIES_FILE, 'utf8')));
  return {
    chain: overrides.chain ?? cached.chain,
    minSteps: overrides.minSteps ?? cached.minSteps,
    quietMinutes: overrides.quietMinutes ?? cached.quietMinutes,
    maxInputChars: overrides.maxInputChars ?? cached.maxInputChars,
  };
}

export function resetSummaryConfig(): void { cached = null; }
