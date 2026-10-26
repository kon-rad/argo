import { z } from 'zod';

/** What the model writes. Everything else on a summary row is computed (derive.ts). */
export const PROMPT_VERSION = 'v1';

export const OUTCOMES = ['finished', 'partial', 'blocked', 'failed', 'unknown'] as const;

const text = (max: number) => z.string().trim().max(max).default('');

export const ModelSummary = z.object({
  request: text(600),
  done: text(900),
  learned: text(900),
  open_items: text(600),
  outcome: z.enum(OUTCOMES).catch('unknown'),
  facts: z
    .array(z.object({ subject: z.string().trim().min(1).max(200), claim: z.string().trim().min(1).max(600) }))
    .max(5)
    .catch([]),
});
export type ModelSummary = z.infer<typeof ModelSummary>;

/** Pulls the JSON object out of an answer that may be fenced or have thinking text around it. */
export function parseModelSummary(raw: string): ModelSummary | null {
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/g, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = ModelSummary.safeParse(JSON.parse(cleaned.slice(start, end + 1)));
    if (!parsed.success) return null;
    // An all-empty object is a refusal in disguise.
    const s = parsed.data;
    return s.request || s.done ? s : null;
  } catch {
    return null;
  }
}

export const SYSTEM_PROMPT = `You write a short, factual record of one AI agent work session for the person who owns it.
You are given a compacted transcript: [prompt] is what the person or a dispatcher asked, [response] is what the agent said, [tool] is a tool call, [error] is a failed tool result.
Rules:
- A message ending in [...] was shortened for you; that is not the agent being cut off. Judge how the session ended from the last [response] and the last tool results. Where steps are marked omitted, say nothing about them.
- Use only what the transcript shows. Never invent files, numbers, names, or results. If something is unclear, say so or leave the field empty.
- Write plain sentences, no markdown, no em-dashes. Past tense for done, imperative or noun phrases for open_items.
- request: what was asked, in 1 to 3 sentences.
- done: what was actually completed, naming concrete things (files, commands, decisions) that appear in the transcript. Copy names, counts and file names exactly; do not list or total anything you cannot see in full.
- learned: durable findings worth remembering later (a cause, a constraint, a decision and why). Empty if nothing.
- open_items: what is unfinished, blocked, or needs a decision. Empty if nothing.
- outcome: finished (the request was met), partial, blocked (waiting on someone or something), failed (errors ended it), unknown (cannot tell).
- facts: up to 5 standalone claims a future agent should know, each with a short subject. Only claims the transcript supports. Empty list if none.
Answer with one JSON object and nothing else: {"request": "", "done": "", "learned": "", "open_items": "", "outcome": "unknown", "facts": [{"subject": "", "claim": ""}]}`;
