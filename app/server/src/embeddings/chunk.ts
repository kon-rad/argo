export interface Chunk {
  chunkIndex: number;
  /** "Section > Subsection" at the point the chunk starts; '' at top level. */
  headingPath: string;
  /** Exactly what gets embedded — context prefix included. */
  content: string;
  tokenEstimate: number;
  charStart: number;
  charEnd: number;
}

export interface ChunkOptions {
  maxTokens: number;
  overlapTokens: number;
}

/**
 * Chars-per-token. Deliberately a heuristic — a real tokenizer would pin this
 * file to one model's vocabulary — but calibrated against this vault rather
 * than guessed.
 *
 * The textbook figure for English prose is 4. That is wrong here and it cost a
 * failed production run: these notes are dense with markdown tables, URLs and
 * model identifiers, which tokenize at 2.2–2.8 chars/token. A 1765-character
 * chunk came out at 794 tokens against a 512-token encoder.
 *
 * 2.5 covers the observed worst case. It is still only an estimate, so the
 * pipeline verifies rather than trusts it: embedChunks() splits and retries
 * anything the encoder rejects for length. This number decides how often that
 * costs an extra round trip, not whether the run succeeds.
 */
const CHARS_PER_TOKEN = 2.5;

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

interface Block {
  text: string;
  start: number;
  end: number;
  headingPath: string;
  /** The opening fence line when this block is a code block, else null. */
  fence: string | null;
}

const ATX_HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

/**
 * Splits the body into paragraph-sized blocks, carrying the heading breadcrumb
 * that is in scope at each one. A fenced code block is one indivisible block
 * however long it is: half a code fence embeds as noise and renders as garbage.
 */
