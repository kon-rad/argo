/** Derived only from recorded envelopes. Never search stdout for failure words. */
export const RESULT_PARSER_VERSION = 1;
export interface ToolResult { text: string; isError: boolean | null }
type Obj = Record<string, unknown>;
const obj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const LIMIT = 65536;
const bounded = (s: string) => s.length > LIMIT ? s.slice(0, LIMIT - 14) + '\n[truncated]' : s;
const json = (v: unknown) => bounded(JSON.stringify(v, null, 2) ?? '');
const combine = (values: Array<boolean | null>): boolean | null => values.includes(true) ? true
  : values.includes(false) ? false : null;

function outcome(v: Obj): boolean | null {
  const codes = [v.exit_code, v.exitCode, v.returncode, v.return_code].filter(x => typeof x === 'number' && Number.isInteger(x)) as number[];
  if (codes.some(x => x !== 0)) return true;
  if (v.is_error === true || v.isError === true || v.success === false || v.cancelled === true || v.canceled === true || v.timed_out === true) return true;
  const status = typeof (v.status ?? v.outcome) === 'string' ? v.status ?? v.outcome : null;
  if (['failed', 'error', 'cancelled', 'canceled', 'timeout', 'timed_out'].includes(status as string)) return true;
  if (codes.length || v.is_error === false || v.isError === false || v.success === true || ['success', 'succeeded'].includes(status as string)) return false;
  return null;
}
const envelope = (v: Obj) => ['output', 'stdout', 'stderr', 'content', 'result', 'structuredContent', 'exit_code', 'exitCode', 'returncode', 'return_code', 'is_error', 'isError', 'success', 'status', 'outcome', 'cancelled', 'canceled', 'timed_out'].some(k => k in v);

export function normalizeResult(input: unknown, depth = 0): ToolResult {
  if (depth > 12) return { text: json(input), isError: null };
  if (typeof input === 'string') {
    // Only recognised result envelopes are decoded, at result/block boundaries.
    try {
      const decoded: unknown = JSON.parse(input);
      if ((obj(decoded) && envelope(decoded)) || Array.isArray(decoded)) return normalizeResult(decoded, depth + 1);
    } catch { /* Partial records remain readable. */ }
    return { text: bounded(input), isError: null };
  }
  if (Array.isArray(input)) {
    const parts = input.map(v => normalizeResult(v, depth + 1));
    return { text: bounded(parts.map(p => p.text).filter(Boolean).join('\n')), isError: combine(parts.map(p => p.isError)) };
  }
  if (!obj(input)) return { text: input == null ? '' : json(input), isError: null };
  const own = outcome(input);
  const metadata = obj(input.metadata) ? outcome(input.metadata) : null;
  const structured = input.structuredContent === undefined ? null : normalizeResult(input.structuredContent, depth + 1);
  const parts: ToolResult[] = [];
  for (const key of ['stdout', 'stderr', 'output', 'content', 'result', 'text']) {
    if (!(key in input)) continue;
    const v = input[key];
    // stdout/stderr and a text block's ordinary text are terminal payloads. Decode
    // text only when it is a recognised encoded envelope (legacy MCP transport).
    parts.push((key === 'stdout' || key === 'stderr')
      ? { text: typeof v === 'string' ? bounded(v) : json(v), isError: null }
      : normalizeResult(v, depth + 1));
  }
  const explicit = combine([own, metadata, structured?.isError ?? null].filter((v): v is boolean => v !== null));
  return {
    text: bounded(parts.length ? parts.map(p => p.text).filter(Boolean).join('\n') : structured?.text ?? json(input)),
    isError: explicit ?? combine(parts.map(p => p.isError)),
  };
}

/** Runtime adapters keep prose and argument objects out of outcome classification. */
export function toolResult(raw: unknown): ToolResult | null {
  if (!obj(raw)) return null;
  if (raw.harness === 'codex' && obj(raw.payload) && ['function_call_output', 'custom_tool_call_output'].includes(String(raw.payload.type))) {
    return normalizeResult(raw.payload);
  }
  if (typeof raw.session_id === 'string' && raw.role === 'tool') return normalizeResult(raw);
  return null;
}
