import { createHash } from 'node:crypto';
import { query } from '../db.js';
import { expandSteps, toolSummary, type StepPart } from '../archive/steps.js';
import { redactor } from '../archive/redact.js';

export interface SessionRow {
  id: number;
  source: string;
  harness: string | null;
  host: string;
  profile: string | null;
  external_id: string;
  project: string | null;
  title: string | null;
  started_at: Date | null;
  ended_at: Date | null;
  updated_at: Date;
}

export interface Compacted {
  text: string;
  sha: string;
  /** Prompt + response steps: what "worth summarizing" counts. */
  conversational: number;
  omitted: number;
}

const MESSAGE_LIMIT = 6000;

/** Every part of a session in order, harness-neutral (Claude Code, Hermes and zen-agent rows all expand the same way). */
export async function loadParts(sessionId: number): Promise<StepPart[]> {
  const { rows } = await query<{ id: number; role: string; kind: string; ts: Date | null; raw: unknown; content_text: string | null }>(
    `SELECT id, role, kind, ts, raw, content_text FROM archive_messages WHERE session_id = $1 ORDER BY seq LIMIT ${MESSAGE_LIMIT}`,
    [sessionId],
  );
  return rows.flatMap((r) => expandSteps({ id: r.id, role: r.role, kind: r.kind, ts: r.ts, raw: r.raw, text: r.content_text ?? '' }));
}

const clip = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)} [...]` : flat;
};

/** One line per step that matters. Thinking, system and meta records are dropped; tool output is kept only when it failed. */
export function lines(parts: StepPart[]): string[] {
  const out: string[] = [];
  // The last response is how the session ended (a report, an answer, a hand-off): clipped to 1,000 characters it
  // read as an agent that was cut off, so it keeps more room than the running commentary.
  const lastResponse = parts.map((p) => p.step).lastIndexOf('response');
  parts.forEach((p, i) => {
    if (p.step === 'prompt') out.push(`[prompt] ${clip(p.text, 1500)}`);
    else if (p.step === 'response') out.push(`[response] ${clip(p.text, i === lastResponse ? 3500 : 1000)}`);
    else if (p.step === 'tool_call') out.push(`[tool] ${p.toolName ?? 'tool'}: ${clip(toolSummary(p.toolName ?? '', p.text), 160)}`);
    else if (p.step === 'tool_result' && p.isError) out.push(`[error] ${clip(p.text, 240)}`);
  });
  return out.filter((l) => l.length > 10);
}

/** Fits the transcript in `maxChars`: the start (what was asked) and the end (how it ended) are kept, the middle is cut. */
export function compact(parts: StepPart[], maxChars: number): Compacted {
  const all = lines(parts);
  const conversational = parts.filter((p) => p.step === 'prompt' || p.step === 'response').length;
  let kept = all;
  let omitted = 0;
  const total = all.reduce((n, l) => n + l.length + 1, 0);
  if (total > maxChars) {
    const head: string[] = [];
    const tail: string[] = [];
    let used = 0;
    const headBudget = Math.floor(maxChars * 0.35);
    const tailBudget = Math.floor(maxChars * 0.6);
    for (const l of all) { if (used + l.length + 1 > headBudget) break; head.push(l); used += l.length + 1; }
    used = 0;
    for (let i = all.length - 1; i >= head.length; i--) {
      const l = all[i]!;
      if (used + l.length + 1 > tailBudget) break;
      tail.unshift(l);
      used += l.length + 1;
    }
    omitted = all.length - head.length - tail.length;
    kept = [...head, `[... ${omitted} steps omitted ...]`, ...tail];
  }
  const text = redactor().text(kept.join('\n'));
  return { text, sha: createHash('sha256').update(text).digest('hex'), conversational, omitted };
}
