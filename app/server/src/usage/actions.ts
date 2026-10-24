import type { Action } from './types.js';

/** What a model call did, from the first tool it invoked. The plan: usage-attribution-plan.md, section C. */
export const ACTIONS: Action[] = ['dm', 'post', 'ticket', 'card', 'tracker', 'write', 'read', 'shell', 'reply'];
export const WORK_TYPES = ['research', 'coding', 'design', 'media', 'writing', 'sales', 'education', 'ops'] as const;
export type WorkType = (typeof WORK_TYPES)[number];
export const LANE_WORK: Record<string, WorkType> = { 'cc-coder': 'coding', 'cc-research': 'research', 'cc-writer': 'writing', 'cc-reviewer': 'coding' };

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'ToolSearch', 'TodoRead']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const ZEN_READ = new Set(['read_file', 'list_dir', 'search_notes', 'search_everything', 'read_note', 'read_skill',
  'org_read', 'org_whoami', 'org_tasks', 'org_recall', 'board_list', 'card_show']);
const ZEN_POST = new Set(['org_post', 'org_handoff', 'org_ask_owner']);

/** The same classes for a zen-agent run, from its typed tool names; a `bash` call is judged by its command as Claude's Bash is. */
export function classifyZenAction(tool: string | null, args: unknown): Action {
  if (!tool) return 'reply';
  if (tool === 'org_dm') return 'dm';
  if (ZEN_POST.has(tool)) return 'post';
  if (tool === 'org_task_create') return 'ticket';
  if (tool.startsWith('card_')) return 'card';
  if (tool === 'write_file' || tool === 'edit_file') return 'write';
  if (ZEN_READ.has(tool)) return 'read';
  if (tool === 'bash') return classifyAction('Bash', args);
  return 'shell';
}

export function classifyAction(tool: string | null, input: unknown): Action {
  if (!tool) return 'reply';
  if (WRITE_TOOLS.has(tool)) return 'write';
  if (READ_TOOLS.has(tool)) return 'read';
  if (tool !== 'Bash') return 'shell';
  const cmd = (input && typeof input === 'object' && typeof (input as { command?: unknown }).command === 'string')
    ? (input as { command: string }).command.trim() : '';
  // The first command of a pipeline or chain decides; `cd x && cli-org post` is still a post.
  const words = cmd.split(/\s*(?:&&|\|\||;|\|)\s*/).map((w) => w.trim()).filter((w) => w && !/^cd\s/.test(w));
  for (const w of words) {
    // `ORG_AGENT=atlas cli-org …`, `sudo -u <user> hermes kanban …`, `~/.local/bin/cli-org …` all count.
    const m = /(?:^|[/\s])(cli-org|cli-projects|hermes)\s+(.*)$/.exec(w.replace(/^(?:\w+=\S*\s+)+/, ''));
    if (!m) break;
    const rest = m[2]!.replace(/^(--\S+\s+\S+\s+)+/, '');
    const verb = rest.split(/\s+/)[0] ?? '';
    const sub = rest.split(/\s+/)[1] ?? '';
    if (m[1] === 'cli-org') {
      if (verb === 'dm') return 'dm';
      if (['post', 'handoff', 'standup', 'ask-owner', 'reply'].includes(verb)) return 'post';
      if (verb === 'graph' || (verb === 'task' && ['create', 'assign', 'redo'].includes(sub))) return 'ticket';
      return 'read';
    }
    if (m[1] === 'cli-projects') return ['list', 'report', 'show'].includes(verb) ? 'read' : 'tracker';
    if (verb === 'kanban') return 'card';
    break;
  }
  return 'shell';
}
