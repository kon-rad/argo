import type { Host } from '../archive/types.js';

export interface UsageCall {
  /** 'claude-code', or a Hermes home's archive source ('hermes', 'hermes:builder') for the usage-ledger plugin's calls. */
  source: string;
  host: Host;
  callId: string;
  requestId: string | null;
  sessionExternalId: string;
  messageExternalId: string | null;
  ts: Date;
  model: string;
  entrypoint: string | null;
  cwd: string | null;
  isSidechain: boolean;
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  webSearchRequests: number;
  /** The first tool the response invoked (Bash, Write, ...), and its class; null for the final text. */
  tool: string | null;
  action: Action | null;
  /** Who served the call ('anthropic', 'bedrock', ...); null when the collector doesn't know. */
  provider?: string | null;
  /** Hermes only: the plugin's key (tool-call ids or a text hash) that ties the call to its stored response. */
  matchKey?: string | null;
}

export type Action = 'dm' | 'post' | 'ticket' | 'card' | 'tracker' | 'write' | 'read' | 'shell' | 'reply';

export interface VerifyRecord {
  name: string;
  passed: boolean;
  exitCode: number | null;
  metric: number | null;
  output: string;
  at: Date | null;
}

export interface WakeReason { reason: string | null; ref: string | null }

export interface RunRecord {
  host: Host;
  /** One per `claude -p` process: ORG_RUN for a bot, `<card>-<stamp>` for a lane, the log's file name for older logs. */
  runId: string;
  sessionId: string;
  agentName: string | null;
  teamSlug: string | null;
  workType: string | null;
  reasons: WakeReason[];
  wakeupIds: number[];
  resumed: boolean | null;
  taskId: string | null;
  board: string | null;
  lane: string | null;
  model: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  durationMs: number | null;
  durationApiMs: number | null;
  numTurns: number | null;
  subtype: string | null;
  isError: boolean | null;
  totalCostUsd: number | null;
  usage: unknown;
  modelUsage: unknown;
  verify: VerifyRecord | null;
  logPath: string;
}

export type PlanWindow = 'five_hour' | 'seven_day';

export interface PlanSnapshot {
  host: Host;
  origin: 'statusline' | 'stream-json';
  window: PlanWindow;
  usedPct: number;
  resetsAt: Date | null;
  observedAt: Date;
}

export interface HermesCounters {
  host: Host;
  profile: string;
  sessionId: string;
  model: string | null;
  billingProvider: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  apiCalls: number;
  costUsd: number | null;
}
