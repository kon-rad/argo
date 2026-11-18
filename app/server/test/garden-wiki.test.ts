import { describe, expect, it } from 'vitest';
import { collectNotes, VaultIndex } from '../src/backlinks.js';
import { defaultMeta, type Shelf } from '../src/garden/shelves.js';
import { applyShelfBlock, inboundCounts, renderShelfBlock, SHELF_END, SHELF_START, shelfFacts } from '../src/garden/wiki.js';
import { vault } from './helpers/garden.js';

const TODAY = '2026-11-03';
function shelf(dir: string, kind: Shelf['meta']['kind']): Shelf {
  return { dir, readme: `${dir}/README.md`, exists: true, meta: { ...defaultMeta(dir, kind, TODAY), project: 'argo-exo' }, body: '', foreign: {} };
}

describe('garden wiki', () => {
  it('applyShelfBlock replaces an existing block and leaves prose, appends when absent', () => {
    const block = `${SHELF_START}\nnew\n${SHELF_END}`;
    const had = `# Title\n\nProse.\n\n${SHELF_START}\nold\n${SHELF_END}\n`;
    expect(applyShelfBlock(had, block)).toBe(`# Title\n\nProse.\n\n${block}\n`);
    expect(applyShelfBlock('# Title\nProse.\n', block)).toBe(`# Title\nProse.\n\n${block}\n`);
    expect(applyShelfBlock('', block)).toBe(`\n\n${block}\n`);
  });

  it('shelfFacts and renderShelfBlock', async () => {
    const root = await vault({
      'Projects/demo/README.md': '# Demo\n',
      'Projects/demo/demo-design.md': '# Demo design\n',
      'Projects/demo/notes/a.md': '# A\nSee [[b]] and [[b]] again.\n',
      'Projects/demo/notes/b.md': '# B\n',
      'Projects/demo/notes/c.md': '# C\n[[b]]\n',
      'Projects/demo/CLAUDE.md': '# rules\n',
      'Projects/other/README.md': '# Other\n',
      'Projects/old/README.md': '# Old\n',
      'Areas/x/README.md': '# X\n',
    });
    const notes = await collectNotes(root);
    const index = new VaultIndex(notes);
    const inbound = inboundCounts(notes, index);
    expect(inbound.get('Projects/demo/notes/b.md')).toBe(3);
    const shelves = [shelf('Projects/demo', 'project'), shelf('Projects/other', 'project'), { ...shelf('Projects/old', 'project'), meta: { ...defaultMeta('Projects/old', 'project', TODAY), status: 'archived' as const } }, shelf('Areas/x', 'area')];
    const mt: Record<string, number> = { 'Projects/demo/notes/c.md': 3, 'Projects/demo/notes/b.md': 2, 'Projects/demo/notes/a.md': 1, 'Projects/demo/demo-design.md': 0 };
    const facts = shelfFacts(shelves[0]!, shelves, notes, inbound, (p) => mt[p] ?? 0, 'Ship it');
    expect(facts.designDoc?.path).toBe('Projects/demo/demo-design.md');
    expect(facts.newest.map((n) => n.path)).toEqual(['Projects/demo/notes/c.md', 'Projects/demo/notes/b.md', 'Projects/demo/notes/a.md', 'Projects/demo/demo-design.md']);
    expect(facts.mostLinked).toHaveLength(1);
    expect(facts.siblings).toEqual(['Projects/other']);
    const block = renderShelfBlock(shelves[0]!, facts, index);
    expect(block.startsWith(SHELF_START)).toBe(true);
    expect(block).toContain('**Status:** active · **Project:** argo-exo · **Kind:** project · **Reviewed:** 2026-11-03');
    expect(block).toContain('**Design:** [[demo-design]]');
    expect(block).toContain('**Next action:** Ship it');
    expect(block).toContain('**Newest:** [[c]] · [[b]] · [[a]] · [[demo-design]]');
    expect(block).toContain('**Most linked:** [[b]] (3)');
    expect(block).toContain('**Siblings:** `Projects/other`');
    expect(block.endsWith(SHELF_END)).toBe(true);
  });
});
