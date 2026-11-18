import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { supportFor } from '../src/addons/skills/policy.js';
import { planFromBundle, packBundle, planViews, readCurrent, syncViews, verifyView } from '../src/addons/skills/reconcile.js';
import { SkillsService } from '../src/addons/skills/service.js';
import { MANAGED_POLICY, SETTINGS, skillsFixture, write } from './helpers/skills.js';

it('resolves, transports and verifies Codex catalogs without claiming native isolation', async () => {
  const f = skillsFixture();
  const rosterPath = join(f.vault, '.agents', 'org', 'org.json');
  const roster = JSON.parse(readFileSync(rosterPath, 'utf8'));
  roster.agents.delta = { runtime: 'codex', role: 'writer', team: 'media' };
  write(rosterPath, JSON.stringify(roster));
  write(join(f.vault, SETTINGS.policyFile), MANAGED_POLICY);
  const service = new SkillsService(f.vault, SETTINGS, { engineSkills: f.engine, db: false });
  const state = await service.current();
  const plan = planViews(state.catalog, state.policy, state.roster, { agents: ['delta'] });
  expect(plan.views.map((v) => [v.agent, v.runtime])).toEqual([['delta', 'codex']]);
  expect(supportFor('codex').level).toBe('catalog-only');
  expect((await service.agent('delta'))!.agent.support).toBe('catalog-only');
  const root = join(f.base, 'codex-deployment');
  const report = syncViews(root, planFromBundle(packBundle(plan)));
  expect(report.views[0]!.status).toBe('current');
  const current = readCurrent(root, 'delta', 'codex');
  expect(current.manifest).toMatchObject({ runtime: 'codex', support: 'catalog-only' });
  expect(verifyView(root, 'delta', 'codex').dirty).toEqual([]);
  expect(readFileSync(join(current.dir!, 'report', 'SKILL.md'), 'utf8')).toContain('Private report skill');
});
