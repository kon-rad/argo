import { query } from '../db.js';
import type { StepPart } from '../archive/steps.js';
import type { SessionRow } from './input.js';

/**
 * The fields of a summary the model does not write. Counted from the parts and the usage ledger,
 * so a figure on the page is never a model's guess.
 */
export interface Touched {
  files_edited: string[];
  files_read: number;
  cards: string[];
  tools: Record<string, number>;
  skills: string[];
}

export interface Metrics {
  steps: number;
  prompts: number;
  tool_calls: number;
  error_steps: number;
  duration_s: number | null;
  calls: number;
  input_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  models: string[];
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'write_file', 'patch', 'edit_file', 'write']);
const READ_TOOLS = new Set(['Read', 'read_file', 'read', 'Grep', 'Glob']);
const CARD_RE = /\bt_[0-9a-f]{8}\b/g;
const MAX_FILES = 40;

function inputObject(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function deriveTouched(parts: StepPart[]): Touched {
  const files = new Set<string>();
  const cards = new Set<string>();
  const skills = new Set<string>();
  const tools: Record<string, number> = {};
  let filesRead = 0;
  for (const p of parts) {
    if (p.step === 'prompt') for (const c of p.text.match(CARD_RE) ?? []) cards.add(c);
    if (p.step !== 'tool_call') continue;
    const name = p.toolName ?? 'tool';
    tools[name] = (tools[name] ?? 0) + 1;
    const input = inputObject(p.text);
    for (const c of p.text.match(CARD_RE) ?? []) cards.add(c);
    const path = (input.file_path ?? input.path ?? input.notebook_path) as unknown;
    if (EDIT_TOOLS.has(name) && typeof path === 'string' && path) files.add(path);
    else if (READ_TOOLS.has(name)) filesRead++;
    if (name === 'Skill' && typeof input.skill === 'string') skills.add(input.skill);
  }
  return {
    files_edited: [...files].slice(0, MAX_FILES),
    files_read: filesRead,
    cards: [...cards].slice(0, 20),
    tools,
    skills: [...skills].slice(0, 20),
  };
}

export async function loadMetrics(session: SessionRow, parts: StepPart[]): Promise<Metrics> {
  const { rows } = await query<{
    calls: string; input: string | null; cache_write: string | null; cache_read: string | null; output: string | null; models: string[] | null;
  }>(
    `SELECT count(*) AS calls, sum(input_tokens) AS input, sum(cache_write_tokens) AS cache_write,
            sum(cache_read_tokens) AS cache_read, sum(output_tokens) AS output, array_agg(DISTINCT model) AS models
       FROM usage_calls WHERE host = $1 AND session_external_id = $2 AND source = $3`,
    [session.host, session.external_id, session.harness ?? 'claude-code'],
  );
  const u = rows[0];
  const toolCalls = parts.filter((p) => p.step === 'tool_call').length;
  return {
    steps: parts.length,
    prompts: parts.filter((p) => p.step === 'prompt').length,
    tool_calls: toolCalls,
    error_steps: parts.filter((p) => p.step === 'tool_result' && p.isError).length,
    duration_s: session.started_at && session.ended_at ? Math.max(0, Math.round((session.ended_at.getTime() - session.started_at.getTime()) / 1000)) : null,
    calls: Number(u?.calls ?? 0),
    input_tokens: Number(u?.input ?? 0),
    cache_write_tokens: Number(u?.cache_write ?? 0),
    cache_read_tokens: Number(u?.cache_read ?? 0),
    output_tokens: Number(u?.output ?? 0),
    models: u?.models?.filter(Boolean) ?? [],
  };
}
