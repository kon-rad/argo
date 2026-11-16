import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Runner, RunnerResult } from './index.js';

/** Codex CLI JSONL is the only source of run identity, usage and completion. */
export interface CodexResult {
  code: number;
  state: 'done' | 'error' | 'cancelled' | 'timeout';
  text: string;
  fullText: string;
  sessionId: string | null;
  inputTokens: number;
  outputTokens: number;
}

const CREDENTIAL_OVERRIDES = new Set([
  'OPENAI_API_KEY', 'CODEX_API_KEY', 'AZURE_OPENAI_API_KEY', 'OPENAI_BASE_URL',
  'OPENAI_API_BASE', 'OPENAI_ORGANIZATION', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID',
]);

/** Keep the CLI's ChatGPT login path, but never let API credentials override it. */
export function subscriptionEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of CREDENTIAL_OVERRIDES) delete env[key];
  return env;
}

/** The compiled persona for a roster agent (`.claude/agents/<name>.md`, written by the org compiler), without its
 *  Claude Code frontmatter. Null when the vault has no such file, so a vault without a roster still runs. */
export function codexPersona(vaultRoot: string, name: string): string | null {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return null;
  let raw: string;
  try { raw = readFileSync(join(vaultRoot, '.claude', 'agents', `${name}.md`), 'utf8'); } catch { return null; }
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
  return body || null;
}

/** What a fresh Codex session is told before its task: who it is, where the board checklist is, and whether this
 *  run can write. Codex has no `--persona` flag and does not read `.claude/agents/`, so without this the bot only
 *  learns its name. A resumed session already holds it. */
export function codexPreamble(persona: string | null, writable: boolean): string {
  const lines: string[] = [];
  if (persona) lines.push(persona, '');
  lines.push('Your checklist for the message board is the `org-member` skill: read `.agents/skills/org-member/SKILL.md` before you post, DM or hand off.');
  lines.push(writable
    ? 'This run can write inside your worktree.'
    : 'This run is read-only: a message woke you, not a card. You cannot create, edit or sync files. If the work needs writes, say so once on the card and stop; do not report the same blocker again in a DM and a channel.');
  return lines.join('\n') + '\n\n---\n\n';
}

export function codexCommand(model: string, cwd: string, prompt: string, sessionId?: string | null, writable = false): string[] {
  const base = ['exec', ...(sessionId ? ['resume', sessionId] : []), '--ignore-user-config', '--json', '--model', model];
  if (!sessionId) base.push('--sandbox', writable ? 'workspace-write' : 'read-only', '--cd', cwd);
  // Resume has no --cd/--sandbox flag. The caller supplies cwd and the original session's sandbox policy.
  base.push(prompt);
  return base;
}

export function parseCodexResult(raw: RunnerResult): CodexResult {
  let sessionId: string | null = null;
  let text = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let completed = false;
  let failed = false;
  for (const line of raw.stdout.split('\n')) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') sessionId = event.thread_id;
    if (event.type === 'item.completed' && event.item && typeof event.item === 'object') {
      const item = event.item as Record<string, unknown>;
      if (item.type === 'agent_message' && typeof item.text === 'string') text = item.text;
    }
    if (event.type === 'turn.completed') {
      completed = true;
      const usage = event.usage && typeof event.usage === 'object' ? event.usage as Record<string, unknown> : {};
      inputTokens = Number(usage.input_tokens ?? 0) || 0;
      outputTokens = Number(usage.output_tokens ?? 0) || 0;
    }
    if (event.type === 'turn.failed' || event.type === 'error') failed = true;
  }
  const state = raw.timedOut ? 'timeout' : raw.cancelled ? 'cancelled' : raw.code === 0 && completed && !failed ? 'done' : 'error';
  return { code: raw.code, state, text: text.slice(0, 600), fullText: text, sessionId, inputTokens, outputTokens };
}

/** A cheap, explicit subscription check followed by an exact-model CLI request. No model fallback. */
export async function codexPreflight(runner: Runner, command: string, model: string, cwd: string, sourceEnv: NodeJS.ProcessEnv): Promise<string | null> {
  const env = subscriptionEnv(sourceEnv);
  const auth = await runner(command, ['login', 'status'], env, cwd, 15_000);
  if (auth.code !== 0 || !/Logged in using ChatGPT/i.test(auth.stdout + auth.stderr)) return 'Codex ChatGPT subscription login unavailable';
  const probe = await runner(command, ['exec', '--ignore-user-config', '--json', '--ephemeral', '--model', model, '--sandbox', 'read-only', '--cd', cwd,
    'Reply with exactly READY. Do not use tools.'], env, cwd, 120_000);
  const parsed = parseCodexResult(probe);
  if (parsed.state !== 'done' || parsed.text.trim() !== 'READY') return `Codex model ${model} unavailable on the ChatGPT subscription`;
  return null;
}
