import { clean, sha256 } from '../archive/clean.js';
import type { Host, ParsedMessage, SessionInput } from '../archive/types.js';
import { classifyZenAction } from './actions.js';
import type { RunRecord, UsageCall, WakeReason } from './types.js';

/**
 * A zen-agent trace (zen-agent/src/session.ts: one JSONL file per run) into ledger rows: one usage_runs
 * row from its `meta` and `end` lines, one usage_calls row per assistant message with usage (priced by
 * the runtime, so cost_usd is real dollars), and an archive session whose messages are the trace's
 * message, blocked and compaction lines. Pure: no database, no IO. The trace is the contract between
 * the two packages; `meta.version` says which one, and a version this parser does not know is refused.
 */
export const KNOWN_TRACE_VERSIONS = new Set([1]);

export interface ZenTraceResult {
  run: RunRecord | null;
  calls: UsageCall[];
  session: { input: SessionInput; messages: ParsedMessage[] } | null;
}

type Obj = Record<string, any>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = (v: unknown): number => Math.max(0, Math.round(num(v) ?? 0));
const valid = (d: Date): Date | null => (Number.isNaN(d.getTime()) ? null : d);
const date = (v: unknown): Date | null => (typeof v === 'string' ? valid(new Date(v)) : typeof v === 'number' ? valid(new Date(v)) : null);

/** The dispatcher's `--meta` pairs: strings, some of them JSON or comma lists. */
function dispatchOf(meta: Obj): Obj {
  return isObj(meta.dispatch) ? meta.dispatch : {};
}

function reasonsOf(v: unknown): WakeReason[] {
  let list: unknown = v;
  if (typeof v === 'string') {
    try { list = JSON.parse(v); } catch { return []; }
  }
  if (!Array.isArray(list)) return [];
  return list.filter(isObj).map((r) => ({ reason: str(r.reason), ref: str(r.ref) ?? (num(r.ref) !== null ? String(r.ref) : null) }));
}

function idsOf(v: unknown): number[] {
  const parts = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  return parts.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0);
}

function blockText(b: unknown): string {
  if (typeof b === 'string') return b;
  if (!isObj(b)) return '';
  switch (b.type) {
    case 'text': return str(b.text) ?? '';
    case 'thinking': return b.redacted ? '[thinking] (redacted)' : `[thinking] ${b.thinking ?? ''}`;
    case 'toolCall': return `[toolCall ${b.name}] ${JSON.stringify(b.arguments ?? {})}`;
    case 'image': return '(image)';
    default: return '';
  }
}

/** Plain text of one pi-ai message, for search. */
export function zenMessageText(m: unknown): string {
  if (!isObj(m)) return '';
  if (typeof m.content === 'string') return m.content;
  return Array.isArray(m.content) ? m.content.map(blockText).filter(Boolean).join('\n') : '';
}

function roleOf(m: Obj): string {
  return m.role === 'user' || m.role === 'assistant' ? m.role : m.role === 'toolResult' ? 'tool' : 'meta';
}

