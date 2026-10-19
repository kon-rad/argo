// Imports nothing at runtime: the ledger is bundled into one file per machine (bin/build-ledger.sh),
// and everything under ledger/ uses node builtins and pure parsers only, never pg or express.

/** A machine's agent ledger settings, ledger.json next to ledger.db. */
export interface LedgerConfig {
  /** Base URL of the Second Brain server, e.g. https://brain.example.com. Unset: collect only. */
  server: string | null;
  /** This device's ingest token (`secondbrain ingest-device add <host>` prints it). SB_LEDGER_TOKEN overrides. */
  token: string | null;
  /** The usage_hosts slug the token belongs to. Informational: the server decides the host from the token. */
  host: string | null;
  claudeProjectsDir: string | null;
  /** Recorded on every Claude Code call: 'anthropic', or 'bedrock' / 'vertex' when Claude Code is set up that way. */
  claudeProvider: string;
  /** Every Hermes home on this machine. `label` 'main' keeps the archive's plain 'hermes' source name. */
  hermesHomes: Array<{ dir: string; label: string }>;
  /** Seconds between scheduled runs. */
  intervalSec: number;
  /** Uncompressed bytes per sync batch; a single larger row still goes alone. */
  batchBytes: number;
  /** Delete synced messages and calls older than this many days (the server keeps them). Null: keep everything. */
  retainDays: number | null;
  /** The capture proxy: Claude Code's ANTHROPIC_BASE_URL points here, it forwards to `upstream` and records each exchange. */
  proxy: { enabled: boolean; port: number; upstream: string };
}

/** `exchange` and `blob` come from the capture proxy: one exact API request/response, and the
 * content-addressed system prompts, tool lists and messages it points at. */
export type RecordKind = 'session' | 'message' | 'call' | 'counter' | 'exchange' | 'blob';

/** One ledger row as it travels to the server. `data` never carries a host: the token decides it. */
export interface WireRow { seq: number; kind: RecordKind; key: string; data: Record<string, unknown> }

export interface WireBatch {
  v: 1;
  ledgerId: string;
  bundle: string;
  fromSeq: number;
  toSeq: number;
  rows: WireRow[];
}

export interface IngestResponse {
  ok: true;
  host: string;
  rows: number;
  counts: { sessions: number; messages: number; calls: number; counters: number; exchanges: number; blobs: number };
}
