/**
 * The classify step (docs/zen-runtime.md, section 4.2): a calibrated classifier answers a typed question
 * about one state (a board message, a card, a run's result) and the caller acts only above a threshold.
 * Every call, including a refused or failed one, is one classify_decisions row.
 */
export type Primitive = 'bool' | 'choice' | 'score';

export interface DecisionSchema {
  /** `wake-gate`, `card-tier`, `run-outcome`, or a vault's own. */
  decision: string;
  version: string;
  primitive: Primitive;
  /** The question, with `<agent>`-style placeholders filled from the state by the caller. */
  question: string;
  /** Choice primitive: the options; the first is the "do the old thing" answer. */
  options?: string[];
  /**
   * What each answer means, in the classifier's own format: choice `{ option: description }`, bool
   * `{ true: ..., false: ... }`, score a list of rubric levels (the score is the index). Options without a
   * criterion get their name as the description.
   */
  criteria?: Record<string, string> | string[];
  /** Choice primitive: options that mean "nothing to do". Their summed probability at or above `act` is a `skip`. */
  skipOptions?: string[];
  /** Score primitive: inclusive bounds. */
  min?: number;
  max?: number;
  /** Probability (bool), confidence (choice) or score above which the caller acts on the answer. */
  act: number;
  /** Below this the decision is queued for a person; between escalate and act the old path runs. */
  escalate: number;
  /** Highest classification level the input may carry: `public` or `shared`. Anything else is refused. */
  privacy: 'public' | 'shared';
  /** `provider/model` pin; the settings' default when absent. */
  model?: string;
  /** USD per million input tokens, for cost_usd; the classifier's output is free. */
  priceUsdPerMInput?: number;
}

export type Action = 'act' | 'skip' | 'escalate' | 'fallthrough';

export interface ClassifyInput {
  decision: string;
  /** The facts the question is about, as JSON. Hashed for the cache; sent to the classifier verbatim. */
  state: Record<string, unknown>;
  /** The channel slug or vault folder the state came from, for the privacy allow list. Unset: refused. */
  source?: string | null;
  runId?: string | null;
  agentName?: string | null;
  ref?: string | null;
}

export interface ClassifyResult {
  decision: string;
  schemaVersion: string;
  action: Action;
  /** The chosen option, `yes`/`no` for a bool, or the score as text; null on fallthrough. */
  answer: string | null;
  probabilities: Record<string, number> | null;
  confidence: number | null;
  model: string | null;
  latencyMs: number | null;
  inputTokens: number | null;
  costUsd: number | null;
  error: string | null;
  cached: boolean;
  /** The classify_decisions row, when one was written. */
  id: number | null;
  /** True when the confidence fell under the schema's `escalate` line: a person should look before anyone acts. */
  review?: boolean;
}