export function parseZenTrace(records: unknown[], host: Host, logPath: string, fileMtime: Date): ZenTraceResult {
  const lines = records.filter(isObj);
  const meta = lines.find((l) => l.type === 'meta');
  if (!meta || !str(meta.id)) return { run: null, calls: [], session: null };
  const version = num(meta.version) ?? 1;
  if (!KNOWN_TRACE_VERSIONS.has(version)) throw new Error(`zen-agent trace version ${version} is newer than this parser knows (${logPath})`);

  const id = meta.id as string;
  const dispatch = dispatchOf(meta);
  const modelSpec = str(meta.model);
  const slash = modelSpec?.indexOf('/') ?? -1;
  const metaProvider = modelSpec && slash > 0 ? modelSpec.slice(0, slash) : null;
  const metaModelId = modelSpec && slash > 0 ? modelSpec.slice(slash + 1) : modelSpec;
  const startedAt = date(meta.at) ?? valid(fileMtime);
  const end = [...lines].reverse().find((l) => l.type === 'end') ?? null;
  const endedAt = end ? (date(end.at) ?? valid(fileMtime)) : null;
  const endUsage = end && isObj(end.usage) ? end.usage : null;
  const stopped = end ? str(end.stopped) : null;

  const calls: UsageCall[] = [];
  const messages: ParsedMessage[] = [];
  let compactions = 0;
  let blocked = 0;
  let title: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;

  lines.forEach((line, i) => {
    const seq = i + 1;
    const at = date(line.at);
    const rawLine = JSON.stringify(line);
    const archive = (role: string, kind: string, ts: Date | null, text: string) =>
      messages.push({ seq, externalId: `${kind}:${seq}`, parentExternalId: null, role, kind, ts, contentText: clean(text),
        raw: clean({ harness: 'zen-agent', ...line }), rawSha: sha256(rawLine), isSidechain: false });

    if (line.type === 'meta' || line.type === 'end') {
      archive('meta', line.type, at, line.type === 'end' ? `run ${str(line.stopped) ?? '?'} after ${int(line.turns)} turns` : `run ${id}`);
    } else if (line.type === 'compaction') {
      compactions++;
      archive('meta', 'compaction', at, `compacted ${int(line.before)} to ${int(line.after)} tokens, ${int(line.dropped)} messages dropped`);
    } else if (line.type === 'blocked') {
      blocked++;
      archive('meta', 'blocked', at, `${str(line.name) ?? 'tool'} blocked: ${str(line.reason) ?? ''}`);
    } else if (line.type === 'message' && isObj(line.message)) {
      const m = line.message;
      const ts = date(m.timestamp) ?? at;
      const text = zenMessageText(m);
      if (m.role === 'user' && title === null && text.trim()) title = text.trim().split('\n')[0]!.slice(0, 120);
      archive(roleOf(m), 'message', ts, text);
      if (m.role !== 'assistant' || !isObj(m.usage)) return;
      const u = m.usage;
      const first = Array.isArray(m.content) ? m.content.find((b: unknown) => isObj(b) && b.type === 'toolCall') : undefined;
      const tool = isObj(first) ? str(first.name) : null;
      inputTokens += int(u.input) + int(u.cacheRead) + int(u.cacheWrite);
      outputTokens += int(u.output);
      calls.push({
        source: 'zen-agent', host, callId: `${id}:${seq}`, requestId: str(m.responseId), sessionExternalId: id,
        messageExternalId: `message:${seq}`, ts: ts ?? startedAt ?? fileMtime, model: str(m.model) ?? metaModelId ?? 'unknown',
        entrypoint: 'zen-agent', cwd: str(meta.workdir), isSidechain: false,
        inputTokens: int(u.input), cacheWriteTokens: int(u.cacheWrite), cacheReadTokens: int(u.cacheRead), outputTokens: int(u.output),
        thinkingTokens: int(u.reasoning), webSearchRequests: 0,
        tool, action: classifyZenAction(tool, isObj(first) ? first.arguments : undefined),
        provider: str(m.provider) ?? metaProvider, costUsd: isObj(u.cost) ? num(u.cost.total) : null,
      });
    }
  });

  const run: RunRecord = {
    host, runId: str(dispatch.run_id) ?? id, sessionId: id, agentName: str(meta.persona),
    teamSlug: str(dispatch.team), workType: str(dispatch.work_type), reasons: reasonsOf(dispatch.reasons),
    wakeupIds: idsOf(dispatch.wakeup_ids), resumed: meta.resumed != null,
    taskId: str(dispatch.task_id), board: str(dispatch.board), lane: null, model: modelSpec,
    startedAt, endedAt, durationMs: startedAt && endedAt ? endedAt.getTime() - startedAt.getTime() : null, durationApiMs: null,
    numTurns: end ? int(end.turns) : null, subtype: stopped, isError: end ? stopped === 'error' : null,
    totalCostUsd: endUsage ? num(endUsage.cost) : null, usage: endUsage, modelUsage: null, verify: null, logPath,
    runtime: 'zen-agent', outcome: null, parts: Array.isArray(meta.parts) ? meta.parts : null, budget: isObj(meta.budget) ? meta.budget : null,
    tier: str(dispatch.tier), compactions, blocked,
  };

  const input: SessionInput = {
    source: 'zen-agent', host, externalId: id, parentExternalId: str(meta.parent), project: null, title, model: modelSpec,
    startedAt, endedAt, messageCount: messages.length, inputTokens, outputTokens, costUsd: run.totalCostUsd,
    meta: { persona: meta.persona ?? null, parts: run.parts, budget: run.budget, tools: meta.tools ?? null, skills: meta.skills ?? null,
      dispatch, stopped, resumed: meta.resumed ?? null, version },
    b2Path: null,
  };
  return { run, calls, session: { input, messages } };
}
