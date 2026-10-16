import { DatabaseSync } from 'node:sqlite';
import type { Host } from '../archive/types.js';
import type { HermesCounters } from './types.js';

type Row = Record<string, unknown>;
const n = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : 0);
const opt = (v: unknown): number | null => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : null);
const s = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const epoch = (v: unknown): Date | null => { const x = opt(v); return x === null ? null : new Date(x * 1000); };

/** Hermes keeps running token totals on each session row. SELECT * because the Mac and droplet versions differ. */
export function readHermesCounters(dbPath: string, host: Host, profile: string): HermesCounters[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare('SELECT * FROM sessions').all() as Row[]).map((r) => ({
      host, profile, sessionId: String(r.id), model: s(r.model), billingProvider: s(r.billing_provider),
      startedAt: epoch(r.started_at), endedAt: epoch(r.ended_at),
      inputTokens: n(r.input_tokens), outputTokens: n(r.output_tokens), cacheReadTokens: n(r.cache_read_tokens),
      cacheWriteTokens: n(r.cache_write_tokens), reasoningTokens: n(r.reasoning_tokens), apiCalls: n(r.api_call_count),
      costUsd: opt(r.actual_cost_usd) ?? opt(r.estimated_cost_usd),
    }));
  } finally {
    db.close();
  }
}
