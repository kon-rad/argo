import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SkillsService } from '../src/addons/skills/service.js';
import { SETTINGS, skillMd, skillsFixture, write } from './helpers/skills.js';

it('discovers nested legacy categories while leaving archived and dependency folders out', async () => {
  const f = skillsFixture();
  const root = join(f.vault, '.hermes', 'skills');
  write(join(root, 'mlops', 'evaluation', 'evaluate', 'SKILL.md'), skillMd('evaluate', 'Nested evaluation skill.'));
  write(join(root, '.archive', 'retired', 'SKILL.md'), skillMd('retired', 'Archived skill.'));
  write(join(root, 'node_modules', 'dependency', 'SKILL.md'), skillMd('dependency', 'Dependency fixture.'));
  const service = new SkillsService(f.vault, SETTINGS, { engineSkills: f.engine, db: false });
  const library = await service.library();
  expect(library.skills.find((s) => s.name === 'evaluate')!.effective).toMatchObject({
    id: 'legacy:mlops/evaluation/evaluate', category: 'mlops/evaluation', valid: true,
  });
  expect(library.skills.some((s) => s.name === 'retired' || s.name === 'dependency')).toBe(false);
});
