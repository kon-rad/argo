/**
 * One vocabulary for every agent harness. A stored archive row is one source record:
 * a Claude Code transcript line or a Hermes `messages` row. `stepFields` classifies it
 * for the columns the page filters on; `expandSteps` splits it into the parts the page
 * shows (a Hermes assistant row = thinking + response + one part per tool call).
 * Pure: no database, no IO.
 */
export type Step = 'prompt' | 'response' | 'thinking' | 'tool_call' | 'tool_result' | 'system' | 'meta';

export interface StepFields { step: Step; toolNames: string[]; toolCallId: string | null; isError: boolean | null }

export interface StepPart {
  key: string;
  step: Step;
  text: string;
  toolName: string | null;
  toolCallId: string | null;
  isError: boolean | null;
}

export interface StepRow { id: number; role: string; kind: string; ts: string | Date | null; raw: unknown; text: string }

type Obj = Record<string, any>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** A zen-agent trace line, stored with a `harness` marker by usage/zenTrace.ts. */
const isZen = (raw: Obj): boolean => raw.harness === 'zen-agent';

function zenBlocks(raw: Obj): Obj[] {
  const c = raw.message?.content;
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return Array.isArray(c) ? c.filter(isObj) : [];
}

function zenFields(raw: Obj): StepFields {
  const none: StepFields = { step: 'meta', toolNames: [], toolCallId: null, isError: null };
  if (raw.type === 'blocked' || raw.type === 'compaction') return { ...none, step: 'system' };
  if (raw.type !== 'message' || !isObj(raw.message)) return none;
  const m = raw.message;
  if (m.role === 'user') return { ...none, step: 'prompt' };
  if (m.role === 'toolResult') {
    const name = str(m.toolName);
    return { step: 'tool_result', toolNames: name ? [name] : [], toolCallId: str(m.toolCallId), isError: m.isError === true ? true : null };
  }
  if (m.role !== 'assistant') return { ...none, step: 'system' };
  const calls = zenBlocks(raw).filter((b) => b.type === 'toolCall');
  if (calls.length) return { step: 'tool_call', toolNames: calls.map((b) => String(b.name ?? 'tool')), toolCallId: str(calls[0]!.id), isError: null };
  const blocks = zenBlocks(raw);
  return { ...none, step: blocks.length && blocks.every((b) => b.type === 'thinking') ? 'thinking' : 'response' };
}

/** Hermes rows carry `role` and `session_id`; Claude Code records carry `type`. */
function isHermes(raw: Obj): boolean {
  return typeof raw.role === 'string' && 'session_id' in raw && typeof raw.type !== 'string';
}

interface HermesCall { id: string | null; name: string; args: string }

/** Hermes stores tool calls as a JSON string: OpenAI-style `{id, function: {name, arguments}}`, older rows `{name}`. */
function hermesCalls(v: unknown): HermesCall[] {
  let list: unknown = v;
  if (typeof v === 'string') {
    if (!v.trim()) return [];
    try { list = JSON.parse(v); } catch { return []; }
  }
  if (!Array.isArray(list)) return [];
  return list.filter(isObj).map((c) => {
    const fn = isObj(c.function) ? c.function : c;
    const args = fn.arguments ?? fn.args ?? fn.input ?? '';
    return { id: str(c.id) ?? str(c.call_id), name: str(fn.name) ?? 'tool', args: typeof args === 'string' ? args : JSON.stringify(args) };
  });
}

/** A stored Hermes assistant row's tool-call ids and text, for matching it to the call that produced it; null otherwise. */
export function hermesResponse(raw: unknown): { toolCallIds: string[]; content: string | null } | null {
  if (!isObj(raw) || !isHermes(raw) || raw.role !== 'assistant') return null;
  return { toolCallIds: hermesCalls(raw.tool_calls).map((c) => c.id).filter((id): id is string => !!id), content: str(raw.content) };
}

function claudeBlocks(raw: Obj): Obj[] {
  const c = raw.message?.content;
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return Array.isArray(c) ? c.filter(isObj) : [];
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (isObj(b) && typeof b.text === 'string' ? b.text : '')).filter(Boolean).join('\n');
  return '';
}

