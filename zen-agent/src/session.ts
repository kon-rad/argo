import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PartStat } from './context.js';

/** The trace format version a reader checks before it parses; bump when a line's shape changes. */
export const TRACE_VERSION = 1;

/**
 * One JSONL file per run: the trace. Every message as the model saw it, every
 * tool call with its timing, the size of each system-prompt part, and the
 * totals at the end. It is what an archive collector reads, what a resume
 * replays, and what an eval diffs; nothing is captured by proxy.
 */
export type SessionLine =
  | { type: 'meta'; version: number; id: string; at: string; persona: string | null; model: string; parts: PartStat[]; parent: string | null; dispatch: Record<string, unknown>; [k: string]: unknown }
  | { type: 'message'; at: string; message: unknown }
  | { type: 'tool'; at: string; toolCallId: string; name: string; args: unknown; isError: boolean; durationMs: number | null }
  | { type: 'blocked'; at: string; name: string; reason: string }
  | { type: 'compaction'; at: string; before: number; after: number; dropped: number }
  | { type: 'end'; at: string; stopped: string; turns: number; usage: UsageTotals; error?: string };

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

export interface SessionSummary {
  id: string;
  at: string | null;
  persona: string | null;
  model: string | null;
  resumed: string | null;
  parts: PartStat[];
  fetchers: { name: string; on: boolean; chars: number; tokens: number; error: string | null }[];
  /** Estimated tokens of the system prompt, the sum of the parts. */
  promptTokens: number;
  messages: number;
  stopped: string | null;
  turns: number | null;
  usage: UsageTotals | null;
}

export const ZERO_USAGE: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };

export function newSessionId(prefix: string | null, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix ?? 'zen'}-${stamp}-${rand}`;
}

export class Session {
  readonly path: string;

  constructor(
    readonly dir: string,
    readonly id: string,
  ) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, `${id}.jsonl`);
  }

  write(line: SessionLine): void {
    appendFileSync(this.path, JSON.stringify(line) + '\n');
  }

  static exists(dir: string, id: string): boolean {
    return existsSync(join(dir, `${id}.jsonl`));
  }

  /** The messages of an earlier run, in order, for a resume; compactions are already applied by whoever wrote them. */
  static load(dir: string, id: string): { meta: SessionLine | null; messages: unknown[] } {
    const text = readFileSync(join(dir, `${id}.jsonl`), 'utf8');
    let meta: SessionLine | null = null;
    const messages: unknown[] = [];
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue;
      let line: SessionLine;
      try {
        line = JSON.parse(raw) as SessionLine;
      } catch {
        continue;
      }
      if (line.type === 'meta') meta = line;
      else if (line.type === 'message') messages.push(line.message);
    }
    return { meta, messages };
  }

  /**
   * One run in numbers: what the trace's `meta` and `end` lines say, without the messages. `zen-agent sessions --json`
   * prints this per session, so "tokens per wake before and after a change" is one pipe over the sessions folder.
   */
  static summary(dir: string, id: string): SessionSummary {
    const text = readFileSync(join(dir, `${id}.jsonl`), 'utf8');
    let meta: Record<string, unknown> | null = null;
    let end: Record<string, unknown> | null = null;
    let messages = 0;
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue;
      let line: Record<string, unknown>;
      try {
        line = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (line['type'] === 'meta') meta = line;
      else if (line['type'] === 'end') end = line;
      else if (line['type'] === 'message') messages++;
    }
    return {
      id,
      at: (meta?.['at'] as string | undefined) ?? null,
      persona: (meta?.['persona'] as string | null | undefined) ?? null,
      model: (meta?.['model'] as string | undefined) ?? null,
      resumed: (meta?.['resumed'] as string | null | undefined) ?? null,
      parts: (meta?.['parts'] as PartStat[] | undefined) ?? [],
      fetchers: (meta?.['fetchers'] as SessionSummary['fetchers'] | undefined) ?? [],
      promptTokens: ((meta?.['parts'] as PartStat[] | undefined) ?? []).reduce((n, p) => n + p.tokens, 0),
      messages,
      stopped: (end?.['stopped'] as string | undefined) ?? null,
      turns: (end?.['turns'] as number | undefined) ?? null,
      usage: (end?.['usage'] as UsageTotals | undefined) ?? null,
    };
  }

  static list(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.slice(0, -6))
      .sort();
  }
}
