import type { Model, Models } from '@earendil-works/pi-ai';
import { estimateTokens } from './context.js';

/**
 * Compaction as a policy, not a surprise. When the transcript passes the cap,
 * everything between the leading system message and the last `keepTurns` user
 * turns is summarised by the model into one user message, and the tail is kept
 * verbatim. The cut always lands on a user message, so no tool call is parted
 * from its result. The session records every compaction with its sizes.
 */
export interface CompactOptions {
  models: Models;
  model: Model<any>;
  capTokens: number;
  keepTurns: number;
  signal?: AbortSignal;
  /** Replaces the model call (tests). */
  summarize?: (text: string) => Promise<string>;
}

export interface CompactResult {
  messages: unknown[];
  compacted: boolean;
  before: number;
  after: number;
  dropped: number;
}

export const SUMMARY_PROMPT =
  'Summarise the conversation below for an agent that will continue the work with no other memory of it. ' +
  'Keep: the task and its contract, decisions made, files and paths touched, commands run and their results, ' +
  'open questions, and what is left to do. Be concrete and short; use plain prose and lists; do not add advice.';

export function transcriptTokens(messages: unknown[]): number {
  return estimateTokens(JSON.stringify(messages));
}

export function renderForSummary(messages: unknown[]): string {
  return messages
    .map((m) => {
      const msg = m as { role: string; content: unknown; toolName?: string };
      const content = Array.isArray(msg.content)
        ? msg.content
            .map((b) => {
              const block = b as { type: string; text?: string; name?: string; arguments?: unknown };
              if (block.type === 'text') return block.text ?? '';
              if (block.type === 'toolCall') return `[call ${block.name} ${JSON.stringify(block.arguments)}]`;
              return `[${block.type}]`;
            })
            .join('\n')
        : String(msg.content ?? '');
      return `${msg.role}${msg.toolName ? ` (${msg.toolName})` : ''}: ${content.slice(0, 4000)}`;
    })
    .join('\n\n');
}

/** Index of the user message that starts the kept tail, or -1 when there is nothing to cut. */
export function cutIndex(messages: unknown[], keepTurns: number): number {
  const userIdx: number[] = [];
  messages.forEach((m, i) => {
    if (i > 0 && (m as { role: string }).role === 'user') userIdx.push(i);
  });
  if (keepTurns <= 0 || userIdx.length <= keepTurns) return -1;
  const cut = userIdx[userIdx.length - keepTurns]!;
  return cut <= 1 ? -1 : cut;
}

export async function compact(messages: unknown[], opts: CompactOptions): Promise<CompactResult> {
  const before = transcriptTokens(messages);
  const none = { messages, compacted: false, before, after: before, dropped: 0 };
  if (before <= opts.capTokens) return none;
  const cut = cutIndex(messages, opts.keepTurns);
  if (cut < 0) return none;
  const head = messages[0];
  const middle = messages.slice(1, cut);
  const tail = messages.slice(cut);
  const text = renderForSummary(middle);
  let summary: string;
  try {
    summary = opts.summarize
      ? await opts.summarize(text)
      : await (async () => {
          const r = await opts.models.complete(opts.model, {
            systemPrompt: SUMMARY_PROMPT,
            messages: [{ role: 'user', content: text, timestamp: Date.now() }],
          }, { signal: opts.signal, maxTokens: 2000 });
          return r.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
        })();
  } catch {
    return none; // A failed summary is not a reason to stop the run; the next turn tries again.
  }
  const note = { role: 'user', content: `[Earlier conversation, compacted]\n${summary}`, timestamp: Date.now() };
  const out = [head, note, ...tail];
  return { messages: out, compacted: true, before, after: transcriptTokens(out), dropped: middle.length };
}
