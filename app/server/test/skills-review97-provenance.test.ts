import { reviewedPlanViews as planViews } from './helpers/skills-reviewed.js';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkillsService } from '../src/addons/skills/service.js';
import { rootGit, pathState } from '../src/addons/skills/git.js';
import { loadRoster } from '../src/addons/skills/roster.js';
import { readCurrent, syncViews } from '../src/addons/skills/reconcile.js';
import { SETTINGS, skillMd, skillsFixture, write } from './helpers/skills.js';

afterEach(() => vi.unstubAllEnvs());
const POLICY = 'version: 1\nmode: managed\norg:\n  grant: [report]\n';
const serviceFor = (f: ReturnType<typeof skillsFixture>, external?: string) => new SkillsService(f.vault,
  { ...SETTINGS, externalRoots: external ? [{ id: 'fixture', path: external }] : [] }, { engineSkills: f.engine, db: false,
    observations: async () => ({ acks: [], hosts: [], lastSeen: new Map() }) });

describe('flat roots retain broken packages', () => {
  it.each(['private', 'engine', 'external'] as const)('keeps an ordinary %s directory without SKILL.md invalid and recognizes restoration', async kind => {
    const f = skillsFixture(), external = join(f.base, 'external');
    const root = kind === 'private' ? join(f.vault, '.agents/skills') : kind === 'engine' ? f.engine : external;
    write(join(root, 'missing-instructions/references/context.md'), 'Package content remains present');
    const service = serviceFor(f, kind === 'external' ? external : undefined);
    const broken = (await service.library()).skills.find(row => row.name === 'missing-instructions');
    expect(broken).toBeDefined();
    expect(broken!.effective).toMatchObject({ source: kind, valid: false });
    expect(broken!.effective!.errors.join(' ')).toMatch(/SKILL.md/);
    write(join(root, 'missing-instructions/SKILL.md'), skillMd('missing-instructions', 'Restored instructions.'));
    const restored = (await service.library(true)).skills.find(row => row.name === 'missing-instructions')!.effective!;
    expect(restored.valid).toBe(true); expect(restored.digest).toMatch(/^sha256:/); expect(restored.errors).toEqual([]);
  });
  it('keeps a broken private override above the shared source, with its Git deletion visible', async () => {
    const f = skillsFixture(), service = serviceFor(f), file = join(f.vault, '.agents/skills/report/SKILL.md');
    const original = readFileSync(file, 'utf8');
    const prior = (await service.library()).skills.find(row => row.name === 'report')!.effective!;
    rmSync(file);
    const broken = (await service.library(true)).skills.find(row => row.name === 'report')!;
    expect(broken.effective).toMatchObject({ id: 'private:report', valid: false, tracked: true, dirty: true });
    expect(broken.candidates.some(c => c.id === 'engine:report' && c.shadowedBy === 'private:report')).toBe(true);
    expect((await service.detail('report'))!.history.length).toBeGreaterThan(0);
    write(file, original);
    const restored = (await service.library(true)).skills.find(row => row.name === 'report')!.effective!;
    expect(restored).toMatchObject({ id: 'private:report', valid: true, dirty: false, digest: prior.digest });
  });
});

