import { createHash } from 'node:crypto';
import { z } from 'zod';

/** Hard capacities are reviewer contracts, never plan-controlled settings. */
export const POLICY = Object.freeze({ version: 1, changedFiles: 100, reviewableFiles: 30, sources: 80,
  sourceChars: 80_000, diffChars: 250_000, combinedChars: 500_000, softTarget: 24 });
export const policyHash = createHash('sha256').update(JSON.stringify(POLICY)).digest('hex');
export const ScopeConfig = z.object({ softTarget: z.number().int().min(1).max(POLICY.reviewableFiles).default(POLICY.softTarget),
  exclude: z.array(z.string().min(1)).default([]) }).strict();
export type ScopeConfig = z.infer<typeof ScopeConfig>;
export type Observation = { changedFiles: number; reviewableFiles: number; sources: number; sourceChars: number; diffChars: number; combinedChars: number };
export type Reason = { code: string; observed?: number; allowed?: number; path?: string; action: string };
export type ScopeResult = { status: 'pass' | 'decompose' | 'invalid'; phase: 'forecast' | 'actual'; policyVersion: number;
  policyHash: string; limits: Omit<typeof POLICY, 'softTarget'> & { softTarget: number }; observations: Observation; reasons: Reason[]; binding?: { base: string; head?: string; planHash: string } };
export const emptyObservation = (): Observation => ({ changedFiles: 0, reviewableFiles: 0, sources: 0, sourceChars: 0, diffChars: 0, combinedChars: 0 });
export function evaluate(observations: Observation, phase: ScopeResult['phase'], config: Partial<ScopeConfig> = {}): ScopeResult {
  const parsed = ScopeConfig.safeParse(config), reasons: Reason[] = [];
  const limits = { ...POLICY, softTarget: parsed.success ? parsed.data.softTarget : POLICY.softTarget };
  let invalid = !parsed.success;
  if (invalid) reasons.push({ code: 'config', action: 'Use only softTarget (1 through the hard reviewable limit) and excluded path prefixes.' });
  for (const key of ['changedFiles', 'reviewableFiles', 'sources', 'sourceChars', 'diffChars', 'combinedChars'] as const) {
    const observed = observations[key];
    if (!Number.isSafeInteger(observed) || observed < 0) { invalid = true; reasons.push({ code: key, action: 'Provide a finite nonnegative character/file count.' }); }
    else if (observed > POLICY[key]) reasons.push({ code: key, observed, allowed: POLICY[key], action: 'Split into independently verifiable slices preserving every acceptance requirement; rerun preflight.' });
  }
  if (phase === 'forecast' && observations.reviewableFiles > limits.softTarget) reasons.push({ code: 'soft-target', observed: observations.reviewableFiles,
    allowed: limits.softTarget, action: 'Reduce planned scope or decompose before launching the builder, retaining tests and docs.' });
  return { status: invalid ? 'invalid' : reasons.length ? 'decompose' : 'pass', phase, policyVersion: POLICY.version, policyHash, limits, observations, reasons };
}
export function scopeObservation(files: { path: string }[], sources: { text: string }[], diff: string, reviewableCount = files.filter(f => isReviewable(f.path)).length, otherContextChars = 0): Observation {
  return { changedFiles: files.length, reviewableFiles: reviewableCount, sources: sources.length,
    sourceChars: Math.max(0, ...sources.map(s => s.text.length)), diffChars: diff.length,
    combinedChars: otherContextChars + diff.length + sources.reduce((n, s) => n + s.text.length, 0) };
}
// Kept here so selection, forecasts and adapter observations cannot drift.
export function isReviewable(path: string): boolean {
  return /\.(?:[cm]?[jt]sx?|py|rs|go|java|swift|sh|sql|ya?ml|toml|json|css|html|md)$/.test(path) && !/(?:^|\/)(?:package-lock\.json|[^/]*\.lock)$/.test(path);
}
export class CapacityError extends Error {
  constructor(readonly result: ScopeResult) { super(JSON.stringify(result)); }
}
export function requireCapacity(result: ScopeResult): void {
  if (result.status !== 'pass') throw new CapacityError(result);
}
