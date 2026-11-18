import { lstatSync, mkdtempSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultEngineSkills, ENGINE_SKILLS, SkillsService } from '../src/addons/skills/service.js';
import { SETTINGS, skillMd, write } from './helpers/skills.js';

vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, lstatSync: vi.fn(fs.lstatSync) };
});
afterEach(async () => {
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(lstatSync).mockImplementation(fs.lstatSync);
});
const layout = () => {
  const base = mkdtempSync(join(tmpdir(), 'skills-engine-layout-')), vault = join(base, 'vault'), checkout = join(base, 'app-only', 'missing-checkout-skills');
  mkdirSync(vault); return { base, vault, checkout, pinned: join(vault, '.secondbrain', 'skills') };
};
async function simulateAppOnly() {
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(lstatSync).mockImplementation(((path: Parameters<typeof lstatSync>[0], options?: unknown) => {
    if (String(path) === ENGINE_SKILLS) throw Object.assign(new Error('No source skills in an app-only deployment'), { code: 'ENOENT' });
    return fs.lstatSync(path, options as never);
  }) as typeof lstatSync);
}
it('discovers engine packages from the regular vault pin in an app-only deployment', async () => {
  const f = layout(); write(join(f.pinned, 'shared-report/SKILL.md'), skillMd('shared-report', 'Packaged engine instructions.'));
  expect(defaultEngineSkills(f.vault, f.checkout)).toBe(f.pinned);
  await simulateAppOnly();
  const library = await new SkillsService(f.vault, SETTINGS, { db: false }).library();
  expect(library.roots.find(root => root.id === 'engine')).toMatchObject({ exists: true, packages: 1, git: false });
  expect(library.skills.find(row => row.name === 'shared-report')!.effective).toMatchObject({ id: 'engine:shared-report', source: 'engine', valid: true, dirty: null, tracked: null, revision: null });
});
it('keeps explicit null disabled even when the pinned engine is available', async () => {
  const f = layout(); write(join(f.pinned, 'shared-report/SKILL.md'), skillMd('shared-report', 'Pinned instructions.')); await simulateAppOnly();
  const library = await new SkillsService(f.vault, SETTINGS, { db: false, engineSkills: null }).library();
  expect(library.roots.some(root => root.id === 'engine')).toBe(false); expect(library.skills).toEqual([]);
});
it('prefers a regular source checkout over the vault pin', async () => {
  const f = layout(); write(join(f.checkout, 'checkout-report/SKILL.md'), skillMd('checkout-report', 'Checkout instructions.'));
  write(join(f.pinned, 'pinned-report/SKILL.md'), skillMd('pinned-report', 'Pinned instructions.'));
  const resolved = defaultEngineSkills(f.vault, f.checkout); expect(resolved).toBe(f.checkout);
  const library = await new SkillsService(f.vault, SETTINGS, { db: false, engineSkills: resolved }).library();
  expect(library.skills.map(row => row.name)).toEqual(['checkout-report']);
});
it('preserves an explicit engine root instead of replacing it with the vault pin', async () => {
  const f = layout(), explicit = join(f.base, 'explicit-skills');
  write(join(explicit, 'explicit-report/SKILL.md'), skillMd('explicit-report', 'Explicit instructions.'));
  write(join(f.pinned, 'pinned-report/SKILL.md'), skillMd('pinned-report', 'Pinned instructions.')); await simulateAppOnly();
  const library = await new SkillsService(f.vault, SETTINGS, { db: false, engineSkills: explicit }).library();
  expect(library.skills.map(row => row.name)).toEqual(['explicit-report']);
});
it('does not invent an engine root when neither supported location exists', async () => {
  const f = layout(); expect(defaultEngineSkills(f.vault, f.checkout)).toBeNull(); await simulateAppOnly();
  const library = await new SkillsService(f.vault, SETTINGS, { db: false }).library();
  expect(library.roots.some(root => root.id === 'engine')).toBe(false); expect(library.skills).toEqual([]);
});
it.each(['pin', 'skills', 'vault'] as const)('rejects a linked fallback %s ancestor without cataloging its target', async part => {
  const f = layout(), outside = join(f.base, 'outside'), target = part === 'vault' ? join(f.base, 'linked-vault') : part === 'pin' ? join(f.vault, '.secondbrain') : f.pinned;
  const outsideSkills = part === 'vault' ? join(outside, '.secondbrain', 'skills') : part === 'pin' ? join(outside, 'skills') : outside;
  write(join(outsideSkills, 'outside-report/SKILL.md'), skillMd('outside-report', 'Outside instructions.'));
  if (part === 'skills') mkdirSync(join(f.vault, '.secondbrain'));
  symlinkSync(outside, target); const vault = part === 'vault' ? target : f.vault;
  expect(defaultEngineSkills(vault, f.checkout)).toBeNull(); await simulateAppOnly();
  const library = await new SkillsService(vault, SETTINGS, { db: false }).library();
  expect(library.roots.some(root => root.id === 'engine')).toBe(false); expect(library.skills.some(row => row.name === 'outside-report')).toBe(false);
});
