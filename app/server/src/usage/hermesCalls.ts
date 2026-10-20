import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Host } from '../archive/types.js';
import type { UsageCall } from './types.js';

/**
 * Per-request token lines from the engine's Hermes plugin (harness/hermes/usage-ledger), one file per UTC
 * day in `<hermes home>/usage/calls-YYYY-MM-DD.jsonl`. Pure: the droplet's agents-sync, the Mac archive run
 * and the agent ledger all read them through here. Every row is keyed by its request id, so reading a file
 * again changes nothing.
 */

const FILE = /^calls-\d{4}-\d{2}-\d{2}\.jsonl$/;

/** The day files in one Hermes home (or profile) directory, oldest first; `sinceMs` skips files not written since. */
export function hermesCallFiles(dir: string, sinceMs = 0): string[] {
  const folder = join(dir, 'usage');
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter((f) => FILE.test(f)).sort()
    .map((f) => join(folder, f))
    .filter((p) => statSync(p).mtimeMs >= sinceMs);
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** One plugin line → a usage_calls row. Lines that aren't the plugin's (or are cut off) are skipped. */
export function hermesCallFromLine(line: string, source: string, host: Host): UsageCall | null {
  let r: Record<string, unknown>;
  try { r = JSON.parse(line) as Record<string, unknown>; } catch { return null; }
  if (!r || typeof r !== 'object' || r.v !== 1) return null;
  const sid = text(r.session_id);
  const ts = text(r.ts) ? new Date(r.ts as string) : null;
  if (!sid || !ts || Number.isNaN(ts.getTime())) return null;
  const aux = r.kind === 'aux';
  // A request without Hermes's own id still gets a stable one: the same line always maps to the same row.
  const callId = text(r.api_request_id)
    ?? `h:${createHash('sha256').update(`${sid}|${r.ts}|${r.api_call_count ?? ''}|${r.kind}|${r.aux_task ?? ''}`).digest('hex').slice(0, 32)}`;
  const tools = Array.isArray(r.tools) ? r.tools.filter((t): t is string => typeof t === 'string') : [];
  return {
    source, host, callId, requestId: text(r.api_request_id),
    sessionExternalId: sid, messageExternalId: null, ts,
    model: text(r.response_model) ?? text(r.model) ?? 'unknown',
    // Where the turn came from (cli, telegram, cron); an auxiliary call says which side task it served.
    entrypoint: aux ? `aux:${text(r.aux_task) ?? 'other'}` : text(r.platform),
    cwd: null, isSidechain: false,
    inputTokens: num(r.input), cacheWriteTokens: num(r.cache_write), cacheReadTokens: num(r.cache_read),
    outputTokens: num(r.output), thinkingTokens: num(r.reasoning), webSearchRequests: 0,
    tool: tools[0] ?? null, action: null,
    provider: text(r.provider),
    matchKey: aux ? null : text(r.match),
  };
}

export function parseHermesCalls(content: string, source: string, host: Host): UsageCall[] {
  const out: UsageCall[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    const c = hermesCallFromLine(line, source, host);
    if (c) out.push(c);
  }
  return out;
}

/** Every call in a home's day files written since `sinceMs`. */
export function readHermesCalls(dir: string, source: string, host: Host, sinceMs = 0): UsageCall[] {
  return hermesCallFiles(dir, sinceMs).flatMap((p) => parseHermesCalls(readFileSync(p, 'utf8'), source, host));
}

/**
 * The plugin's match key computed from a stored Hermes assistant message: its tool-call ids, else a hash of
 * its trimmed text. The usage page uses it to put a call's tokens on the response that call produced.
 */
export function hermesMatchKey(toolCallIds: string[], content: string | null): string | null {
  if (toolCallIds.length) return `t:${toolCallIds.join(',')}`;
  const t = content?.trim();
  return t ? `c:${createHash('sha256').update(t).digest('hex').slice(0, 32)}` : null;
}