function toBlocks(body: string): Block[] {
  const lines = body.split('\n');
  const blocks: Block[] = [];
  const stack: { level: number; text: string }[] = [];

  let offset = 0;
  let buf: string[] = [];
  let bufStart = 0;
  let fence: string | null = null;
  let fenceOpener: string | null = null;

  const headingPath = (): string => stack.map((h) => h.text).join(' > ');

  const flush = (end: number): void => {
    const text = buf.join('\n').trim();
    if (text.length > 0) {
      blocks.push({ text, start: bufStart, end, headingPath: headingPath(), fence: fenceOpener });
    }
    buf = [];
    fenceOpener = null;
  };

  for (const line of lines) {
    const lineStart = offset;
    offset += line.length + 1;

    const fenceMatch = /^\s*(```|~~~)/.exec(line);
    if (fence !== null) {
      buf.push(line);
      if (fenceMatch && line.trim().startsWith(fence)) {
        fence = null;
        flush(offset - 1);
      }
      continue;
    }
    if (fenceMatch) {
      flush(lineStart);
      bufStart = lineStart;
      buf = [line];
      fence = fenceMatch[1]!;
      fenceOpener = line.trim();
      continue;
    }

    const heading = ATX_HEADING.exec(line);
    if (heading) {
      flush(lineStart);
      const level = heading[1]!.length;
      const text = heading[2]!.trim();
      while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
      // An H1 is almost always the note's own title, which the prefix already
      // carries; repeating it in every breadcrumb wastes the context window.
      if (level > 1 && text.length > 0) stack.push({ level, text });
      bufStart = offset;
      continue;
    }

    if (line.trim() === '') {
      flush(lineStart);
      bufStart = offset;
      continue;
    }

    if (buf.length === 0) bufStart = lineStart;
    buf.push(line);
  }
  flush(offset);

  return blocks;
}

/**
 * Splits a code block that alone exceeds the window, re-opening and re-closing
 * the fence around every piece. Splitting on a line boundary and leaving the
 * halves unfenced would embed — and later render — broken markdown.
 */
function splitFenced(block: Block, maxChars: number): Block[] {
  const opener = block.fence!;
  const closer = opener.slice(0, 3);
  const lines = block.text.split('\n');
  const body = lines.slice(1, lines[lines.length - 1]!.trim().startsWith(closer) ? -1 : undefined);
  const budget = Math.max(1, maxChars - opener.length - closer.length - 2);

  const pieces: Block[] = [];
  let buf: string[] = [];
  let size = 0;
  const flush = (): void => {
    if (buf.length === 0) return;
    pieces.push({
      text: [opener, ...buf, closer].join('\n'),
      start: block.start,
      end: block.end,
      headingPath: block.headingPath,
      fence: opener,
    });
    buf = [];
    size = 0;
  };
  for (const line of body) {
    if (size + line.length > budget && buf.length > 0) flush();
    buf.push(line);
    size += line.length + 1;
  }
  flush();
  return pieces;
}

/**
 * Splits an over-long single block on sentence boundaries, then hard-wraps.
 *
 * Consecutive pieces overlap by `overlapChars`. A paragraph long enough to
 * need splitting is precisely the case where the packing loop has no budget
 * left to carry overlap itself, so if the overlap is not applied here it does
 * not happen at all — and a sentence landing on the cut is then retrievable
 * from neither piece.
 */
function splitOversized(block: Block, maxChars: number, overlapChars = 0): Block[] {
  if (block.text.length <= maxChars) return [block];
  if (block.fence !== null) return splitFenced(block, maxChars);

  // Always make progress, however the boundary search turns out.
  const overlap = Math.min(overlapChars, Math.floor(maxChars / 2));

  const pieces: Block[] = [];
  let cursor = 0;
  while (cursor < block.text.length) {
    let end = Math.min(cursor + maxChars, block.text.length);
    if (end < block.text.length) {
      const window = block.text.slice(cursor, end);
      const boundary = Math.max(
        window.lastIndexOf('. '),
        window.lastIndexOf('\n'),
        window.lastIndexOf('! '),
        window.lastIndexOf('? '),
      );
      // Only honour a boundary in the last third; otherwise a stray period
      // near the start would produce a chunk of a dozen characters.
      if (boundary > maxChars * 0.6) end = cursor + boundary + 1;
    }
    pieces.push({
      text: block.text.slice(cursor, end).trim(),
      start: block.start + cursor,
      end: block.start + end,
      headingPath: block.headingPath,
      fence: null,
    });
    if (end >= block.text.length) break;
    cursor = Math.max(cursor + 1, end - overlap);
  }
  return pieces.filter((p) => p.text.length > 0);
}

/**
 * Packs blocks into chunks under `maxTokens`, restarting whenever the heading
 * breadcrumb changes so a chunk never straddles two sections. Consecutive
 * chunks within one section overlap by roughly `overlapTokens` so a fact that
 * lands on a seam stays retrievable from both sides.
 *
 * Every chunk is prefixed `Title > Heading > Subheading` on its own line. The
 * prefix is embedded, not just stored: a paragraph reading "it costs 400 MYR"
 * is meaningless as a vector until the surrounding note says what "it" is.
 */
export function chunkMarkdown(body: string, title: string, opts: ChunkOptions): Chunk[] {
  const maxChars = Math.round(opts.maxTokens * CHARS_PER_TOKEN);
  const overlapChars = Math.min(
    Math.round(opts.overlapTokens * CHARS_PER_TOKEN),
    Math.floor(maxChars / 2),
  );

  const prefixFor = (headingPath: string): string =>
    [title, headingPath].filter((t) => t.length > 0).join(' > ');

  // The prefix is part of what gets embedded, so it is part of the budget.
  // Reserving the worst case up front is what keeps every emitted chunk under
  // maxChars — measuring only the blocks let 28% of chunks overrun the
  // encoder window on the real vault.
  const worstPrefix = Math.max(
    ...toBlocks(body).map((b) => prefixFor(b.headingPath).length + 2),
    title.length + 2,
  );
  const blockBudget = Math.max(120, maxChars - worstPrefix);

  const blocks = toBlocks(body).flatMap((b) => splitOversized(b, blockBudget, overlapChars));
  if (blocks.length === 0) return [];

  const chunks: Chunk[] = [];
  let pending: Block[] = [];
  let pendingChars = 0;

  const emit = (): void => {
    if (pending.length === 0) return;
    const headingPath = pending[0]!.headingPath;
    const content = `${prefixFor(headingPath)}\n\n${pending.map((b) => b.text).join('\n\n')}`;
    chunks.push({
      chunkIndex: chunks.length,
      headingPath,
      content,
      tokenEstimate: estimateTokens(content),
      charStart: pending[0]!.start,
      charEnd: pending[pending.length - 1]!.end,
    });
  };

  for (const block of blocks) {
    const sectionChanged = pending.length > 0 && pending[0]!.headingPath !== block.headingPath;
    const joinCost = pending.length > 0 ? 2 : 0;
    const wouldOverflow = pendingChars + joinCost + block.text.length > blockBudget;

    if (pending.length > 0 && (sectionChanged || wouldOverflow)) {
      emit();

      if (sectionChanged) {
        pending = [];
        pendingChars = 0;
      } else {
        // Carry the tail forward, but only as much as still leaves room for
        // the block that triggered the overflow. Overlap that pushes the next
        // chunk back over the limit is worse than no overlap at all.
        const room = Math.min(overlapChars, blockBudget - block.text.length - 2);
        const carried: Block[] = [];
        let carriedChars = 0;
        if (room > 0) {
          for (let i = pending.length - 1; i >= 0; i--) {
            const b = pending[i]!;
            // Overlap exists so a sentence on a seam stays retrievable.
            // Carrying a code block forward duplicates it into two vectors
            // instead, which is cost without recall.
            if (b.fence !== null) break;
            if (carriedChars + b.text.length + 2 > room) break;
            carried.unshift(b);
            carriedChars += b.text.length + 2;
          }
        }
        pending = carried;
        pendingChars = carriedChars;
      }
    }

    pending.push(block);
    pendingChars += block.text.length + (pendingChars > 0 ? 2 : 0);
  }
  emit();

  return chunks;
}
