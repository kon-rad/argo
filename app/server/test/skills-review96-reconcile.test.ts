import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AckRequestSchema } from '@secondbrain/contracts/skills';
import { SkillsService } from '../src/addons/skills/service.js';
import { loadRoster } from '../src/addons/skills/roster.js';
import { resolveAgent, selectedCandidate, unresolvedAssignments } from '../src/addons/skills/policy.js';
import { machineStates, type AckRow } from '../src/addons/skills/machines.js';
import { ackPayload, inspectRoot, packBundle, planFromBundle, planViews, readCurrent, syncViews } from '../src/addons/skills/reconcile.js';
import { SETTINGS, skillMd, skillsFixture, write } from './helpers/skills.js';

const POLICY = 'version: 1\nmode: managed\norg:\n  grant: [report]\n';
async function fixture() {
  const f = skillsFixture(); write(join(f.vault, SETTINGS.policyFile), POLICY);
  const service = new SkillsService(f.vault, SETTINGS, { engineSkills: f.engine, db: false, observations: async () => ({ acks: [], hosts: [], lastSeen: new Map() }) });
  const state = await service.current(), plan = planViews(state.catalog, state.policy, state.roster, { agents: ['alpha'] });
  const root = join(f.base, 'managed'), report = syncViews(root, plan, { env: { PATH: '' } });
  expect(report.views[0]!.status).toBe('current');
  return { f, service, state, plan, root, report };
}
function snapshot(path: string): unknown {
  const st = lstatSync(path), mode = st.mode & 0o777;
  if (st.isSymbolicLink()) return { mode, target: readlinkSync(path) };
  if (st.isDirectory()) return { mode, children: readdirSync(path).sort().map(name => [name, snapshot(join(path, name))]) };
  return { mode, content: readFileSync(path, 'utf8') };
}
function refused(root: string, plan: Parameters<typeof syncViews>[1], repair: boolean) {
  try {
    const report = syncViews(root, plan, { repair, env: { PATH: '' } });
    expect(report.views.every(view => view.status === 'failed')).toBe(true);
    expect(report.views.map(view => view.error).join(' ')).toMatch(/link|unmanaged|regular directory/);
  } catch (err) { expect((err as Error).message).toMatch(/link|unmanaged|regular directory/); }
}

describe('reconciliation never follows structural directory links', () => {
  for (const repair of [false, true]) it.each(['root', 'store', 'views', 'views/alpha', 'quarantine', '.staging'])(`refuses %s link without outside writes, chmod or cleanup (repair=${repair})`, async part => {
    const { f, root, plan } = await fixture();
    const outside = join(f.base, 'outside-sentinel'); mkdirSync(outside, { mode: 0o700 });
    write(join(outside, 'private.txt'), 'Outside content stays untouched', 0o600);
    write(join(outside, 'zen-agent.20000101T000000-aaaaaa', 'sentinel.txt'), 'Never prune this unrelated folder', 0o400);
    chmodSync(join(outside, 'zen-agent.20000101T000000-aaaaaa'), 0o500);
    const target = part === 'root' ? root : join(root, part);
    if (existsSync(target)) renameSync(target, join(f.base, 'saved-owned-path'));
    symlinkSync(outside, target);
    const before = snapshot(outside);
    refused(root, plan, repair);
    expect(snapshot(outside)).toEqual(before);
    expect(readlinkSync(target)).toBe(outside);
  });

  it('refuses an unmanaged generation directory and preserves the active manager generation', async () => {
    const { root, plan } = await fixture(), before = readCurrent(root, 'alpha', 'zen-agent').dir;
    const unmanaged = join(root, 'views/alpha/zen-agent.20000101T000000-aaaaaa');
    write(join(unmanaged, 'notes.md'), 'User-owned notes', 0o600); chmodSync(unmanaged, 0o500);
    const original = snapshot(unmanaged);
    refused(root, plan, true);
    expect(snapshot(unmanaged)).toEqual(original);
    expect(readCurrent(root, 'alpha', 'zen-agent').dir).toBe(before);
  });

  it('never prunes a formerly managed generation containing unowned content', async () => {
    const { root, plan } = await fixture(), old = readCurrent(root, 'alpha', 'zen-agent').dir!;
    write(join(old, 'owner-notes.md'), 'Preserve this addition', 0o600);
    for (let i = 0; i < 4; i++) expect(syncViews(root, plan, { repair: true }).views[0]!.status).toBe('current');
    expect(readFileSync(join(old, 'owner-notes.md'), 'utf8')).toBe('Preserve this addition');
    expect(lstatSync(join(old, 'owner-notes.md')).mode & 0o777).toBe(0o600);
    expect(readCurrent(root, 'alpha', 'zen-agent').manifest).not.toBeNull();
  });
});