export function stepFields(raw: unknown): StepFields {
  const none: StepFields = { step: 'meta', toolNames: [], toolCallId: null, isError: null };
  if (!isObj(raw)) return none;
  if (isZen(raw)) return zenFields(raw);
  if (isHermes(raw)) {
    const role = raw.role as string;
    if (role === 'user') return { ...none, step: 'prompt' };
    if (role === 'tool') {
      const name = str(raw.tool_name);
      return { step: 'tool_result', toolNames: name ? [name] : [], toolCallId: str(raw.tool_call_id), isError: null };
    }
    if (role === 'assistant') {
      const calls = hermesCalls(raw.tool_calls);
      if (calls.length) return { step: 'tool_call', toolNames: calls.map((c) => c.name), toolCallId: null, isError: null };
      if (!str(raw.content) && (str(raw.reasoning) || str(raw.reasoning_content))) return { ...none, step: 'thinking' };
      return { ...none, step: 'response' };
    }
    return { ...none, step: 'system' };
  }
  const type = raw.type;
  if (type === 'system') return { ...none, step: 'system' };
  if (type !== 'user' && type !== 'assistant') return none;
  const blocks = claudeBlocks(raw);
  const uses = blocks.filter((b) => b.type === 'tool_use');
  if (uses.length) return { step: 'tool_call', toolNames: uses.map((b) => String(b.name ?? 'tool')), toolCallId: str(uses[0]!.id), isError: null };
  const result = blocks.find((b) => b.type === 'tool_result');
  if (result) return { step: 'tool_result', toolNames: [], toolCallId: str(result.tool_use_id), isError: result.is_error === true ? true : null };
  if (type === 'user') return { ...none, step: 'prompt' };
  const main = blocks.find((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking');
  return { ...none, step: main ? 'response' : blocks.length ? 'thinking' : 'response' };
}

export function expandSteps(row: StepRow): StepPart[] {
  const raw = row.raw;
  const base = { toolName: null, toolCallId: null, isError: null };
  const k = String(row.id);
  if (isObj(raw) && isZen(raw)) {
    if (raw.type !== 'message' || !isObj(raw.message)) return [{ key: k, step: zenFields(raw).step, text: row.text, ...base }];
    const m = raw.message;
    if (m.role === 'toolResult') {
      return [{ key: k, step: 'tool_result', text: resultText(m.content), toolName: str(m.toolName), toolCallId: str(m.toolCallId), isError: m.isError === true ? true : null }];
    }
    const blocks = zenBlocks(raw);
    const parts: StepPart[] = [];
    blocks.forEach((b, i) => {
      const key = blocks.length > 1 ? `${k}:${i}` : k;
      if (b.type === 'thinking') parts.push({ key, step: 'thinking', text: b.redacted ? '(redacted thinking)' : String(b.thinking ?? ''), ...base });
      else if (b.type === 'toolCall') parts.push({ key, step: 'tool_call', text: JSON.stringify(b.arguments ?? {}), toolName: String(b.name ?? 'tool'), toolCallId: str(b.id), isError: null });
      else if (b.type === 'text') parts.push({ key, step: m.role === 'user' ? 'prompt' : 'response', text: String(b.text ?? ''), ...base });
      else if (b.type === 'image') parts.push({ key, step: m.role === 'user' ? 'prompt' : 'response', text: '(image)', ...base });
    });
    return parts.length ? parts : [{ key: k, step: zenFields(raw).step, text: row.text, ...base }];
  }
  if (isObj(raw) && isHermes(raw)) {
    const f = stepFields(raw);
    if (raw.role !== 'assistant') {
      return [{ key: k, step: f.step, text: str(raw.content) ?? row.text, toolName: f.toolNames[0] ?? null, toolCallId: f.toolCallId, isError: null }];
    }
    const parts: StepPart[] = [];
    const thinking = str(raw.reasoning) ?? str(raw.reasoning_content);
    if (thinking) parts.push({ key: `${k}:r`, step: 'thinking', text: thinking, ...base });
    const content = str(raw.content);
    if (content) parts.push({ key: k, step: 'response', text: content, ...base });
    hermesCalls(raw.tool_calls).forEach((c, i) =>
      parts.push({ key: `${k}:tc:${i}`, step: 'tool_call', text: c.args, toolName: c.name, toolCallId: c.id, isError: null }));
    return parts.length ? parts : [{ key: k, step: 'response', text: row.text, ...base }];
  }
  if (isObj(raw) && (raw.type === 'user' || raw.type === 'assistant')) {
    const blocks = claudeBlocks(raw);
    const parts: StepPart[] = [];
    blocks.forEach((b, i) => {
      const key = blocks.length > 1 ? `${k}:${i}` : k;
      if (b.type === 'thinking') parts.push({ key, step: 'thinking', text: String(b.thinking ?? ''), ...base });
      else if (b.type === 'redacted_thinking') parts.push({ key, step: 'thinking', text: '(redacted thinking)', ...base });
      else if (b.type === 'tool_use') parts.push({ key, step: 'tool_call', text: JSON.stringify(b.input ?? {}), toolName: String(b.name ?? 'tool'), toolCallId: str(b.id), isError: null });
      else if (b.type === 'tool_result') parts.push({ key, step: 'tool_result', text: resultText(b.content), toolName: null, toolCallId: str(b.tool_use_id), isError: b.is_error === true ? true : null });
      else if (b.type === 'text') parts.push({ key, step: raw.type === 'user' ? 'prompt' : 'response', text: String(b.text ?? ''), ...base });
      else if (b.type === 'image') parts.push({ key, step: raw.type === 'user' ? 'prompt' : 'response', text: '(image)', ...base });
    });
    if (parts.length) return parts;
  }
  return [{ key: k, step: stepFields(raw).step, text: row.text, ...base }];
}

const SUMMARY_FIELDS = ['command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'url', 'description', 'prompt', 'skill', 'name'];

/** One line saying what a tool call did: the command, the file, the query. */
export function toolSummary(_name: string, inputJson: string): string {
  let v: unknown;
  try { v = JSON.parse(inputJson); } catch { return inputJson.slice(0, 120); }
  if (isObj(v)) {
    for (const f of SUMMARY_FIELDS) if (typeof v[f] === 'string' && v[f]) return (v[f] as string).split('\n')[0]!.slice(0, 120);
  }
  return inputJson.slice(0, 120);
}
