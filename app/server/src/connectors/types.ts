import type { z } from 'zod';

export interface RunContext {
  sourceId: number;
  runId: number;
  config: Record<string, unknown>;
  /** Throttled by the caller; safe to call per item. */
  onProgress(progress: Record<string, unknown>): void;
  signal: AbortSignal;
}

export interface Connector<TStats = Record<string, unknown>> {
  id: string;
  configSchema: z.ZodType<Record<string, unknown>>;
  run(ctx: RunContext): Promise<TStats>;
}
