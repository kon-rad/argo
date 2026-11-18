import { chmodSync, lstatSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runSkillsCli } from '../src/addons/skills/cli.js';
import { planViews, readCurrent, syncViews } from '../src/addons/skills/reconcile.js';
import { SkillsService } from '../src/addons/skills/service.js';
import { MANAGED_POLICY, SETTINGS, skillMd, skillsFixture, write } from './helpers/skills.js';

const roots: string[] = [];
function cleanup(path: string): void {
  const st = lstatSync(path);
  if (st.isDirectory() && !st.isSymbolicLink()) {
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) cleanup(join(path, name));
  }
  rmSync(path, { recursive: true, force: true });
}
afterEach(() => { for (const root of roots.splice(0)) cleanup(root); });
function fixture() {
  const f = skillsFixture(); roots.push(f.base);
  write(join(f.vault, SETTINGS.policyFile), MANAGED_POLICY);
  const service = new SkillsService(f.vault, SETTINGS, { engineSkills: f.engine, db: false, observations: async () => ({ acks: [], hosts: [], lastSeen: new Map() }) });
  const lines: string[] = [];
  const io = { out: (text: string) => lines.push(text), err: (text: string) => lines.push(text), env: { PATH: '' } };
  return { f, service, io, lines };
}

it('exports a new private bundle exclusively with mode 0600', async () => {
  const { f, service, io } = fixture(), out = join(f.base, 'new-bundle.json');
  expect(await runSkillsCli(['pack', '--agents', 'alpha', '--out', out], service, io)).toBe(0);
  expect(statSync(out).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(out, 'utf8')).views).toHaveLength(1);
});

it.each(['regular', 'symlink', 'dangling symlink'])('refuses an existing %s bundle destination without changing its target', async kind => {
  const { f, service, io, lines } = fixture(), out = join(f.base, 'existing.json'), target = join(f.base, 'sentinel.txt');
  writeFileSync(target, 'Preserve outside contents'); chmodSync(target, 0o644);
  if (kind === 'regular') { writeFileSync(out, 'Preserve previous output'); chmodSync(out, 0o644); }
  else symlinkSync(kind === 'symlink' ? target : join(f.base, 'missing-target'), out);
  expect(await runSkillsCli(['pack', '--agents', 'alpha', '--out', out], service, io)).toBe(1);
  expect(lines.join(' ')).toMatch(/already exists/);
  expect(readFileSync(target, 'utf8')).toBe('Preserve outside contents');
  expect(statSync(target).mode & 0o777).toBe(0o644);
  if (kind === 'regular') { expect(readFileSync(out, 'utf8')).toBe('Preserve previous output'); expect(statSync(out).mode & 0o777).toBe(0o644); }
  else expect(lstatSync(out).isSymbolicLink()).toBe(true);
});

it.each(['dirty', 'failed'])('returns failure for a %s view in both plain and JSON status output', async corruption => {
  const { f, service, io, lines } = fixture(), root = join(f.base, 'managed');
  const state = await service.current();
  const deployed = syncViews(root, planViews(state.catalog, state.policy, state.roster, { agents: ['alpha'] }));
  expect(deployed.views[0]!.status).toBe('not-ready');
  expect(deployed.views[0]!.missing.some(item => item.skill === 'clip')).toBe(true);
  if (corruption === 'failed') rmSync(join(root, 'views', 'alpha', 'zen-agent'));
  else {
    const dir = readCurrent(root, 'alpha', 'zen-agent').dir;
    chmodSync(dir, 0o755); writeFileSync(join(dir, '.DS_Store'), 'Unexpected view member');
  }
  expect(await runSkillsCli(['status', '--root', root], service, io)).toBe(2);
  expect(lines.join(' ')).toContain(corruption); lines.length = 0;
  expect(await runSkillsCli(['status', '--root', root, '--json'], service, io)).toBe(2);
  expect(JSON.parse(lines.join('')).views[0].status).toBe(corruption);
});

it('requires the loaded file version for CLI saves and preserves an earlier save on conflict', async () => {
  const { f, service, io, lines } = fixture();
  const draft = await service.createDraft('report', 'report'), version = draft.files.find(file => file.path === 'SKILL.md')!.version;
  if (!version) throw new Error('Missing fixture file version');
  const before = (await service.readDraftFile('report', 'SKILL.md')).content;
  const input = join(f.base, 'edit.md'), first = skillMd('report', 'First CLI edit.');
  writeFileSync(input, first);
  const args = ['draft', 'write', 'report', 'SKILL.md', '--file', input];
  expect(await runSkillsCli(args, service, io)).toBe(1);
  expect(lines.join(' ')).toContain('--expected-version');
  expect((await service.readDraftFile('report', 'SKILL.md')).content).toBe(before);
  expect(await runSkillsCli([...args, '--expected-version', version], service, io)).toBe(0);
  writeFileSync(input, skillMd('report', 'Stale second edit.'));
  expect(await runSkillsCli([...args, '--expected-version', version], service, io)).toBe(2);
  expect((await service.readDraftFile('report', 'SKILL.md')).content).toBe(first);
});
