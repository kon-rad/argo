import { chmodSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SkillsService } from '../src/addons/skills/service.js';
import { ackPayload, inspectRoot, planViews, readCurrent, syncViews } from '../src/addons/skills/reconcile.js';
import { machineStates, type AckRow } from '../src/addons/skills/machines.js';
import { AckRequestSchema } from '@secondbrain/contracts/skills';
import { SETTINGS, skillMd, skillsFixture, write } from './helpers/skills.js';

async function setup(grants = '[report]') {
  const f = skillsFixture();
  write(join(f.vault, SETTINGS.policyFile), `version: 1\nmode: managed\norg:\n  grant: ${grants}\n`);
  const service = new SkillsService(f.vault, SETTINGS, { engineSkills: f.engine, db: false });
  const state = await service.current(), plan = planViews(state.catalog, state.policy, state.roster, { agents: ['alpha', 'beta'] });
  return { f, service, plan, root: join(f.base, 'managed') };
}
function active(root: string, plan: Awaited<ReturnType<typeof setup>>['plan']) {
  return plan.views.map(v => {
    const current = readCurrent(root, v.agent, v.runtime);
    return { target: readlinkSync(join(root, 'views', v.agent, v.runtime)), manifest: readFileSync(join(current.dir!, 'manifest.json'), 'utf8'), generations: readdirSync(join(root, 'views', v.agent)).sort() };
  });
}
it.each(['staging', 'activation'] as const)('preserves both previous generations after second-view %s failure', async phase => {
  const { f, service, plan, root } = await setup();
  expect(syncViews(root, plan).views.every(v => v.status === 'current')).toBe(true);
  const before = active(root, plan);
  write(join(f.vault, '.agents/skills/report/SKILL.md'), skillMd('report', 'New report revision.'));
  write(join(f.vault, '.agents/skills/ingest/SKILL.md'), skillMd('ingest', 'New ingest revision.'));
  write(join(f.vault, SETTINGS.policyFile), 'version: 1\nmode: managed\nagents:\n  alpha:\n    grant: [report]\n  beta:\n    grant: [ingest]\n');
  const changed = await service.current(true), next = planViews(changed.catalog, changed.policy, changed.roster, { agents: ['alpha', 'beta'] });
  const report = syncViews(root, next, { hooks: phase === 'staging' ? { afterStage(digest) { if (digest === next.views[1]!.skills[0]!.digest) throw new Error('second staging fault'); } } : {
    beforeActivate(view) { if (view.agent === 'beta') throw new Error('second activation fault'); },
  } });
  expect(report.views.every(v => v.status === 'failed')).toBe(true);
  expect(report.views.every(v => v.error?.includes(`second ${phase} fault`))).toBe(true);
  expect(active(root, plan)).toEqual(before);
});
it('restores repaired shared store bytes and every switched view', async () => {
  const { plan, root } = await setup(); syncViews(root, plan);
  const before = active(root, plan), path = join(root, 'store', plan.views[0]!.skills[0]!.digest.slice(7), 'SKILL.md');
  chmodSync(path, 0o600); write(path, 'Locally modified original bytes', 0o600);
  const report = syncViews(root, plan, { repair: true, hooks: { beforeActivate(view) { if (view.agent === 'beta') throw new Error('second activation fault'); } } });
  expect(report.views.every(v => v.status === 'failed')).toBe(true);
  expect(active(root, plan)).toEqual(before); expect(readFileSync(path, 'utf8')).toBe('Locally modified original bytes');
});
it('finishes preparing later generations before any activation', async () => {
  const { root, plan } = await setup(); const activated: string[] = [];
  const report = syncViews(root, plan, { hooks: { beforeActivate(view) {
    if (view.agent === 'alpha') {
      const generations = readdirSync(join(root, 'views/beta')).filter(name => name.startsWith('claude-code.'));
      expect(generations).toHaveLength(1);
      expect(readFileSync(join(root, 'views/beta', generations[0]!, 'manifest.json'), 'utf8')).toContain('"agent": "beta"');
    }
    activated.push(view.agent);
  } } });
  expect(activated).toEqual(['alpha', 'beta']); expect(report.views.every(v => v.status === 'current')).toBe(true);
});
it('installs verified packages while missing prerequisites remain not-ready locally and remotely', async () => {
  const { root, plan } = await setup('[report, clip]');
  const report = syncViews(root, plan, { env: { PATH: '' } });
  expect(report.views.every(v => v.status === 'not-ready')).toBe(true);
  const local = inspectRoot(root, { PATH: '' }); expect(local.every(v => v.status === 'not-ready')).toBe(true);
  expect(local[0]!.missing).toEqual([{ skill: 'clip', bins: ['definitely-not-a-real-program-xyz'], env: ['FIXTURE_CLIP_KEY'] }]);
  expect(readCurrent(root, 'alpha', 'zen-agent').manifest?.skills.map(s => s.name)).toContain('clip');
  const payload = ackPayload({ policyDigest: plan.policyDigest, views: local }, 'fixture-engine'); expect(AckRequestSchema.safeParse(payload).success).toBe(true);
  const now = new Date();
  const rows: AckRow[] = payload.views.map(v => ({ host: 'machine', agent: v.agent, runtime: v.runtime, status: v.status, error: v.error, view_digest: v.viewDigest,
    policy_digest: payload.policyDigest, generated_at: new Date(v.generatedAt!), received_at: now, skills: v.skills, missing: v.missing, dirty: v.dirty }));
  const machines = machineStates({ acks: rows, hosts: [], lastSeen: new Map() }, agent => new Map(plan.views.find(v => v.agent === agent)!.skills.map(s => [s.name, s.digest])), 24, now, plan.policyDigest);
  expect(machines[0]!.status).toBe('not-ready'); expect(machines[0]!.views.every(v => v.status === 'not-ready')).toBe(true);
  rows.forEach(row => { row.status = 'current'; });
  expect(machineStates({ acks: rows, hosts: [], lastSeen: new Map() }, () => null, 24, now)[0]!.status).toBe('not-ready');
});
