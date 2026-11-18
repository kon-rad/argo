import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ACK_LIMITS, AckRequestSchema } from '@secondbrain/contracts/skills';
import { SkillsService } from '../src/addons/skills/service.js';
import { ackPayload, inspectRoot, packBundle, planFromBundle, planViews, readCurrent, removeTree, syncViews, type Plan, type ViewPlan } from '../src/addons/skills/reconcile.js';
import { MANAGED_POLICY, SETTINGS, skillsFixture, write } from './helpers/skills.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTree(root); });
function fixture() { const f = skillsFixture(); roots.push(f.base); return f; }
function emptyViews(count: number): ViewPlan[] {
  return Array.from({ length: count }, (_, i) => ({ agent: `agent-${i}`, runtime: 'codex', skills: [], excluded: [] }));
}

it('bounds planning, bundle export and imported bundles before a 65-view deployment exists', async () => {
  const f = fixture(); write(join(f.vault, SETTINGS.policyFile), MANAGED_POLICY);
  const service = new SkillsService(f.vault, SETTINGS, { engineSkills: f.engine, db: false });
  const state = await service.current();
  const roster = { ...state.roster, agents: Array.from({ length: 65 }, (_, i) => ({ ...state.roster.agents.find(agent => agent.name === 'alpha')!, name: `agent-${i}` })) };
  expect(() => planViews(state.catalog, state.policy, roster)).toThrow(/65 views.*64/);
  const plan: Plan = { policyDigest: null, views: emptyViews(65), packages: new Map() };
  expect(() => packBundle(plan)).toThrow(/65 views.*64/);
  expect(() => planFromBundle({ format: 'secondbrain-skills-bundle/1', createdAt: new Date().toISOString(), policyDigest: null, views: plan.views, packages: {} })).toThrow(/65 views.*64/);
  const root = join(f.base, 'managed');
  expect(() => syncViews(root, plan)).toThrow(/65 views.*64/);
  expect(existsSync(root)).toBe(false);
});

it('counts existing unselected views before activating an additional view', () => {
  const f = fixture(), root = join(f.base, 'managed');
  const plan: Plan = { policyDigest: null, views: emptyViews(ACK_LIMITS.views), packages: new Map() };
  const report = syncViews(root, plan);
  expect(report.views).toHaveLength(64);
  expect(report.views.every(view => view.status === 'current')).toBe(true);
  expect(AckRequestSchema.parse(ackPayload(report, null)).views).toHaveLength(64);
  const previous = readCurrent(root, 'agent-0', 'codex').dir;
  const next: Plan = { ...plan, views: [{ ...plan.views[0]!, agent: 'additional-agent' }] };
  expect(() => syncViews(root, next)).toThrow(/65 views.*64/);
  expect(readCurrent(root, 'agent-0', 'codex').dir).toBe(previous);
  expect(inspectRoot(root)).toHaveLength(64);
  expect(existsSync(join(root, 'views', 'additional-agent'))).toBe(false);
});

it('refuses a byte-oversized valid-count plan before creating a root', () => {
  const f = fixture(), root = join(f.base, 'managed');
  const skills = Array.from({ length: ACK_LIMITS.skillsPerView }, (_, i) => {
    const name = `s${String(i).padStart(4, '0')}${'x'.repeat(58)}`;
    return { name, id: `legacy:${'category'.repeat(15)}/${name}`, digest: `sha256:${'a'.repeat(64)}`, revision: null, dirty: false, description: 'Capacity fixture.', requires: { bins: [], env: [] } };
  });
  const plan: Plan = { policyDigest: null, views: emptyViews(2).map(view => ({ ...view, skills })), packages: new Map() };
  expect(() => syncViews(root, plan)).toThrow(/byte acknowledgement capacity/);
  expect(existsSync(root)).toBe(false);
});

it('preserves unknown source dirtiness through planning, bundles and generated manifests', async () => {
  const f = fixture(); write(join(f.vault, SETTINGS.policyFile), 'version: 1\nmode: managed\norg:\n  grant: [report]\n');
  const service = new SkillsService(f.vault, SETTINGS, { engineSkills: f.engine, db: false });
  const state = await service.current(); state.catalog.byName.get('report')![0]!.dirty = null;
  const plan = planViews(state.catalog, state.policy, state.roster, { agents: ['alpha'] });
  expect(plan.views[0]!.skills[0]!.dirty).toBeNull();
  const restored = planFromBundle(packBundle(plan));
  expect(restored.views[0]!.skills[0]!.dirty).toBeNull();
  const root = join(f.base, 'managed'); expect(syncViews(root, restored).views[0]!.status).toBe('current');
  expect(readCurrent(root, 'alpha', 'zen-agent').manifest!.skills[0]!.dirty).toBeNull();
});
