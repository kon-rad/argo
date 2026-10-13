import { describe, expect, it } from 'vitest';
import { chunkMarkdown, estimateTokens } from '../src/embeddings/chunk.js';

const opts = { maxTokens: 100, overlapTokens: 20 };

describe('estimateTokens', () => {
  it('scales with length and never returns zero for non-empty text', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('x'.repeat(400))).toBeGreaterThan(80);
  });
});

describe('chunkMarkdown', () => {
  it('returns nothing for a body with no prose', () => {
    expect(chunkMarkdown('', 'Title', opts)).toEqual([]);
    expect(chunkMarkdown('   \n\n  \n', 'Title', opts)).toEqual([]);
  });

  it('keeps a short note as a single chunk', () => {
    const chunks = chunkMarkdown('Just a couple of sentences about foxes.', 'Foxes', opts);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.chunkIndex).toBe(0);
    expect(chunks[0]!.content).toContain('foxes');
  });

  it('prefixes every chunk with the title and heading breadcrumb', () => {
    const md = '# Ignored H1\n\n## Setup\n\nInstall the thing.\n\n### Details\n\nMore words here.\n';
    const chunks = chunkMarkdown(md, 'My Note', opts);
    const setup = chunks.find((c) => c.content.includes('Install the thing'))!;
    const details = chunks.find((c) => c.content.includes('More words here'))!;
    expect(setup.headingPath).toBe('Setup');
    expect(setup.content.startsWith('My Note > Setup')).toBe(true);
    expect(details.headingPath).toBe('Setup > Details');
  });

  it('pops the breadcrumb stack when a heading level goes back up', () => {
    const md = '## A\n\ntext a\n\n### A1\n\ntext a1\n\n## B\n\ntext b\n';
    const chunks = chunkMarkdown(md, 'T', opts);
    expect(chunks.find((c) => c.content.includes('text b'))!.headingPath).toBe('B');
  });

  it('splits a long section into overlapping chunks', () => {
    const para = 'word '.repeat(80).trim();
    const md = `## Long\n\n${para}\n\n${para}\n\n${para}\n`;
    const chunks = chunkMarkdown(md, 'T', opts);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
    // Consecutive chunks in one section must share text, or a fact split
    // across the seam is retrievable from neither half.
    const a = chunks[0]!.content;
    const b = chunks[1]!.content;
    expect(b.slice(b.indexOf('\n\n') + 2).length).toBeGreaterThan(0);
    expect(chunks[1]!.charStart).toBeLessThan(chunks[0]!.charEnd);
  });

  it('keeps a code fence that fits in one piece', () => {
    const fence = '```js\nconst x = 1;\nconst y = 2;\n```';
    const md = `## Code\n\nBefore.\n\n${fence}\n\nAfter.\n`;
    const chunks = chunkMarkdown(md, 'T', opts);
    expect(chunks.filter((c) => c.content.includes('```js'))).toHaveLength(1);
  });

  it('re-fences each piece when a code block alone exceeds the window', () => {
    const fence = '```js\n' + 'const x = 1;\n'.repeat(60) + '```';
    const md = `## Code\n\nBefore.\n\n${fence}\n\nAfter.\n`;
    const chunks = chunkMarkdown(md, 'T', opts);
    // It had to be split, but no chunk is left holding half a fence.
    expect(chunks.filter((c) => c.content.includes('const x = 1;')).length).toBeGreaterThan(1);
    for (const c of chunks) {
      const fences = (c.content.match(/^```/gm) ?? []).length;
      expect(fences % 2).toBe(0);
    }
  });

  it('never carries a code fence forward as overlap', () => {
    const fence = '```js\nconst x = 1;\n```';
    const long = 'word '.repeat(90).trim();
    const md = `## Code\n\n${fence}\n\n${long}\n\n${long}\n`;
    const chunks = chunkMarkdown(md, 'T', opts);
    expect(chunks.filter((c) => c.content.includes('```js'))).toHaveLength(1);
  });

  it('reports char offsets that index back into the original body', () => {
    const md = '## S\n\nThe quick brown fox jumps.\n';
    const [chunk] = chunkMarkdown(md, 'T', opts);
    expect(md.slice(chunk!.charStart, chunk!.charEnd)).toContain('quick brown fox');
  });

  it('emits an oversized single paragraph rather than dropping it', () => {
    const giant = 'z'.repeat(4000);
    const chunks = chunkMarkdown(giant, 'T', opts);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.map((c) => c.content).join('')).toContain('zzzz');
  });

  it('is deterministic', () => {
    const md = '## A\n\n' + 'alpha beta '.repeat(200);
    expect(chunkMarkdown(md, 'T', opts)).toEqual(chunkMarkdown(md, 'T', opts));
  });
});

describe('budget enforcement', () => {
  const BUDGETS = [
    { maxTokens: 100, overlapTokens: 20 },
    { maxTokens: 450, overlapTokens: 60 },
    { maxTokens: 400, overlapTokens: 60 },
  ];

  // 2.5 is CHARS_PER_TOKEN in the implementation; the contract is that the
  // emitted content — prefix and overlap included — fits the stated budget.
  const charBudget = (o: { maxTokens: number }) => Math.round(o.maxTokens * 2.5);

  const CORPUS: [string, string][] = [
    ['Prose', 'The quick brown fox jumps over the lazy dog. '.repeat(120)],
    ['Headed', Array.from({ length: 12 }, (_, i) => `## Section ${i}\n\n${'words '.repeat(90)}`).join('\n\n')],
    ['Deep', '## A very long section heading indeed\n\n### And a nested one that is also long\n\n' + 'text '.repeat(200)],
    ['Table', '## Data\n\n' + '| a | b | c |\n|---|---|---|\n'.repeat(60)],
    ['Mixed', '## Code\n\n```js\nconst x = 1;\n```\n\n' + 'prose '.repeat(150) + '\n\n## Next\n\n' + 'more '.repeat(150)],
  ];

  for (const opts of BUDGETS) {
    for (const [name, body] of CORPUS) {
      it(`keeps every ${name} chunk within ${opts.maxTokens} tokens`, () => {
        const chunks = chunkMarkdown(body, 'A Note With A Fairly Long Title', opts);
        expect(chunks.length).toBeGreaterThan(0);
        for (const c of chunks) {
          expect(c.content.length).toBeLessThanOrEqual(charBudget(opts));
        }
      });
    }
  }

  it('still covers the whole body despite the tighter budget', () => {
    const body = Array.from({ length: 8 }, (_, i) => `## S${i}\n\nunique-marker-${i} ${'pad '.repeat(60)}`).join('\n\n');
    const joined = chunkMarkdown(body, 'T', { maxTokens: 100, overlapTokens: 20 })
      .map((c) => c.content)
      .join('\n');
    for (let i = 0; i < 8; i++) expect(joined).toContain(`unique-marker-${i}`);
  });
});
