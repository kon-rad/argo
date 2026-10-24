import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import { execFile } from 'node:child_process';
import type { KanbanConfig } from '../config.js';
import { clipOutput, text, tool, type ToolContext } from './index.js';

/**
 * The kanban board as typed tools. Two backends speak to the same board:
 * `hub` is agent-hub's HTTP API (bearer token from the environment; list,
 * show, create, comment, assign), `cli` is the board's own command line
 * (`hermes kanban`, which also completes and blocks cards). The tool set the
 * model sees is whatever the backend can do, so it never calls what will fail.
 */
export interface Card {
  id: string;
  title: string;
  body: string | null;
  assignee: string | null;
  status: string;
  priority?: number;
  created_by?: string | null;
  created_at?: number;
  result?: string | null;
}

export interface CardDetail {
  task: Card;
  comments: { author: string; body: string; created_at: number }[];
  parents?: string[];
  children?: string[];
  latest_summary?: string | null;
}

export interface KanbanBackend {
  readonly kind: 'hub' | 'cli';
  readonly board: string;
  list(board?: string): Promise<Card[]>;
  show(id: string, board?: string): Promise<CardDetail>;
  create(c: { title: string; body: string; assignee: string; board?: string; project?: string; feature?: string }): Promise<Card>;
  comment(id: string, text: string, board?: string): Promise<void>;
  assign(id: string, assignee: string, opts?: { board?: string; project?: string; feature?: string }): Promise<void>;
  complete?(id: string, result?: string, board?: string): Promise<void>;
  block?(id: string, reason: string, board?: string): Promise<void>;
}

const CARD_ID = /^t_[0-9a-f]{6,32}$/;
function checkId(id: string): string {
  if (!CARD_ID.test(id)) throw new Error(`bad card id "${id}" (t_ followed by hex)`);
  return id;
}

export class HubKanban implements KanbanBackend {
  readonly kind = 'hub' as const;
  private readonly url: string;
  constructor(
    url: string,
    private readonly token: string,
    readonly board: string,
    private readonly fetchFn: typeof fetch,
  ) {
    this.url = url.replace(/\/+$/, '');
  }