it.each(['{"project":"unrelated user state"}', '{not-json'])('preserves an existing unmanaged state file: %s', async content => {
  const f = skillsFixture(); write(join(f.vault, SETTINGS.policyFile), POLICY);
  const service = new SkillsService(f.vault, SETTINGS, { engineSkills: f.engine, db: false });
  const state = await service.current(), plan = planViews(state.catalog, state.policy, state.roster, { agents: ['alpha'] });
  const root = join(f.base, 'unmanaged-root'); write(join(root, 'state.json'), content, 0o600);
  const before = snapshot(root);
  expect(() => syncViews(root, plan)).toThrow(/unmanaged state.json/);
  expect(snapshot(root)).toEqual(before);
});

it('preserves state belonging to another manager root', async () => {
  const { f, root, report, plan } = await fixture();
  const other = join(f.base, 'other-managed-root'); write(join(other, 'state.json'), JSON.stringify(report), 0o600);
  const before = snapshot(other);
  expect(() => syncViews(other, plan)).toThrow(/unmanaged state.json/);
  expect(snapshot(other)).toEqual(before);
  expect(readCurrent(root, 'alpha', 'zen-agent').manifest).not.toBeNull();
});

describe('invalid compiled rosters cannot fall back into managed activation', () => {
  it.each(['{bad', '[]', '{"agents":[]}', '{"agents":{},"teams":[]}', '{"agents":{"alpha":null}}', '{"agents":{"alpha":{"runtime":3}}}', '{"agents":{"alpha":{"runtime":"unsupported"}}}', '{"agents":{},"teams":{"media":"bad"}}'])('blocks compiled roster %s and leaves prior view unchanged', async compiled => {
    const { f, service, root } = await fixture(), before = readCurrent(root, 'alpha', 'zen-agent').dir;
    const priorState = readFileSync(join(root, 'state.json'), 'utf8');
    write(join(f.vault, '.agents/org/config/agents/alpha.yaml'), 'runtime: zen-agent\nteam: media\n');
    write(join(f.vault, '.agents/org/org.json'), compiled);
    const roster = loadRoster(f.vault); expect(roster.error).toMatch(/org.json is invalid/); expect(roster.agents).toEqual([]);
    const state = await service.current(true);
    expect(() => syncViews(root, planViews(state.catalog, state.policy, state.roster, { agents: ['alpha'] }))).toThrow(/roster is invalid/);
    expect(readCurrent(root, 'alpha', 'zen-agent').dir).toBe(before);
    expect(readFileSync(join(root, 'state.json'), 'utf8')).toBe(priorState);
  });
  it('retains YAML fallback only when the compiled roster is absent', async () => {
    const { f, service } = await fixture(); rmSync(join(f.vault, '.agents/org/org.json'));
    write(join(f.vault, '.agents/org/config/agents/alpha.yaml'), 'runtime: zen-agent\nteam: media\n');
    const state = await service.current(true); expect(state.roster.error).toBeNull();
    expect(planViews(state.catalog, state.policy, state.roster, { agents: ['alpha'] }).views[0]!.runtime).toBe('zen-agent');
  });
});

