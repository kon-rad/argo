import { describe, expect, it } from 'vitest';
import { defaultMeta, discoverShelves, kindForRoot, serializeShelf } from '../src/garden/shelves.js';
import { vault } from './helpers/garden.js';

const ROOTS = ['Projects', 'Areas', 'Research'];
const TODAY = '2026-11-03';

describe('garden shelves', () => {
  it('finds one shelf per top folder and skips nested repos and dot folders', async () => {
    const root = await vault({
      'Projects/a/README.md': '# A\n',
      'Projects/b/note.md': '# note\n',
      'Areas/repo/.git/HEAD': 'ref',
      'Areas/repo/README.md': '# repo\n',
      '.hermes/x.md': '# hidden\n',
      'Research/ai/paper.md': '# paper\n',
      'Research/loose.md': '# loose\n',
    });
    const shelves = await discoverShelves(root, ROOTS, 'README.md', TODAY);
    expect(shelves.map((s) => s.dir)).toEqual(['Projects/a', 'Projects/b', 'Research/ai']);
    const b = shelves.find((s) => s.dir === 'Projects/b')!;
    expect(b.exists).toBe(false);
    expect(b.body).toBe('# B\n');
    expect(b.meta).toEqual(defaultMeta('Projects/b', 'project', TODAY));
    expect(shelves.find((s) => s.dir === 'Research/ai')!.meta.kind).toBe('resource');
  });

  it('keeps foreign frontmatter and body', async () => {
    const root = await vault({ 'Projects/a/README.md': '---\ntitle: X\ntags: [a, b]\n---\n# Hello\n\nProse here.\n' });
    const [s] = await discoverShelves(root, ROOTS, 'README.md', TODAY);
    const out = serializeShelf(s!);
    expect(out.startsWith('---\ntitle: X\ntags: [a, b]\n')).toBe(true);
    expect(out).toContain('\nstatus: active\n');
    expect(out).toContain('\nkind: project\n');
    expect(out).toContain('\narchive_after: 90d\n');
    expect(out).toContain('\npin: false\n');
    expect(out.endsWith('---\n# Hello\n\nProse here.\n')).toBe(true);
  });

  it('respects existing shelf keys', async () => {
    const root = await vault({ 'Areas/x/README.md': '---\nstatus: archived\npin: true\nproject: argo-exo\n---\n# X\n' });
    const [s] = await discoverShelves(root, ROOTS, 'README.md', TODAY);
    expect(s!.meta.status).toBe('archived');
    expect(s!.meta.pin).toBe(true);
    expect(s!.meta.project).toBe('argo-exo');
    expect(s!.meta.archive_after).toBe('never');
    expect(s!.meta.kind).toBe('area');
  });

  it('kindForRoot and default titles', () => {
    expect(kindForRoot('Projects')).toBe('project');
    expect(kindForRoot('Areas')).toBe('area');
    expect(kindForRoot('Anything')).toBe('resource');
    expect(defaultMeta('Areas/dj-mixing', 'area', TODAY)).toEqual({
      shelf: 'Areas/dj-mixing', status: 'active', project: 'none', kind: 'area', last_reviewed: TODAY, archive_after: 'never', pin: false,
    });
  });
});