  private async call<T>(method: 'GET' | 'POST', path: string, query?: Record<string, string | undefined>, body?: unknown): Promise<T> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v) q.set(k, v);
    const res = await this.fetchFn(`${this.url}${path}${q.size ? `?${q}` : ''}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const msg = typeof data?.['error'] === 'string' ? data['error'] : (data?.['error'] as { message?: string } | undefined)?.message;
      throw new Error(`kanban ${res.status}${msg ? `: ${msg}` : ''}`);
    }
    return data as T;
  }

  async list(board = this.board): Promise<Card[]> {
    return (await this.call<{ tasks: Card[] }>('GET', '/board', { board })).tasks;
  }
  async show(id: string, board = this.board): Promise<CardDetail> {
    return this.call('GET', `/tasks/${checkId(id)}`, { board });
  }
  async create(c: { title: string; body: string; assignee: string; board?: string; project?: string; feature?: string }): Promise<Card> {
    return this.call('POST', '/tasks', undefined, { ...c, board: c.board ?? this.board });
  }
  async comment(id: string, body: string, board = this.board): Promise<void> {
    await this.call('POST', `/tasks/${checkId(id)}/comment`, undefined, { board, text: body });
  }
  async assign(id: string, assignee: string, opts: { board?: string; project?: string; feature?: string } = {}): Promise<void> {
    await this.call('POST', `/tasks/${checkId(id)}/assign`, undefined, { board: opts.board ?? this.board, assignee, project: opts.project, feature: opts.feature });
  }
}

export type Exec = (cmd: string, args: string[]) => Promise<string>;

export const execKanban: Exec = (cmd, args) =>
  new Promise((ok, fail) => {
    execFile(cmd, args, { timeout: 30_000, maxBuffer: 4_000_000 }, (err, stdout, stderr) => {
      if (err) fail(new Error(`kanban: ${(stderr || err.message).trim().slice(0, 400)}`));
      else ok(stdout);
    });
  });

export class CliKanban implements KanbanBackend {
  readonly kind = 'cli' as const;
  constructor(
    private readonly command: string,
    readonly board: string,
    private readonly author: string,
    private readonly exec: Exec = execKanban,
  ) {}

  private run(board: string, args: string[]): Promise<string> {
    return this.exec(this.command, ['kanban', '--board', board, ...args]);
  }
  private json<T>(out: string): T {
    try {
      return JSON.parse(out) as T;
    } catch {
      throw new Error(`kanban: expected JSON, got: ${out.slice(0, 200)}`);
    }
  }

  async list(board = this.board): Promise<Card[]> {
    const doc = this.json<Card[] | { tasks?: Card[] }>(await this.run(board, ['list', '--json']));
    return Array.isArray(doc) ? doc : (doc.tasks ?? []);
  }
  async show(id: string, board = this.board): Promise<CardDetail> {
    const doc = this.json<Partial<CardDetail> & Card>(await this.run(board, ['show', checkId(id), '--json']));
    return { task: doc.task ?? doc, comments: doc.comments ?? [], parents: doc.parents, children: doc.children, latest_summary: doc.latest_summary ?? null };
  }
  async create(c: { title: string; body: string; assignee: string; board?: string }): Promise<Card> {
    const out = await this.run(c.board ?? this.board, ['create', `--body=${c.body}`, '--assignee', c.assignee, '--created-by', this.author, '--json', '--', c.title]);
    const doc = this.json<Card | { task: Card }>(out);
    return 'task' in doc ? doc.task : doc;
  }
  async comment(id: string, body: string, board = this.board): Promise<void> {
    await this.run(board, ['comment', '--author', this.author, '--', checkId(id), body]);
  }
  async assign(id: string, assignee: string, opts: { board?: string } = {}): Promise<void> {
    await this.run(opts.board ?? this.board, ['assign', checkId(id), assignee]);
  }
  async complete(id: string, result?: string, board = this.board): Promise<void> {
    await this.run(board, ['complete', checkId(id), ...(result ? ['--result', result] : [])]);
  }
  async block(id: string, reason: string, board = this.board): Promise<void> {
    await this.run(board, ['block', checkId(id), reason]);
  }
}

export function makeKanban(cfg: KanbanConfig, env: NodeJS.ProcessEnv, fetchFn: typeof fetch, author: string, exec?: Exec): KanbanBackend | null {
  if (cfg.kind === 'hub') {
    const token = env[cfg.tokenEnv];
    if (!token) throw new Error(`kanban: ${cfg.tokenEnv} is not set`);
    return new HubKanban(cfg.url.replace(/\/+$/, ''), token, cfg.board, fetchFn);
  }
  if (cfg.kind === 'cli') return new CliKanban(cfg.command, cfg.board, author, exec);
  return null;
}

export function formatCard(c: Card): string {
  return `${c.id}  [${c.status}]${c.assignee ? ` ${c.assignee}` : ''}  ${c.title}`;
}

export function formatDetail(d: CardDetail): string {
  const t = d.task;
  const head = `${t.id}: ${t.title}\nstatus: ${t.status}${t.assignee ? `, assignee: ${t.assignee}` : ''}${t.created_by ? `, by ${t.created_by}` : ''}`;
  const body = t.body ? `\n\n${t.body}` : '';
  const rel = [d.parents?.length ? `parents: ${d.parents.join(', ')}` : '', d.children?.length ? `children: ${d.children.join(', ')}` : ''].filter(Boolean).join('\n');
  const comments = d.comments.length
    ? `\n\nComments:\n${d.comments.map((c) => `- ${c.author} (${new Date(c.created_at > 1e12 ? c.created_at : c.created_at * 1000).toISOString().slice(0, 16)}): ${c.body}`).join('\n')}`
    : '';
  return `${head}${rel ? `\n${rel}` : ''}${body}${comments}`;
}

export function kanbanTools(ctx: ToolContext, backend?: KanbanBackend | null): AgentTool<any>[] {
  const kb = backend === undefined ? makeKanban(ctx.cfg.kanban, ctx.env, ctx.fetch, ctx.persona?.name ?? 'zen-agent') : backend;
  if (!kb) return [];
  const max = ctx.cfg.shell.maxOutput;
  const Board = Type.Optional(Type.String({ description: `Board slug (default ${kb.board})` }));

  const tools: AgentTool<any>[] = [
    tool({
      name: 'board_list',
      label: 'List cards',
      description: 'The cards on the kanban board, optionally only those with a status or an assignee.',
      parameters: Type.Object({ board: Board, status: Type.Optional(Type.String()), assignee: Type.Optional(Type.String()) }),
      execute: async (a) => {
        let cards = await kb.list(a.board);
        if (a.status) cards = cards.filter((c) => c.status === a.status);
        if (a.assignee) cards = cards.filter((c) => c.assignee === a.assignee);
        return text(clipOutput(cards.map(formatCard).join('\n') || 'no cards', max), { count: cards.length });
      },
    }),
    tool({
      name: 'card_show',
      label: 'Show card',
      description: 'A card with its body, relations and comments.',
      parameters: Type.Object({ id: Type.String(), board: Board }),
      execute: async (a) => text(clipOutput(formatDetail(await kb.show(a.id, a.board)), max), { id: a.id }),
    }),
    tool({
      name: 'card_create',
      label: 'Create card',
      description: 'Create a card for a bot. Put the contract in the body under ## Objective, ## Returns, ## Budget, ## Scope, ## Verification.',
      parameters: Type.Object({
        title: Type.String({ maxLength: 200 }),
        body: Type.String({ maxLength: 6000 }),
        assignee: Type.String(),
        board: Board,
        project: Type.Optional(Type.String()),
        feature: Type.Optional(Type.String()),
      }),
      execute: async (a) => {
        const c = await kb.create(a);
        return text(`created ${c.id}: ${c.title} for ${c.assignee ?? a.assignee}`, { id: c.id });
      },
    }),
    tool({
      name: 'card_comment',
      label: 'Comment on card',
      description: 'Add a comment to a card: progress, a question, where the work landed.',
      parameters: Type.Object({ id: Type.String(), text: Type.String({ maxLength: 6000 }), board: Board }),
      execute: async (a) => {
        await kb.comment(a.id, a.text, a.board);
        return text(`commented on ${a.id}`, { id: a.id });
      },
    }),
    tool({
      name: 'card_assign',
      label: 'Assign card',
      description: 'Give a card to an agent (or "none" to unassign).',
      parameters: Type.Object({ id: Type.String(), assignee: Type.String(), board: Board, project: Type.Optional(Type.String()), feature: Type.Optional(Type.String()) }),
      execute: async (a) => {
        await kb.assign(a.id, a.assignee, a);
        return text(`${a.id} is now ${a.assignee}'s`, { id: a.id });
      },
    }),
  ];
  if (kb.complete) {
    tools.push(tool({
      name: 'card_complete',
      label: 'Complete card',
      description: 'Mark your card done, with a one-line result (a path, a PR, a message id). Only after the work is verified.',
      parameters: Type.Object({ id: Type.String(), result: Type.Optional(Type.String({ maxLength: 2000 })), board: Board }),
      execute: async (a) => {
        await kb.complete!(a.id, a.result, a.board);
        return { ...text(`${a.id} completed`, { id: a.id }), terminate: false };
      },
    }));
  }
  if (kb.block) {
    tools.push(tool({
      name: 'card_block',
      label: 'Block card',
      description: 'Mark your card blocked with the reason, when you cannot finish it this run.',
      parameters: Type.Object({ id: Type.String(), reason: Type.String({ maxLength: 2000 }), board: Board }),
      execute: async (a) => {
        await kb.block!(a.id, a.reason, a.board);
        return text(`${a.id} blocked: ${a.reason}`, { id: a.id });
      },
    }));
  }
  return tools;
}
