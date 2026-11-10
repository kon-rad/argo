/**
 * The one-line name a session gets on /usage (Sessions list and the session page). Pure, local and
 * deterministic: no transcript leaves the machine to be summarized.
 *
 * Preference, most trusted first:
 *   1. the board card's title when the session was a run for a card (`task`),
 *   2. the skill or slash command the session was started with, e.g. `argo-daily-update` (`skill`),
 *   3. the harness's own title (Claude Code's ai-title, Hermes's title) when it is not boilerplate (`title`),
 *   4. the first substantive line a person wrote (`prompt`).
 * Instruction blocks (AGENTS.md, system reminders, environment context), local commands such as /clear,
 * compaction summaries and transport wrappers (`<channel …>`) are skipped, never shown as the name.
 */
import { stripChannelTag } from './channel.js';

export type TitleSource = 'task' | 'skill' | 'title' | 'prompt';
export interface SessionTitle { text: string; source: TitleSource }

/** Strictly under 100 characters, so a row stays one line. */
export const TITLE_MAX = 99;

/** Claude Code's own commands: run at the keyboard, they say nothing about what the session is for. */
const LOCAL_COMMANDS = new Set(['clear', 'compact', 'model', 'context', 'cost', 'help', 'init', 'login', 'logout', 'memory', 'config',
  'status', 'resume', 'exit', 'quit', 'mcp', 'agents', 'permissions', 'hooks', 'ide', 'doctor', 'usage', 'add-dir', 'bug', 'vim',
  'terminal-setup', 'theme', 'export', 'rewind', 'statusline', 'output-style', 'plugin', 'fast', 'effort', 'loop', 'new', 'reset']);

/** Whole blocks a harness wraps around (or prepends to) what a person typed. */
const WRAPPER_BLOCKS = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<local-command-(?:caveat|stdout|stderr)>[\s\S]*?<\/local-command-(?:caveat|stdout|stderr)>/g,
  /<environment_context>[\s\S]*?<\/environment_context>/g,
  /<user_instructions>[\s\S]*?<\/user_instructions>/g,
  /<user-prompt-submit-hook>[\s\S]*?<\/user-prompt-submit-hook>/g,
  /<command-(?:message|args)>[\s\S]*?<\/command-(?:message|args)>/g,
];

/** A first line that starts an instruction block, a system note or a continuation, not a request. */
const BOILERPLATE = [
  /^#*\s*AGENTS(?:\.base|\.local)?\.md\b/i,
  /^#*\s*CLAUDE\.md\b/i,
  /^#\s*AGENTS\.md instructions for\b/i,
  /^Contents of \S+/i,
  /^Codebase and user instructions\b/i,
  /^As you answer the user's questions\b/i,
  /^Caveat:/i,
  /^\[(?:SYSTEM|system)\b/,
  /^\[Request interrupted\b/i,
  /^IMPORTANT:/,
  /^This session is being continued from a previous conversation\b/i,
  /^You (?:are|were) (?:running|woken|invoked|an? |the |powered)\b/i,
  /^You are [\w-]+, /, // persona preambles ("You are <name>, <role> ...")
  /^(?:#+\s*)?(?:Environment|System prompt|System|Context)\s*(?::|$)/i,
  /^Base directory for this skill:/i,
  /^</, // any wrapper tag left over
];

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** One line, under 100 characters, cut at a word when it can be. */
export function clampTitle(s: string, max = TITLE_MAX): string {
  const t = oneLine(s);
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The skill or custom slash command a prompt invoked, from Claude Code's `<command-name>` tag, a skill expansion or a leading `/name`. */
export function skillOf(text: string): string | null {
  const tag = /<command-name>\s*\/?([A-Za-z0-9][\w:.-]*)\s*<\/command-name>/.exec(text);
  const base = /Base directory for this skill:\s*\S*?\/skills\/([A-Za-z0-9][\w.-]*)/.exec(text);
  const lead = /^\s*\/([a-z0-9][\w:.-]*)(?:\s|$)/i.exec(stripChannelTag(text));
  const name = tag?.[1] ?? base?.[1] ?? lead?.[1] ?? null;
  if (!name) return null;
  const bare = name.includes(':') ? name.split(':').pop()! : name;
  return LOCAL_COMMANDS.has(bare.toLowerCase()) ? null : name;
}

/** The first line a person actually wrote in a prompt, or null when the prompt is only wrappers and boilerplate. */
export function substantiveLine(text: string | null | undefined): string | null {
  if (!text) return null;
  let t = stripChannelTag(text);
  for (const re of WRAPPER_BLOCKS) t = t.replace(re, '\n');
  t = t.replace(/<command-name>[\s\S]*?<\/command-name>/g, '\n');
  const first = t.split('\n').map((l) => l.trim()).find((l) => l !== '');
  if (!first || BOILERPLATE.some((re) => re.test(first))) return null;
  // A bare slash command (a local one, or a skill that is reported separately) is not a request.
  if (/^\/[\w:.-]+$/.test(first)) return null;
  // Markdown decoration only: a heading or a quote marker is not part of the name.
  const clean = first.replace(/^#{1,6}\s+/, '').replace(/^>\s*/, '').trim();
  return clean || null;
}

export function sessionTitle(input: { taskTitle?: string | null; title?: string | null; prompts?: Array<string | null> | null }): SessionTitle | null {
  const task = input.taskTitle ? oneLine(input.taskTitle) : '';
  if (task) return { text: clampTitle(task), source: 'task' };
  const prompts = (input.prompts ?? []).filter((p): p is string => typeof p === 'string' && p !== '');
  for (const p of prompts) {
    const skill = skillOf(p);
    if (skill) return { text: clampTitle(skill), source: 'skill' };
    if (substantiveLine(p)) break; // a real request came first: the session is about that, not a later command
  }
  const own = substantiveLine(input.title ?? null);
  if (own) return { text: clampTitle(own), source: 'title' };
  for (const p of prompts) {
    const line = substantiveLine(p);
    if (line) return { text: clampTitle(line), source: 'prompt' };
  }
  return null;
}
