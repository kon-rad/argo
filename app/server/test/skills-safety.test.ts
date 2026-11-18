import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanPackage } from '../src/addons/skills/package.js';
import { SkillsService } from '../src/addons/skills/service.js';
import { SETTINGS, skillMd, skillsFixture, write } from './helpers/skills.js';

describe('skills package confidentiality', () => {
  it.each(['auth.json', '.credentials.json', 'credentials.json', '.pypirc'])('refuses credential-bearing filename %s', (filename) => {
    const root = mkdtempSync(join(tmpdir(), 'skills-safety-'));
    try {
      write(join(root, 'SKILL.md'), skillMd('probe', 'Synthetic fixture.'));
      write(join(root, filename), '{"fixture":"not a real credential"}');
      expect(scanPackage(root)).toMatchObject({ ok: false });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses an innocent alias into an ignored credential directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-safety-'));
    try {
      write(join(root, 'SKILL.md'), skillMd('probe', 'Synthetic fixture.'));
      write(join(root, 'node_modules', 'credentials.json'), 'synthetic-only');
      symlinkSync('node_modules/credentials.json', join(root, 'notes.txt'));
      expect(scanPackage(root)).toMatchObject({ ok: false });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('does not expose instructions from a package rejected for escaping its root', async () => {
    const f = skillsFixture();
    try {
      write(join(f.outside, 'pkg', 'SKILL.md'), skillMd('pkg', 'Outside fixture.', '', '# Outside-only instructions'));
      const service = new SkillsService(f.vault, SETTINGS, { engineSkills: f.engine, db: false });
      expect((await service.detail('outside'))!.instructions).toBe('');
      expect((await service.detail('outside'))!.files).toEqual([]);
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  });

  it('rejects a cached file redirected to an in-package credential after discovery', async () => {
    const f = skillsFixture();
    try {
      const root = join(f.vault, '.agents', 'skills', 'report');
      write(join(root, 'notes.txt'), 'safe notes');
      const service = new SkillsService(f.vault, SETTINGS, { engineSkills: f.engine, db: false });
      await service.library();
      write(join(root, 'node_modules', 'credentials.json'), 'synthetic-only');
      rmSync(join(root, 'notes.txt'));
      symlinkSync('node_modules/credentials.json', join(root, 'notes.txt'));
      expect(await service.file('report', undefined, 'notes.txt')).toBeNull();
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  });

  it('still accepts a normal in-package link and a documented environment template', () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-safety-'));
    try {
      write(join(root, 'SKILL.md'), skillMd('probe', 'Synthetic fixture.'));
      write(join(root, '.env.sample'), 'EXAMPLE_NAME=\n');
      write(join(root, 'references', 'guide.md'), '# Guide');
      symlinkSync('references/guide.md', join(root, 'guide.md'));
      expect(scanPackage(root)).toMatchObject({ ok: true });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
