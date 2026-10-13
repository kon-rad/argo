import { describe, it, expect } from 'vitest';
import { parseMarkdown } from '../src/connectors/vault/parse.js';

describe('parseMarkdown', () => {
  it('reads frontmatter and prefers its title', () => {
    const p = parseMarkdown('---\ntitle: Real Title\ntags: [alpha, beta]\n---\n# Ignored\n', 'file');
    expect(p.title).toBe('Real Title');
    expect(p.tags.sort()).toEqual(['alpha', 'beta']);
    expect(p.frontmatter).toMatchObject({ title: 'Real Title' });
    expect(p.body.startsWith('# Ignored')).toBe(true);
  });

  it('falls back to the first H1, then to the filename', () => {
    expect(parseMarkdown('# From Heading\n\nbody', 'file').title).toBe('From Heading');
    expect(parseMarkdown('no heading here\n', 'file').title).toBe('file');
  });

  it('extracts wikilinks with aliases and strips headings and block refs', () => {
    const p = parseMarkdown('See [[Target]] and [[Other|nice name]] and [[Note#Section]] and [[N^b1]].', 'f');
    expect(p.links).toEqual([
      { targetRaw: 'Target', alias: null },
      { targetRaw: 'Other', alias: 'nice name' },
      { targetRaw: 'Note', alias: null },
      { targetRaw: 'N', alias: null },
    ]);
  });

  it('drops the table escape from an aliased wikilink target', () => {
    const p = parseMarkdown('| a | b |\n|---|---|\n| [[Projects/x/README\\|dev log]] | y |\n', 'f');
    expect(p.links).toEqual([{ targetRaw: 'Projects/x/README', alias: 'dev log' }]);
  });

  it('IGNORES wikilinks and tags inside fenced code', () => {
    const p = parseMarkdown('```\n[[not-a-link]] #not-a-tag\n```\n\nreal [[link]] #real\n', 'f');
    expect(p.links).toEqual([{ targetRaw: 'link', alias: null }]);
    expect(p.tags).toEqual(['real']);
  });

  it('IGNORES wikilinks inside inline code', () => {
    expect(parseMarkdown('use `[[wikilinks]]` here', 'f').links).toEqual([]);
  });

  it('handles tilde fences and nested backtick fences', () => {
    const p = parseMarkdown('~~~js\n[[nope]]\n~~~\n[[yes]]', 'f');
    expect(p.links).toEqual([{ targetRaw: 'yes', alias: null }]);
  });

  it('does not mistake markdown headings or bare numbers for tags', () => {
    const p = parseMarkdown('### Heading\n# Title\n#123\n#good-tag\nnested #a/b here\n', 'f');
    expect(p.tags.sort()).toEqual(['a/b', 'good-tag']);
  });

  it('does not treat a URL fragment as a tag', () => {
    expect(parseMarkdown('see http://x.com/p#frag now', 'f').tags).toEqual([]);
  });

  it('treats embeds as links', () => {
    expect(parseMarkdown('![[diagram.png]]', 'f').links)
      .toEqual([{ targetRaw: 'diagram.png', alias: null }]);
  });

  it('merges frontmatter tags given as a comma-separated string', () => {
    expect(parseMarkdown('---\ntags: alpha, beta\n---\n#gamma', 'f').tags.sort())
      .toEqual(['alpha', 'beta', 'gamma']);
  });

  it('deduplicates repeated tags and links', () => {
    const p = parseMarkdown('#dup #dup [[A]] [[A]]', 'f');
    expect(p.tags).toEqual(['dup']);
    expect(p.links).toHaveLength(1);
  });

  it('survives malformed frontmatter without throwing', () => {
    const p = parseMarkdown('---\n: : bad yaml : :\n---\nbody text', 'fallback');
    expect(p.title).toBe('fallback');
    expect(p.body).toContain('body text');
  });
});
