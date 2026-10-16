import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyBlock, BLOCK_START, collectNotes, computeRelated, isWritable, runBacklinks, VaultIndex } from '../src/backlinks.js';

async function vault(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sb-backlinks-'));
  for (const [p, c] of Object.entries(files)) {
    await mkdir(dirname(join(root, p)), { recursive: true });
    await writeFile(join(root, p), c);
  }
  return root;
}

const FILES = {
  'Projects/demo/demo-design.md': '# Demo - design\n',
  'Projects/demo/dev-log/README.md': '# Demo dev log\n',
  'Projects/demo/dev-log/2026-10-14_start.md': '# Start\n',
  'Projects/demo/notes/idea.md': '# Idea\nSee `Projects/other/plan.md` and the Brain Map Research Notes doc.\n',
  'Projects/other/plan.md': '# Plan\n',
  'Research/x/brain-map-research.md': '# Brain Map Research Notes\n',
  'Areas/Stand-up/README.md': '# Stand-up\n',
  'Areas/Stand-up/2026.10.13.md': '# 13\n',
  'Areas/Stand-up/2026.10.14.md': '# 14\n',
  'Areas/Stand-up/2026.10.15.md': '# 15\n',
  'Areas/repo/.git/HEAD': 'ref',
  'Areas/repo/README.md': '# Someone else repo\n',
  '.hermes/skill.md': '# hidden\n',
};

describe('backlinks', () => {
  it('skips nested repos and dot-folders', async () => {
    const notes = await collectNotes(await vault(FILES));
    const paths = notes.map((n) => n.path);
    expect(paths).not.toContain('Areas/repo/README.md');
    expect(paths).not.toContain('.hermes/skill.md');
    expect(paths).toContain('Areas/Stand-up/2026.10.14.md');
  });

  it('links design doc, dev log, path and title mentions', async () => {
    const notes = await collectNotes(await vault(FILES));
    const idx = new VaultIndex(notes);
    const links = computeRelated(idx.byPath.get('Projects/demo/notes/idea.md')!, idx);
    expect(links).toEqual([
      { target: 'Projects/demo/demo-design.md', reason: 'design doc' },
      { target: 'Projects/demo/dev-log/README.md', reason: 'dev log' },
      { target: 'Projects/other/plan.md', reason: 'mentioned' },
      { target: 'Research/x/brain-map-research.md', reason: 'mentioned' },
    ]);
  });

  it('chains stand-ups to their neighbours and folder index', async () => {
    const notes = await collectNotes(await vault(FILES));
    const idx = new VaultIndex(notes);
    const links = computeRelated(idx.byPath.get('Areas/Stand-up/2026.10.14.md')!, idx);
    expect(links.map((l) => [l.target, l.reason])).toEqual([
      ['Areas/Stand-up/README.md', 'folder index'],
      ['Areas/Stand-up/2026.10.13.md', 'previous'],
      ['Areas/Stand-up/2026.10.15.md', 'next'],
    ]);
  });

  it('does not relink what the note already links', async () => {
    const notes = await collectNotes(await vault({ ...FILES, 'Projects/demo/notes/idea.md': '# Idea\n[[demo-design]]\n' }));
    const idx = new VaultIndex(notes);
    const links = computeRelated(idx.byPath.get('Projects/demo/notes/idea.md')!, idx);
    expect(links.map((l) => l.target)).not.toContain('Projects/demo/demo-design.md');
  });

  it('never writes dev-log entries, archives or agent files', () => {
    expect(isWritable('Projects/demo/dev-log/2026-10-14_start.md')).toBe(false);
    expect(isWritable('Projects/demo/dev-log/README.md')).toBe(true);
    expect(isWritable('Archives/2026Q3/x.md')).toBe(false);
    expect(isWritable('AGENTS.md')).toBe(false);
    expect(isWritable('projects.md')).toBe(false);
  });

  it('is idempotent and leaves text outside the block alone', async () => {
    const root = await vault(FILES);
    const first = await runBacklinks(root, { write: true });
    expect(first.changed).toBeGreaterThan(0);
    const after = await readFile(join(root, 'Projects/demo/notes/idea.md'), 'utf8');
    expect(after.startsWith('# Idea\nSee `Projects/other/plan.md`')).toBe(true);
    expect(after.split(BLOCK_START).length).toBe(2);
    const second = await runBacklinks(root, { write: true });
    expect(second.changed).toBe(0);
    expect(second.orphansAfter).toBeLessThan(first.orphansBefore);
  });

  it('removes an empty block', async () => {
    const idx = new VaultIndex([]);
    const withBlock = '# A\n\n<!-- related:start -->\n## Related\n- [[x]] - mentioned\n<!-- related:end -->\n';
    expect(applyBlock(withBlock, [], idx)).toBe('# A\n');
  });
});

describe('backlinks targets', () => {
  it('never links agent instruction files', async () => {
    const notes = await collectNotes(await vault({ 'AGENTS.md': '# Agents rules for the vault\n', 'Research/a.md': '# A\nRead `AGENTS.md` first.\n' }));
    const idx = new VaultIndex(notes);
    expect(computeRelated(idx.byPath.get('Research/a.md')!, idx)).toEqual([]);
  });
});
