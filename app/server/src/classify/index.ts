import type { ClassifyInput, ClassifyResult } from './types.js';

export * from './types.js';

/**
 * Asks the classifier one decision about one state. Falls through (action `fallthrough`) whenever it
 * cannot answer: no provider configured, the source is not on the privacy allow list, the daily token
 * cap is spent, or the provider fails. Callers treat fallthrough as "do what you did before".
 *
 * Placeholder: the engine's classify step is built in app/server/src/classify/ (see docs/zen-runtime.md).
 */
export async function classify(input: ClassifyInput): Promise<ClassifyResult> {
  return {
    decision: input.decision, schemaVersion: '0', action: 'fallthrough', answer: null, probabilities: null,
    confidence: null, model: null, latencyMs: null, inputTokens: null, costUsd: null, error: 'not-configured', cached: false, id: null,
  };
}
