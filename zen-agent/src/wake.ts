import type { AgentEvent } from '@earendil-works/pi-agent-core';
import type { Models } from '@earendil-works/pi-ai';
import { ZenAgent, type RunResult } from './agent.js';
import { parseBudgetLine, type Budget, type ThinkingLevel, type ZenConfig } from './config.js';
import type { Part } from './context.js';
import { execCommand, fetchParts, fetchersFor, type Exec, type FetcherStat } from './fetchers.js';
import { loadPersona, type Persona } from './persona.js';
import type { CardDetail, KanbanBackend } from './tools/kanban.js';
import { formatDetail } from './tools/kanban.js';

/**
 * A bot wake: the card is the task. The prompt carries the card verbatim
 * (body, comments) and the standing orders of a wake; the card's `## Budget`
 * line, when it has one, becomes the run's budget. What the dispatcher used
 * to hold in a shell script is one function here, stamped in the session.
 *
 * Every wake is a fresh run. Nothing of an earlier session is replayed: the
 * model sees the card, the thread it answers (when the wake is a reply) and
 * the parts the configured fetchers bring, and keeps nothing else between
 * wakes but its memory file and what it saved with org_remember. A wake never
 * takes `--resume`; that flag belongs to `run` and `chat`.
 */
export interface WakeInput {
  card: CardDetail;
  persona: string | null;
  canComplete: boolean;
}

export function cardBudget(body: string | null): Partial<Budget> {
  if (!body) return {};
  const m = /^##\s*Budget\s*\n([\s\S]*?)(?=\n##\s|\s*$)/im.exec(body);
  return m ? parseBudgetLine(m[1]!) : {};
}

export function wakePrompt(input: WakeInput): string {
  const id = input.card.task.id;
  const finish = input.canComplete
    ? `When the work is done and verified, call card_complete on ${id} with a one-line result. When you cannot finish this run, call card_block on ${id} with the reason.`
    : `When the work is done and verified, comment on ${id} with the result and say DONE in your final message; when you cannot finish, comment with the reason and say BLOCKED: <reason>.`;
  return [
    `You were woken for card ${id}. One card, one run: do this card's work and nothing else.`,
    '',
    formatDetail(input.card),
    '',
    'Standing orders:',
    `- Read the card's Objective, Returns, Scope and Verification; produce exactly the Returns.`,
    `- Work inside the Scope. Post at most one status (org_post, kind status) with evidence: a path, a command, a card id.`,
    `- ${finish}`,
    `- Keep the context small: cap command output, read big files in parts, one step at a time.`,
    `- Never present a partial result as done. If a step needs a person, block the card and say so.`,
    `- This run starts fresh: nothing from your earlier runs is in front of you. What you need to carry over goes in your memory file or org_remember; the rest you look up.`,
  ].join('\n');
}

export interface WakeContextInput {
  cfg: ZenConfig;
  card: CardDetail | null;
  persona: Persona | null;
  env?: NodeJS.ProcessEnv;
  exec?: Exec;
  /** The message a DM, handoff or mention wake answers; builds the `thread` part. */
  thread?: number | null;
  /** Fetchers for this wake; null or undefined means the configured ones (`context.fetchers`), [] means none. */
  fetchers?: string[] | null;
}

/** The fetched parts of a wake and what each fetcher did: the context a wake has beyond the card itself. */
export async function wakeContext(o: WakeContextInput): Promise<{ parts: Part[]; fetchers: FetcherStat[] }> {
  const names = o.fetchers ?? fetchersFor(o.cfg, o.card, o.persona);
  const r = await fetchParts(names, { cfg: o.cfg, card: o.card, persona: o.persona, env: o.env ?? process.env, exec: o.exec ?? execCommand, thread: o.thread ?? null });
  return { parts: r.parts, fetchers: r.stats };
}

export interface WakeRun {
  cfg: ZenConfig;
  kb: KanbanBackend;
  cardId: string;
  board?: string;
  /** The roster name; null runs the default identity. */
  persona: string | null;
  budget?: Partial<Budget>;
  /** Extra standing orders from the caller (the dispatcher's wake prompt). */
  task?: string;
  /** The previous run's conclusion, the `handoff` part. */
  handoff?: string;
  /** Tool set names for this run, instead of the config's. */
  toolSets?: string[];
  /** Thinking level for this run, instead of the config's. */
  thinking?: ThinkingLevel;
  /** Overrides the config's and the persona's model (the CLI's --model). */
  model?: string;
  /** A dispatcher's labels for the trace's meta line. */
  dispatch?: Record<string, unknown>;
  thread?: number | null;
  fetchers?: string[] | null;
  /** The card's own tools finish it; false when the backend cannot (the model comments and says DONE). */
  canComplete?: boolean;
  env?: NodeJS.ProcessEnv;
  exec?: Exec;
  models?: Models;
  onEvent?: (event: AgentEvent) => void;
}

export interface WakeResult extends RunResult {
  card: CardDetail;
  fetchers: FetcherStat[];
}

/**
 * One card wake, start to finish: read the card, build its context, run a new session as the persona, report. The
 * session id is always new; there is no path through here that resumes one.
 */
export async function runWake(o: WakeRun): Promise<WakeResult> {
  const card = await o.kb.show(o.cardId, o.board);
  const persona = o.persona ? loadPersona(o.cfg, o.persona) : null;
  const budget = { ...cardBudget(card.task.body), ...o.budget };
  const ctx = await wakeContext({ cfg: o.cfg, card, persona, env: o.env, exec: o.exec, thread: o.thread, fetchers: o.fetchers });
  const zen = new ZenAgent({ config: o.cfg, persona, budget, task: o.task, handoff: o.handoff, toolSets: o.toolSets, thinking: o.thinking, model: o.model, dispatch: o.dispatch, parts: ctx.parts, fetchers: ctx.fetchers, env: o.env, models: o.models, onEvent: o.onEvent });
  const r = await zen.run(wakePrompt({ card, persona: persona?.name ?? null, canComplete: o.canComplete ?? Boolean(o.kb.complete) }));
  return { ...r, card, fetchers: ctx.fetchers };
}