describe('failed Git provenance remains unknown', () => {
  it.each(['status', 'ls-files'] as const)('never reports a failed %s command as a clean or untracked result', async failed => {
    const f = skillsFixture(), service = serviceFor(f), packageDir = join(f.vault, '.agents/skills/report');
    write(join(packageDir, 'SKILL.md'), skillMd('report', 'Changed tracked content.'));
    expect((await service.library()).skills.find(row => row.name === 'report')!.effective!.dirty).toBe(true);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), shim = join(f.base, 'git-shim');
    const quoted = `'${realGit.replace(/'/g, `'\\''`)}'`;
    write(join(shim, 'git'), `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = "${failed}" ]; then exit 73; fi\ndone\nexec ${quoted} "$@"\n`, 0o755);
    vi.stubEnv('PATH', `${shim}${delimiter}${process.env.PATH ?? ''}`);
    const git = await rootGit(realpathSync(join(f.vault, '.agents/skills'))); expect(git).not.toBeNull();
    const state = pathState(git!, realpathSync(packageDir));
    if (failed === 'status') { expect(git!.dirty).toBeNull(); expect(state.dirty).toBeNull(); expect(state.tracked).toBe(true); }
    else { expect(git!.tracked).toBeNull(); expect(state.tracked).toBeNull(); expect(state.dirty).toBe(true); }
    const library = await service.library(true), candidate = library.skills.find(row => row.name === 'report')!.effective!;
    expect(library.roots.find(root => root.id === 'private')!.error).toMatch(/unavailable.*unknown/);
    if (failed === 'status') expect(candidate.dirty).toBeNull();
    else expect(candidate.tracked).toBeNull();
  });
});

async function deployed() {
  const f = skillsFixture(); write(join(f.vault, SETTINGS.policyFile), POLICY);
  const service = serviceFor(f), state = await service.current(), root = join(f.base, 'managed');
  const report = syncViews(root, planViews(state.catalog, state.policy, state.roster, { agents: ['alpha'] }));
  expect(report.views[0]!.status).toBe('current');
  return { f, service, root, prior: readCurrent(root, 'alpha', 'zen-agent').dir, priorState: readFileSync(join(root, 'state.json'), 'utf8') };
}
async function expectBlocked(fixture: Awaited<ReturnType<typeof deployed>>, label: RegExp) {
  const roster = loadRoster(fixture.f.vault); expect(roster.error).toMatch(label);
  const state = await fixture.service.current(true);
  expect((await fixture.service.matrix()).rosterError).toMatch(label);
  expect(() => syncViews(fixture.root, planViews(state.catalog, state.policy, state.roster, { agents: ['alpha'] }))).toThrow(/roster is invalid/);
  expect(readCurrent(fixture.root, 'alpha', 'zen-agent').dir).toBe(fixture.prior);
  expect(readFileSync(join(fixture.root, 'state.json'), 'utf8')).toBe(fixture.priorState);
}

describe('existing bad source YAML blocks managed planning', () => {
  it.each(['team: [broken', '- not-a-mapping', '', 'team: [media]\n', 'runtime: [zen-agent]\n', 'knowledge: plan.md\n'])('refuses invalid agent source %s with a valid compiled roster', async content => {
    const fixture = await deployed();
    write(join(fixture.f.vault, '.agents/org/config/agents/alpha.yaml'), content);
    await expectBlocked(fixture, /config\/agents\/alpha.yaml/);
  });
  it.each([
    ['org.yaml', 'defaults: [broken'],
    ['org.yaml', 'defaults:\n  knowledge: wrong-shape\n'],
    ['teams/media.yaml', 'lead: [broken'],
  ])('refuses malformed defaults/team source %s', async (path, content) => {
    const fixture = await deployed(); write(join(fixture.f.vault, '.agents/org/config', path), content);
    await expectBlocked(fixture, /config\/(?:org.yaml|teams\/media.yaml)/);
  });
  it('does not treat a dangling source link as an absent configuration', async () => {
    const fixture = await deployed(), path = join(fixture.f.vault, '.agents/org/config/agents/alpha.yaml');
    rmSync(path); symlinkSync(join(fixture.f.base, 'absent-source.yaml'), path);
    await expectBlocked(fixture, /config\/agents\/alpha.yaml/);
  });
  it('does not treat a source directory named like a YAML file as a successful empty read', async () => {
    const fixture = await deployed(), path = join(fixture.f.vault, '.agents/org/config/agents/alpha.yaml');
    rmSync(path); mkdirSync(path);
    await expectBlocked(fixture, /config\/agents\/alpha.yaml/);
  });
  it.runIf(typeof process.getuid === 'function' && process.getuid() !== 0)('reports an unreadable existing source file', async () => {
    const fixture = await deployed(), path = join(fixture.f.vault, '.agents/org/config/agents/alpha.yaml');
    chmodSync(path, 0);
    try { await expectBlocked(fixture, /config\/agents\/alpha.yaml/); }
    finally { chmodSync(path, 0o644); }
  });
  it('keeps genuinely absent optional sources compatible with compiled identities', async () => {
    const fixture = await deployed(); rmSync(join(fixture.f.vault, '.agents/org/config/agents/alpha.yaml'));
    const state = await fixture.service.current(true); expect(state.roster.error).toBeNull();
    expect(planViews(state.catalog, state.policy, state.roster, { agents: ['alpha'] }).views[0]!.agent).toBe('alpha');
  });
});
