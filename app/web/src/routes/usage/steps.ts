import type { AgentStep } from '../../lib/api.js';

/** A tool call with the result that answered it (matched by tool call id), if any came back. */
export interface ToolPair { call: AgentStep; result: AgentStep | null; durationMs: number | null }

export type TurnItem = { kind: 'step'; step: AgentStep } | { kind: 'tool'; pair: ToolPair };

/** One prompt and everything until the next prompt. A session that starts without a prompt gets a turn with `prompt: null`. */
export interface Turn { prompt: AgentStep | null; items: TurnItem[] }

/** Pairs each tool call with its result; a result whose call is not on the page stays a plain step. */
export function pairTools(steps: AgentStep[]): TurnItem[] {
  const results = new Map<string, AgentStep>();
  for (const s of steps) if (s.step === 'tool_result' && s.toolCallId && !results.has(s.toolCallId)) results.set(s.toolCallId, s);
  const used = new Set<AgentStep>();
  const items: TurnItem[] = [];
  for (const s of steps) {
    if (s.step === 'tool_call') {
      const r = s.toolCallId ? results.get(s.toolCallId) ?? null : null;
      if (r) used.add(r);
      const durationMs = r?.ts && s.ts ? Math.max(0, Date.parse(r.ts) - Date.parse(s.ts)) : null;
      items.push({ kind: 'tool', pair: { call: s, result: r, durationMs } });
    } else if (!(s.step === 'tool_result' && used.has(s))) {
      items.push({ kind: 'step', step: s });
    }
  }
  return items;
}

/** Splits the session into turns at each prompt from the main session (a subagent's prompt stays inside the turn). */
export function groupTurns(steps: AgentStep[]): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  for (const item of pairTools(steps)) {
    if (item.kind === 'step' && item.step.step === 'prompt' && !item.step.subagent) {
      cur = { prompt: item.step, items: [] };
      turns.push(cur);
      continue;
    }
    if (!cur) { cur = { prompt: null, items: [] }; turns.push(cur); }
    cur.items.push(item);
  }
  return turns;
}

const FIELDS = ['command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'url', 'description', 'prompt', 'skill', 'name'];

/** One line saying what a tool call did (the command, the file, the query). */
export function toolSummary(input: string): string {
  try {
    const v = JSON.parse(input) as Record<string, unknown>;
    if (v && typeof v === 'object') {
      for (const f of FIELDS) if (typeof v[f] === 'string' && v[f]) return (v[f] as string).split('\n')[0]!.slice(0, 140);
    }
  } catch { /* not JSON: show it as it is */ }
  return input.slice(0, 140);
}

export function duration(ms: number | null): string {
  if (ms === null) return '';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} m ${Math.round((ms % 60_000) / 1000)} s`;
}
