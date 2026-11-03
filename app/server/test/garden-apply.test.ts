import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyActions, rewriteLinks } from '../src/garden/apply.js';
import { gitVault } from './helpers/garden.js';

const gitFor = (root: string) => (args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });

const FILES = {
  'Projects/foo/README.md': '---\nshelf: Projects/foo\nstatus: active\n---\n# Foo\n',
  'Projects/foo/bar.md': '# Bar\n',
  'Areas/x/note.md': '# Note\nSee [[Projects/foo/bar]], [[Projects/foo/bar|the bar]], [bar](Projects/foo/bar.md), `Projects/foo/bar.md` and [[bar]].\n',
  'Projects/keep/README.md': '# Keep\n',
};

describe('garden apply', () => {
  it('rewriteLinks rewrites path links, leaves stem links', () => {
    const r = rewriteLinks(FILES['Areas/x/note.md'], 'Projects/foo', 'Archives/2026Q4/projects/foo');
    expect(r.count).toBe(4);
    expect(r.content).toContain('[[Archives/2026Q4/projects/foo/bar]]');
    expect(r.content).toContain('[[Archives/2026Q4/projects/foo/bar|the bar]]');
    expect(r.content).toContain('[bar](Archives/2026Q4/projects/foo/bar.md)');
    expect(r.content).toContain('`Archives/2026Q4/projects/foo/bar.md`');
    expect(r.content).toContain('[[bar]].');
    expect(rewriteLinks('[[Projects/foobar/x]]', 'Projects/foo', 'Z').count).toBe(0);
  });

  it('moves a project to the archive, rewrites links, sets status archived', async () => {
    const root = await gitVault(FILES);
    const r = await applyActions(root, [{ type: 'archive', from: 'Projects/foo', to: 'Archives/2026Q4/projects/foo', reason: 'test' }], { git: gitFor(root), dirty: new Set(), today: '2026-11-03' });
    expect(r.done).toHaveLength(1);
    expect(r.refused).toEqual([]);
    expect(r.linksRewritten).toBe(4);
    expect(existsSync(join(root, 'Archives/2026Q4/projects/foo/bar.md'))).toBe(true);
    expect(existsSync(join(root, 'Projects/foo'))).toBe(false);
    expect(await readFile(join(root, 'Archives/2026Q4/projects/foo/README.md'), 'utf8')).toContain('status: archived');
    expect(await readFile(join(root, 'Areas/x/note.md'), 'utf8')).toContain('[[Archives/2026Q4/projects/foo/bar]]');
    expect(r.filesTouched).toEqual(['Archives/2026Q4/projects/foo/README.md', 'Areas/x/note.md']);
    const status = gitFor(root)(['status', '--porcelain']);
    expect(status).toContain('R  Projects/foo/bar.md -> Archives/2026Q4/projects/foo/bar.md');
  });

  it('refuses a move onto an existing target and a missing source, keeps going', async () => {
    const root = await gitVault({ ...FILES, 'Archives/2026Q4/projects/foo/README.md': '# already\n' });
    const r = await applyActions(root, [
      { type: 'archive', from: 'Projects/foo', to: 'Archives/2026Q4/projects/foo', reason: 'test' },
      { type: 'archive', from: 'Projects/gone', to: 'Archives/2026Q4/projects/gone', reason: 'test' },
      { type: 'rename', from: 'Projects/keep', to: 'Projects/kept', reason: 'test' },
    ], { git: gitFor(root), dirty: new Set(), today: '2026-11-03' });
    expect(r.refused.map((x) => x.reason)).toEqual(['target exists', 'source missing']);
    expect(r.done).toHaveLength(1);
    expect(existsSync(join(root, 'Projects/kept/README.md'))).toBe(true);
  });

  it('refuses when a file under the source is dirty', async () => {
    const root = await gitVault(FILES);
    await writeFile(join(root, 'Projects/foo/bar.md'), '# Bar edited\n');
    const r = await applyActions(root, [{ type: 'archive', from: 'Projects/foo', to: 'Archives/2026Q4/projects/foo', reason: 'test' }], { git: gitFor(root), dirty: new Set(['Projects/foo/bar.md']), today: '2026-11-03' });
    expect(r.done).toEqual([]);
    expect(r.refused[0]!.reason).toBe('uncommitted changes: Projects/foo/bar.md');
    expect(existsSync(join(root, 'Projects/foo/bar.md'))).toBe(true);
  });
});
