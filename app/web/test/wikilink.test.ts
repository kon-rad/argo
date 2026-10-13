import { describe, it, expect } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import { remarkWikilink, splitWikilinks } from '../src/lib/wikilink.js';

const run = (md: string): string =>
  unified().use(remarkParse).use(remarkWikilink).use(remarkStringify).processSync(md).toString();

describe('remarkWikilink', () => {
  it('turns a wikilink into a link node', () => {
    expect(run('see [[Target]]')).toContain('wikilink:Target');
  });

  it('uses the alias as the link text', () => {
    expect(run('[[Target|nice]]')).toContain('[nice](wikilink:Target)');
  });

  it('uses the target as the text when there is no alias', () => {
    expect(run('[[Target]]')).toContain('[Target](wikilink:Target)');
  });

  it('leaves wikilinks inside inline code alone', () => {
    expect(run('`[[Target]]`')).not.toContain('wikilink:');
  });

  it('leaves wikilinks inside a fenced block alone', () => {
    expect(run('```\n[[Target]]\n```\n')).not.toContain('wikilink:');
  });

  it('handles several links in one paragraph', () => {
    const out = run('[[a]] then [[b|bee]] then [[c]]');
    expect(out).toContain('wikilink:a');
    expect(out).toContain('[bee](wikilink:b)');
    expect(out).toContain('wikilink:c');
  });

  it('strips a heading anchor and a block ref from the target', () => {
    // The scanner stores `spec` for `[[spec#Section]]`, so the plugin has to
    // agree or every anchored link renders as unresolved.
    expect(run('[[spec#Section|see]]')).toContain('[see](wikilink:spec)');
    expect(run('[[spec^block]]')).toContain('wikilink:spec');
  });

  it('renders an embed as a link, not a broken image', () => {
    expect(run('![[diagram.png]]')).toContain('wikilink:diagram.png');
  });

  it('leaves an ordinary markdown link untouched', () => {
    expect(run('[real](https://example.com)')).toContain('[real](https://example.com)');
  });
});

describe('splitWikilinks', () => {
  it('returns the original string as one text run when there is no link', () => {
    expect(splitWikilinks('plain text')).toEqual([{ type: 'text', value: 'plain text' }]);
  });

  it('keeps the text either side of a link', () => {
    expect(splitWikilinks('a [[b]] c')).toEqual([
      { type: 'text', value: 'a ' },
      { type: 'wikilink', target: 'b', label: 'b' },
      { type: 'text', value: ' c' },
    ]);
  });

  it('ignores an unterminated bracket pair', () => {
    expect(splitWikilinks('[[unclosed')).toEqual([{ type: 'text', value: '[[unclosed' }]);
  });

  it('ignores an empty target', () => {
    expect(splitWikilinks('[[]]')).toEqual([{ type: 'text', value: '[[]]' }]);
  });
});
