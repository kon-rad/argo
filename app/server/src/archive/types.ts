/** A slug in usage_hosts: 'mac' (the M4 laptop), 'droplet', 'mac-m1', 'exo-pi', ... */
export type Host = string;

export interface ParsedMessage {
  seq: number;
  externalId: string;
  parentExternalId: string | null;
  role: string;
  kind: string;
  ts: Date | null;
  contentText: string;
  raw: unknown;
  rawSha: string;
  isSidechain: boolean;
}

export interface SessionInput {
  source: 'claude-code' | 'hermes' | `hermes:${string}`; // hermes:<profile> comes from agents-sync
  host: Host;
  externalId: string;
  parentExternalId: string | null;
  project: string | null;
  title: string | null;
  model: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  messageCount: number | null; // null = compute from archive_messages
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  meta: Record<string, unknown>;
  b2Path: string | null;
}

export interface LogLine {
  byteOffset: number;
  ts: Date | null;
  level: string | null;
  message: string;
}
