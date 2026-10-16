import type { PlanSnapshot, UsageCall } from './types.js';

/** One JSON object per line, Mac -> droplet. Dates travel as ISO strings. */
export type WireLine =
  | { t: 'transcript'; path: string; startLine: number; text: string }
  | { t: 'plan'; snap: Omit<PlanSnapshot, 'resetsAt' | 'observedAt'> & { resetsAt: string | null; observedAt: string } }
  | { t: 'calls'; calls: Array<Omit<UsageCall, 'ts'> & { ts: string }> };
