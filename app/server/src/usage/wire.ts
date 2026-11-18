import type { CollectionHealth } from './health-wire.js';
import type { PlanSnapshot, UsageCall } from './types.js';

/** One JSON object per line, local -> server. Dates travel as ISO strings. */
export type WireLine =
  | { t: 'health'; health: CollectionHealth }
  | { t: 'codex'; text: string }
  /** One whole zen-agent trace (its complete lines), re-sent when it changes; `mtimeMs` stands in for a missing end time. */
  | { t: 'zen'; path: string; mtimeMs: number; text: string }
  | { t: 'transcript'; path: string; startLine: number; text: string }
  | { t: 'plan'; snap: Omit<PlanSnapshot, 'resetsAt' | 'observedAt'> & { resetsAt: string | null; observedAt: string } }
  | { t: 'calls'; calls: Array<Omit<UsageCall, 'ts'> & { ts: string }> };
