import { log } from '../logger.js';
import { complete, type ChatProvider } from '../llm/types.js';
import type { Chunk } from './chunk.js';

/**
 * Contextual retrieval (docs/rag.md, section 2): before a chunk is embedded, a
 * model writes one line saying what the chunk is about *in the context of its
 * note*, and that line is embedded and indexed with it. A paragraph that reads
 * "the second option costs more" is unfindable on its own; with "From the
 * note 'Garage heater' comparing a diesel and an electric heater, this
 * paragraph weighs their running cost" in front of it, it is.
 *
 * One call per note, not per chunk: the note is sent once with every chunk's
 * opening listed, and the model answers with one line per chunk as a JSON
 * array. That is 20x fewer calls than one per chunk and the whole note fits
 * any current model's window (notes above 5 MB are never embedded anyway).
 */

export type Contextualizer = (note: { title: string; path: string; body: string }, chunks: readonly Chunk[]) => Promise<string[]>;

/** Notes longer than this are sent truncated; the chunk openings still carry the rest. */
const MAX_NOTE_CHARS = 60_000;
/** How much of each chunk the model sees when it writes the line. */
const OPENING_CHARS = 300;
const MAX_CONTEXT_CHARS = 400;

export function contextPrompt(note: { title: string; path: string; body: string }, chunks: readonly Chunk[]): string {
  const body = note.body.length > MAX_NOTE_CHARS ? `${note.body.slice(0, MAX_NOTE_CHARS)}\n…(truncated)` : note.body;
  const openings = chunks
    .map((c, i) => {
      const text = c.content.includes('\n\n') ? c.content.slice(c.content.indexOf('\n\n') + 2) : c.content;
      return `${i + 1}. [${c.headingPath || 'top'}] ${text.slice(0, OPENING_CHARS).replace(/\s+/g, ' ')}`;
    })
    .join('\n');
  return [
    `Note "${note.title}" (${note.path}):`,
    '<note>',
    body,
    '</note>',
    '',
    `The note is split into ${chunks.length} chunk${chunks.length === 1 ? '' : 's'} for search. Each starts as listed:`,
    openings,
    '',
    'For each chunk, write one short sentence (at most 40 words) that situates it within the note: what the note is about, and what this part covers, naming the people, projects, products or places involved so a search for them finds this chunk. Do not repeat the chunk; add the context it lacks.',
    `Answer with a JSON array of exactly ${chunks.length} strings, in order, and nothing else.`,
  ].join('\n');
}

/** Pulls the first JSON array out of an answer that may be wrapped in fences or prose. */
export function parseContexts(text: string, expected: number): string[] | null {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end <= start) return null;
  try {
    const arr = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
    if (!Array.isArray(arr) || arr.length !== expected) return null;
    return arr.map((s) => (typeof s === 'string' ? s.trim().slice(0, MAX_CONTEXT_CHARS) : ''));
  } catch {
    return null;
  }
}

/**
 * Builds a contextualizer on a chat provider. A failed or malformed answer
 * returns empty contexts for that note and logs once: the note is still
 * embedded, just without the enrichment, and the next re-embed tries again.
 */
export function llmContextualizer(provider: ChatProvider, opts: { signal?: AbortSignal } = {}): Contextualizer {
  return async (note, chunks) => {
    if (chunks.length === 0) return [];
    try {
      const { text } = await complete(provider, {
        system: 'You write search context for passages of personal notes. Be concrete and brief. Output only JSON.',
        messages: [{ role: 'user', content: contextPrompt(note, chunks) }],
        maxTokens: Math.min(16_000, 120 * chunks.length + 200),
        temperature: 0,
        signal: opts.signal,
      });
      const parsed = parseContexts(text, chunks.length);
      if (!parsed) {
        log.warn(`contextualize: unusable answer for ${note.path}; embedding without context`);
        return chunks.map(() => '');
      }
      return parsed;
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      log.warn(`contextualize: ${note.path}: ${(err as Error).message}; embedding without context`);
      return chunks.map(() => '');
    }
  };
}
