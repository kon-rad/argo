import type { Host } from '../archive/types.js';
import { classifyAction } from './actions.js';
import type { UsageCall } from './types.js';

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const s = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/**
 * Claude Code writes one transcript record per content block of a response, and
 * every one repeats the response's message id and usage. One row per message id:
 * the block with the most output (the last one written), timed at the first block.
 */
export function callsFromRecords(records: unknown[], host: Host, sessionExternalId: string): UsageCall[] {
  const byId = new Map<string, UsageCall>();
  const firstTool = new Map<string, { name: string; input: unknown }>();
  for (const rec of records as any[]) {
    if (rec?.type !== 'assistant') continue;
    const m = rec.message;
    const u = m?.usage;
    if (!m || typeof m.id !== 'string' || !u || typeof u !== 'object' || m.model === '<synthetic>') continue;
    if (!firstTool.has(m.id) && Array.isArray(m.content)) {
      const t = m.content.find((b: any) => b?.type === 'tool_use' && typeof b.name === 'string');
      if (t) firstTool.set(m.id, { name: t.name, input: t.input });
    }
    const ts = typeof rec.timestamp === 'string' ? new Date(rec.timestamp) : null;
    if (!ts || Number.isNaN(ts.getTime())) continue;
    const call: UsageCall = {
      source: 'claude-code', host, callId: m.id, requestId: s(rec.requestId),
      sessionExternalId, messageExternalId: s(rec.uuid), ts,
      model: s(m.model) ?? 'unknown', entrypoint: s(rec.entrypoint), cwd: s(rec.cwd),
      isSidechain: rec.isSidechain === true,
      inputTokens: n(u.input_tokens), cacheWriteTokens: n(u.cache_creation_input_tokens),
      cacheReadTokens: n(u.cache_read_input_tokens), outputTokens: n(u.output_tokens),
      thinkingTokens: n(u.output_tokens_details?.thinking_tokens),
      webSearchRequests: n(u.server_tool_use?.web_search_requests),
      tool: null, action: null,
    };
    const prev = byId.get(m.id);
    if (!prev) {
      byId.set(m.id, call);
    } else if (call.outputTokens >= prev.outputTokens) {
      byId.set(m.id, { ...call, ts: prev.ts < call.ts ? prev.ts : call.ts });
    }
  }
  for (const c of byId.values()) {
    const t = firstTool.get(c.callId) ?? null;
    c.tool = t?.name ?? null;
    c.action = classifyAction(t?.name ?? null, t?.input);
  }
  return [...byId.values()];
}
