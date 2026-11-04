import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runGarden } from '../src/garden/run.js';
import { gitVault } from './helpers/garden.js';

const TODAY = '2026-11-03';
const gitFor = (root: string) => (args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
const FILES = {
  'Projects/old/README.md': '# Old\n\nSome prose.\n',
  'Projects/old/plan.md': '# Plan\n',
  'Projects/b/note.md': '# Note\n',
  'Areas/x/README.md': '---\ntitle: X\n---\n# X\n',
  'Areas/x/link.md': '# Link\n[[Projects/old/plan]]\n',
  'Research/loose.md': '# Loose\n',
};
const touched = (d: string) => (d === 'Projects/old' ? '2026-01-01' : TODAY);

describe('garden run', () => {
  it('shadow run writes only the report', async () => {
    const root = await gitVault(FILES);
    const r = await runGarden(root, { mode: 'shadow', today: TODAY, lastTouched: touched, git: gitFor(root) });
    expect(r.shelves).toBe(3);
    expect(r.created).toBe(0);
    expect(existsSync(join(root, 'Projects/b/README.md'))).toBe(false);
    expect(existsSync(join(root, 'garden/catalog.md'))).toBe(false);
    const report = await readFile(join(root, r.reportPath), 'utf8');
    expect(r.reportPath).toBe(`garden/reports/${TODAY}.md`);
    expect(report).toContain('**Mode:** shadow');
    expect(report).toContain('## Would archive');
    expect(report).toContain('| Projects/old | Archives/2026Q4/projects/old | untouched 306d | pending |');
    expect(report).toContain('- `Research/loose.md`: loose note, file it into a shelf');
    expect(gitFor(root)(['status', '--porcelain']).trim()).toBe('?? garden/');
  });

  it('write run creates shelf notes, wiki blocks and the catalog, moves nothing', async () => {
    const root = await gitVault(FILES);
    const r = await runGarden(root, { mode: 'write', today: TODAY, lastTouched: touched, git: gitFor(root) });
    expect(r.created).toBe(1);
    const b = await readFile(join(root, 'Projects/b/README.md'), 'utf8');
    expect(b.startsWith('---\nshelf: Projects/b\nstatus: active\nproject: none\nkind: project\nlast_reviewed: 2026-11-03\narchive_after: default\npin: false\n---\n# B\n')).toBe(true);
    expect(b).toContain('<!-- shelf:start -->');
    expect(b).toContain('**Newest:** [[note]]');
    const x = await readFile(join(root, 'Areas/x/README.md'), 'utf8');
    expect(x.startsWith('---\ntitle: X\nshelf: Areas/x\n')).toBe(true);
    expect(x).toContain('\n# X\n');
    expect(x).not.toContain('**Siblings:**');
    expect(b).toContain('**Siblings:** `Projects/old`');
    expect(existsSync(join(root, 'Projects/old/plan.md'))).toBe(true);
    const catalog = await readFile(join(root, 'garden/catalog.md'), 'utf8');
    expect(catalog.split('\n').filter((l) => /^\| (Projects|Areas|Research)\//.test(l))).toHaveLength(3);
  });

  it('apply run moves, rewrites links and reports', async () => {
    const root = await gitVault(FILES);
    const r = await runGarden(root, { mode: 'apply', today: TODAY, lastTouched: touched, git: gitFor(root) });
    expect(r.applied?.done).toHaveLength(1);
    expect(existsSync(join(root, 'Archives/2026Q4/projects/old/plan.md'))).toBe(true);
    expect(await readFile(join(root, 'Archives/2026Q4/projects/old/README.md'), 'utf8')).toContain('status: archived');
    expect(await readFile(join(root, 'Areas/x/link.md'), 'utf8')).toContain('[[Archives/2026Q4/projects/old/plan]]');
    const report = await readFile(join(root, r.reportPath), 'utf8');
    expect(report).toContain('## Archived');
    expect(report).toContain('| moved |');
    expect(report).toContain('Links rewritten: 1 in 2 files.');
    const catalog = await readFile(join(root, 'garden/catalog.md'), 'utf8');
    expect(catalog).not.toContain('| Projects/old |');
  });

  it('infers the project from a folder name that is a tracker slug, and archives a parked one', async () => {
    const root = await gitVault({ ...FILES, 'Projects/lifeos/README.md': '# Lifeos\n' });
    const r = await runGarden(root, { mode: 'write', today: TODAY, lastTouched: () => TODAY, trackerStage: (s) => (s === 'lifeos' ? 'parked' : s === 'b' ? 'building' : null), git: gitFor(root) });
    expect(r.actions).toContainEqual({ type: 'archive', from: 'Projects/lifeos', to: 'Archives/2026Q4/projects/lifeos', reason: 'tracker: parked' });
    expect(await readFile(join(root, 'Projects/b/README.md'), 'utf8')).toContain('\nproject: b\n');
    expect(await readFile(join(root, 'Projects/old/README.md'), 'utf8')).toContain('\nproject: none\n');
  });

  it('skips dirty files', async () => {
    const root = await gitVault(FILES);
    await writeFile(join(root, 'Projects/old/plan.md'), '# Plan, edited\n');
    const r = await runGarden(root, { mode: 'apply', today: TODAY, lastTouched: touched, git: gitFor(root) });
    expect(r.dirtySkipped).toBe(1);
    expect(r.applied?.refused[0]?.reason).toBe('uncommitted changes: Projects/old/plan.md');
    expect(existsSync(join(root, 'Projects/old/plan.md'))).toBe(true);
    const report = await readFile(join(root, r.reportPath), 'utf8');
    expect(report).toContain('refused, uncommitted changes: Projects/old/plan.md');
    expect(report).toContain('1 files with uncommitted changes were left alone.');
  });
});