describe('unresolved skill dependencies block availability and deployment', () => {
  it.each(['missing', 'denied', 'disabled', 'invalid', 'missing pin', 'transitive'])('retains the previous view and reports %s dependency in plans, status and machines', async kind => {
    const { f, service, root, report } = await fixture(), before = readCurrent(root, 'alpha', 'zen-agent').dir;
    let policy = 'version: 1\nmode: managed\norg:\n  grant: [report, video]\n';
    const dependency = kind === 'missing' ? 'not-here' : kind === 'transitive' ? 'clip' : 'video';
    write(join(f.vault, '.agents/skills/report/SKILL.md'), skillMd('report', 'Needs another skill.', `metadata:\n  depends: [${dependency}]\n`));
    if (kind === 'denied') policy += 'agents:\n  alpha:\n    deny: [video]\n';
    if (kind === 'disabled') policy += 'lifecycle:\n  video: {status: disabled}\n';
    if (kind === 'invalid') write(join(f.vault, '.hermes/skills/media/video/SKILL.md'), '---\nname: video\n---\nMissing description');
    if (kind === 'missing pin') policy += 'pins:\n  video: engine:absent\n';
    if (kind === 'transitive') {
      policy = 'version: 1\nmode: managed\norg:\n  grant: [report, clip]\n';
      write(join(f.vault, '.agents/skills/clip/SKILL.md'), skillMd('clip', 'Needs video.', 'metadata:\n  depends: [video]\n'));
    }
    write(join(f.vault, SETTINGS.policyFile), policy);
    const state = await service.current(true), agent = state.roster.agents.find(a => a.name === 'alpha')!;
    const cells = resolveAgent(agent, state.policy, state.catalog);
    expect(cells.get('report')!.state).toBe('unavailable');
    expect(cells.get('report')!.reasons.map(r => r.detail).join(' ')).toContain(dependency);
    const plan = planViews(state.catalog, state.policy, state.roster, { agents: ['alpha'] });
    expect(plan.views[0]!.excluded.some(e => e.name === 'report' && e.reason.includes(dependency))).toBe(true);
    const failed = syncViews(root, plan); expect(failed.views[0]!.status).toBe('failed');
    expect(readCurrent(root, 'alpha', 'zen-agent').dir).toBe(before);
    expect(inspectRoot(root)[0]!.excluded?.some(e => e.name === 'report')).toBe(true);
    expect(() => AckRequestSchema.parse(ackPayload(failed, null))).not.toThrow();
    const old = report.views[0]!, now = new Date();
    const ack: AckRow = { host: 'reconcile-fixture', agent: 'alpha', runtime: 'zen-agent', status: 'current', error: null, view_digest: old.viewDigest,
      policy_digest: report.policyDigest, generated_at: new Date(old.generatedAt!), received_at: now, skills: old.skills, missing: [], dirty: [] };
    const desired = new Map<string, string>();
    for (const cell of cells.values()) if (cell.state === 'assigned') desired.set(cell.skill, selectedCandidate(state.policy.policy, state.catalog, cell.skill).candidate!.digest!);
    const observed = machineStates({ acks: [ack], hosts: [{ slug: ack.host, display: ack.host }], lastSeen: new Map([[ack.host, now]]) }, () => desired, 24, now, state.policy.digest, () => unresolvedAssignments(cells.values()));
    expect(observed[0]!.views[0]!.status).toBe('failed');
    expect(observed[0]!.views[0]!.excluded?.some(e => e.name === 'report')).toBe(true);
    expect(observed[0]!.views[0]!.error).toContain(dependency);
  });

  it('rechecks declared dependencies in transported package bytes instead of trusting bundle metadata', async () => {
    const { f, service, root, plan } = await fixture(), before = readCurrent(root, 'alpha', 'zen-agent').dir;
    write(join(f.vault, '.agents/skills/report/SKILL.md'), skillMd('report', 'Needs denied video.', 'metadata:\n  depends: [video]\n'));
    const candidate = (await service.current(true)).catalog.byName.get('report')![0]!;
    const claimed = { ...plan, views: [{ ...plan.views[0]!, excluded: [], skills: [{ ...plan.views[0]!.skills[0]!, digest: candidate.digest!, depends: [] }] }], packages: new Map([[candidate.digest!, { files: candidate.packageFiles.map(f => ({ path: f.path, exec: f.exec, read: () => readFileSync(f.abs) })) }]]) };
    const transported = planFromBundle(packBundle(claimed));
    const failed = syncViews(root, transported); expect(failed.views[0]!.status).toBe('failed');
    expect(failed.views[0]!.excluded?.some(e => e.name === 'report' && e.reason.includes('video'))).toBe(true);
    expect(readCurrent(root, 'alpha', 'zen-agent').dir).toBe(before);
  });
});
