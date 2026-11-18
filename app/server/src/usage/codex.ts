import { sha256 } from '../archive/clean.js';
import type { Host, ParsedMessage, SessionInput } from '../archive/types.js';
import type { UsageCall } from './types.js';

type Obj = Record<string, any>;
const obj = (x: unknown): Obj => x && typeof x === 'object' && !Array.isArray(x) ? x as Obj : {};
const str = (x: unknown): string | null => typeof x === 'string' && x.length > 0 ? x : null;
const count = (x: unknown): number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 ? x : 0;
const date = (x: unknown): Date | null => typeof x === 'string' && Number.isFinite(Date.parse(x)) ? new Date(x) : null;
const textOf = (p: Obj): string => {
  if (typeof p.content === 'string') return p.content;
  if (Array.isArray(p.content)) return p.content.map((b: Obj) => b.text ?? '').join('\n');
  if (Array.isArray(p.summary)) return p.summary.map((b: Obj) => b.text ?? '').join('\n');
  return String(p.message ?? p.text ?? p.arguments ?? p.input ?? p.output ?? '');
};

/** Parse a complete prefix, replayed on change. Cumulative high-water marks are authoritative;
 * last_token_usage is only a fallback, never added alongside total_token_usage. */
export function parseCodex(records: unknown[], host: Host): { session: SessionInput | null; messages: ParsedMessage[]; calls: UsageCall[] } {
  const meta = records.map(obj).find(r => r.type === 'session_meta');
  const m = obj(meta?.payload);
  const sid = str(m.id ?? m.session_id);
  if (!sid) return { session: null, messages: [], calls: [] };
  const spawn = obj(obj(obj(m.source).subagent).thread_spawn);
  const parent = str(m.parent_thread_id ?? m.parent_session_id ?? m.forked_from_id ?? spawn.parent_thread_id);
  const source = typeof m.source === 'string' ? m.source : 'subagent';
  let model = str(m.model), cwd = str(m.cwd), title = str(m.title);
  let started = date(m.timestamp ?? meta?.timestamp), ended = started;
  let high = [0, 0, 0, 0];
  let latestMessage: string | null = null;
  const messages = new Map<string, ParsedMessage>();
  const calls = new Map<string, UsageCall>();
  const seenLast = new Set<string>();
  const hasMessages = records.some(x => obj(x).type === 'response_item' && obj(obj(x).payload).type === 'message');
  for (const [seq, v] of records.entries()) {
    const r = obj(v), p = obj(r.payload);
    const ts = date(r.timestamp);
    if (ts) { if (!started || ts < started) started = ts; if (!ended || ts > ended) ended = ts; }
    if (r.type === 'turn_context') { model = str(p.model) ?? model; cwd = str(p.cwd) ?? cwd; }
    const response = r.type === 'response_item';
    // event_msg user/agent text is a second rendering of response_item messages. Use it only in older logs.
    const fallback = r.type === 'event_msg' && ['user_message', 'agent_message'].includes(p.type)
      && !hasMessages;
    if (response || fallback) {
      const type = String(p.type ?? 'message');
      const role = str(p.role) ?? (type === 'user_message' ? 'user' : type.endsWith('_output') ? 'tool' : 'assistant');
      const content = textOf(p);
      const id = str(p.id) ?? sha256(JSON.stringify([r.timestamp, p]));
      const externalId = `${sid}:${id}`;
      const raw = { ...r, harness: 'codex' };
      messages.set(externalId, { seq, externalId, parentExternalId: str(p.call_id), role, kind: type,
        ts, contentText: content, raw, rawSha: sha256(JSON.stringify(raw)), isSidechain: !!parent });
      if (role === 'assistant') latestMessage = externalId;
      if (!title && role === 'user') title = content.slice(0, 160);
    }
    if (r.type !== 'event_msg' || p.type !== 'token_count' || !ts) continue;
    const info = obj(p.info);
    const total = obj(info.total_token_usage);
    const last = obj(info.last_token_usage);
    const cumulative = Object.keys(total).length > 0;
    const u = cumulative ? total : last;
    if (!Object.keys(u).length) continue;
    const current = [count(u.input_tokens), count(u.cached_input_tokens), count(u.output_tokens), count(u.reasoning_output_tokens)];
    let delta: number[];
    if (cumulative) {
      delta = current.map((n, i) => Math.max(0, n - high[i]!));
      high = current.map((n, i) => Math.max(n, high[i]!));
    } else {
      const key = sha256(JSON.stringify([r.timestamp, info]));
      if (seenLast.has(key)) continue;
      seenLast.add(key);
      delta = current;
      high = high.map((n, i) => n + current[i]!);
    }
    if (!delta[0] && !delta[2]) continue;
    const cached = Math.min(delta[0]!, delta[1]!);
    const callId = `${sid}:${sha256(JSON.stringify(cumulative ? high : [r.timestamp, info]))}`;
    calls.set(callId, { source: 'codex', host, callId, requestId: null, sessionExternalId: sid,
      messageExternalId: latestMessage, ts, model: model ?? 'unknown', entrypoint: ['cli', 'vscode', 'desktop'].includes(source) ? 'cli' : source,
      cwd, isSidechain: !!parent, inputTokens: delta[0]! - cached, cacheReadTokens: cached,
      outputTokens: delta[2]!, thinkingTokens: Math.min(delta[2]!, delta[3]!), cacheWriteTokens: 0,
      webSearchRequests: 0, tool: null, action: null, provider: 'openai', costUsd: null });
  }
  return { messages: [...messages.values()], calls: [...calls.values()], session: {
    source: 'codex', host, externalId: sid, parentExternalId: parent, project: cwd, title, model,
    startedAt: started, endedAt: ended, messageCount: messages.size,
    inputTokens: calls.size ? high[0]! - Math.min(high[0]!, high[1]!) : null,
    outputTokens: calls.size ? high[2]! : null, costUsd: null, b2Path: null,
    meta: { billing_provider: 'openai', native_source: m.source ?? null, agent: m.agent_nickname ?? spawn.agent_nickname ?? null,
      api_call_count: calls.size, cache_read_tokens: high[1], reasoning_tokens: high[3], counters: 'available-only' },
  } };
}
