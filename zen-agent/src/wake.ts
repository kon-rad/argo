import { parseBudgetLine, type Budget } from './config.js';
import type { CardDetail } from './tools/kanban.js';
import { formatDetail } from './tools/kanban.js';

/**
 * A bot wake: the card is the task. The prompt carries the card verbatim
 * (body, comments) and the standing orders of a wake; the card's `## Budget`
 * line, when it has one, becomes the run's budget. What the dispatcher used
 * to hold in a shell script is one function here, stamped in the session.
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
  ].join('\n');
}
