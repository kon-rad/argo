import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { buildCatalog, publicCandidate, type RootSpec } from '../src/addons/skills/catalog.js';
import { pathState, rootGit } from '../src/addons/skills/git.js';
import { SETTINGS, sh, skillMd, skillsFixture, write } from './helpers/skills.js';
import { SkillsService } from '../src/addons/skills/service.js';

afterEach(() => vi.unstubAllEnvs());
const privateRoot = (vault: string): RootSpec => ({ id: 'private', source: 'private', label: '.agents/skills', path: join(vault, '.agents/skills'), layout: 'flat' });
it('accounts for an ignored helper in the digest and public provenance', async () => {
  const f = skillsFixture(), dir = join(f.vault, '.agents/skills/report');
  write(join(f.vault, '.gitignore'), '/.agents/skills/report/helper.py\n');
  sh(f.vault, 'add', '.gitignore'); sh(f.vault, 'commit', '-qm', 'Ignore local helper');
  const catalog = () => buildCatalog([privateRoot(f.vault)]), before = (await catalog()).byName.get('report')![0]!;
  expect(before).toMatchObject({ dirty: false, tracked: true, valid: true });
  write(join(dir, 'helper.py'), 'print("unreviewed first version")\n');
  expect(sh(f.vault, 'status', '--porcelain=v1', '--', dir)).toBe('');
  const first = (await catalog()).byName.get('report')![0]!;
  expect(first.digest).not.toBe(before.digest); expect(first.packageFiles.map(file => file.path)).toEqual(['SKILL.md', 'helper.py']);
  expect(publicCandidate(first)).toMatchObject({ dirty: true, tracked: false, valid: true });
  expect(first.warnings.join(' ')).toMatch(/Untracked package members.*helper.py/); expect(first.revision).toBe(before.revision);
  const g = await rootGit(realpathSync(join(f.vault, '.agents/skills')));
  expect(pathState(g!, realpathSync(dir), first.packageFiles).untracked).toEqual(['helper.py']);
  write(join(dir, 'helper.py'), 'print("unreviewed second version")\n');
  const changed = (await catalog()).byName.get('report')![0]!;
  expect(changed.digest).not.toBe(first.digest); expect(changed).toMatchObject({ dirty: true, tracked: false });
  const service = new SkillsService(f.vault, SETTINGS, { engineSkills: f.engine, db: false });
  const row = (await service.library()).skills.find(skill => skill.name === 'report')!;
  expect(row.flags.dirty).toBe(true); expect(row.effective).toMatchObject({ dirty: true, tracked: false, digest: changed.digest });
  sh(f.vault, 'add', '-f', '.agents/skills/report/helper.py'); sh(f.vault, 'commit', '-qm', 'Track reviewed helper');
  const committed = (await catalog()).byName.get('report')![0]!;
  expect(committed).toMatchObject({ dirty: false, tracked: true, digest: changed.digest });
  expect(committed.warnings.some(warning => warning.includes('Untracked package members'))).toBe(false);
});
it('marks an ordinary untracked member incomplete despite tracked SKILL.md', async () => {
  const f = skillsFixture(); write(join(f.vault, '.agents/skills/report/notes.md'), 'Untracked context');
  const candidate = (await buildCatalog([privateRoot(f.vault)])).byName.get('report')![0]!;
  expect(candidate).toMatchObject({ dirty: true, tracked: false }); expect(candidate.warnings.join(' ')).toContain('notes.md');
});
it('does not claim clean when Git membership evidence fails', async () => {
  const f = skillsFixture(), realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), shim = join(f.base, 'git-shim');
  write(join(shim, 'git'), `#!/bin/sh\nfor arg in "$@"; do\nif [ "$arg" = "ls-files" ]; then exit 73; fi\ndone\nexec '${realGit.replace(/'/g, `'\\''`)}' "$@"\n`, 0o755);
  vi.stubEnv('PATH', `${shim}${delimiter}${process.env.PATH ?? ''}`);
  const catalog = await buildCatalog([privateRoot(f.vault)]), candidate = catalog.byName.get('report')![0]!;
  expect(candidate).toMatchObject({ dirty: null, tracked: null, revision: null });
  expect(catalog.roots[0]!.error).toMatch(/tracked files are unavailable.*unknown/);
});
it('keeps explicit non-Git roots unknown', async () => {
  const f = skillsFixture({ git: false }), dir = join(f.base, 'explicit-skills');
  write(join(dir, 'report/SKILL.md'), skillMd('report', 'Explicit source without Git history.'));
  const catalog = await buildCatalog([{ id: 'external:fixture', source: 'external', label: 'Explicit skills', path: dir, layout: 'flat' }]);
  expect(catalog.candidates[0]).toMatchObject({ valid: true, dirty: null, tracked: null, revision: null }); expect(catalog.roots[0]!.git).toBe(false);
});
