import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { AckRequest } from '@secondbrain/contracts/skills';
import { query } from '../src/db.js';
import { addDevice } from '../src/ingest/devices.js';
import { runSkillsCli } from '../src/addons/skills/cli.js';
import { recordAck, type AckRow } from '../src/addons/skills/machines.js';
import { SkillsService } from '../src/addons/skills/service.js';
import { selectedCandidate } from '../src/addons/skills/policy.js';
import { SETTINGS, skillMd, skillsFixture, write } from './helpers/skills.js';

const HOST = 'skills-observation-fixture';
const POLICY = 'version: 1\nmode: managed\norg:\n  grant: [report]\n';
const empty = async () => ({ acks: [], hosts: [], lastSeen: new Map<string, Date>() });
function fixture(policy = POLICY) {
  const f = skillsFixture(); write(join(f.vault, SETTINGS.policyFile), policy);
  const service = new SkillsService(f.vault, SETTINGS, { engineSkills: f.engine, db: false, observations: empty });
  return { f, service };
}
afterEach(async () => {
  await query('DELETE FROM skill_view_acks WHERE host=$1', [HOST]);
  await query('DELETE FROM skill_ack_log WHERE host=$1', [HOST]);
  await query('DELETE FROM ingest_devices WHERE host=$1', [HOST]);
  await query('DELETE FROM usage_hosts WHERE slug=$1', [HOST]);
});

describe('verified file reads and selected dependencies', () => {
  it('rejects changed cached bytes until metadata is rescanned', async () => {
    const { f, service } = fixture();
    const old = (await service.current()).catalog.byName.get('report')![0]!;
    const body = skillMd('report', 'Changed report.', '', '# New verified instructions\n');
    write(join(f.vault, '.agents/skills/report/SKILL.md'), body);
    await expect(service.file('report', old.id, 'SKILL.md')).rejects.toThrow(/changed since the catalog scan/);
    const next = (await service.current(true)).catalog.byName.get('report')![0]!;
    expect(next.digest).not.toBe(old.digest);
    const file = await service.file('report', next.id, 'SKILL.md');
    expect(file?.content).toBe(body);
    expect(createHash('sha256').update(file!.content!).digest('hex')).toBe(next.packageFiles.find(f => f.path === 'SKILL.md')!.sha256);
    const detail = await service.detail('report');
    expect(detail?.selected?.digest).toBe(next.digest);
    expect(detail?.instructions).toContain('New verified instructions');
  });
  it('uses the dependency of a policy-pinned shadowed candidate', async () => {
    const { f, service } = fixture(`${POLICY}pins:\n  report: engine:report\n`);
    write(join(f.engine, 'report/SKILL.md'), skillMd('report', 'Pinned report.', 'metadata:\n  depends: [video]\n'));
    expect((await service.current()).catalog.byName.get('report')![0]!.metadata.depends).toEqual([]);
    const preview = await service.preview({ kind: 'remove', skill: 'video' });
    expect(preview.dependents).toContain('report');
    expect(preview.blocked.join(' ')).toMatch(/depend on video: report/);
    await expect(service.propose({ kind: 'remove', skill: 'video' })).rejects.toThrow(/depend on video/);
    expect((await service.detail('video'))?.dependents).toContain('report');
    write(join(f.vault, SETTINGS.policyFile), POLICY); service.invalidate();
    expect((await service.preview({ kind: 'remove', skill: 'video' })).blocked).toEqual([]);
  });
});

describe('removal requires operational observations', () => {
  it('fails closed offline or after failed reads while allowing offline draft work', async () => {
    const { f } = fixture();
    const offline = new SkillsService(f.vault, SETTINGS, { engineSkills: f.engine, db: false });
    await expect(offline.preview({ kind: 'remove', skill: 'video' })).rejects.toThrow(/acknowledgement state is unavailable/);
    await expect(offline.propose({ kind: 'remove', skill: 'video', resolve: true })).rejects.toThrow(/requires a database connection/);
    expect((await offline.createDraft('new-skill', undefined, 'Offline draft.')).validation.valid).toBe(true);
    const preview = await offline.preview({ kind: 'create', skill: 'new-skill', draft: 'new-skill' });
    expect(preview.validation.warnings.join(' ')).toMatch(/affected machines are unknown/);
    const failed = new SkillsService(f.vault, SETTINGS, { engineSkills: f.engine, observations: async () => { throw new Error('unavailable fixture'); } });
    await expect(failed.preview({ kind: 'remove', skill: 'video' })).rejects.toThrow(/could not be read/);
    await expect(failed.propose({ kind: 'remove', skill: 'video', resolve: true })).rejects.toThrow(/removal is refused/);
    expect(await failed.changes()).toEqual([]);
  });
  it('blocks CLI removal of a recorded deployment until revocation is explicitly resolved', async () => {
    const { f } = fixture('version: 1\nmode: managed\n');
    const service = new SkillsService(f.vault, SETTINGS, { engineSkills: f.engine });
    const state = await service.current(), video = state.catalog.byName.get('video')![0]!;
    const device = await addDevice(HOST, { display: 'Observation fixture', kind: 'server' });
    const payload: AckRequest = { v: 1, engine: null, policyDigest: state.policy.digest, views: [{
      agent: 'alpha', runtime: 'zen-agent', status: 'current', error: null, viewDigest: null, generatedAt: null,
      skills: [{ name: 'video', id: video.id, digest: video.digest! }], missing: [], dirty: [],
    }] };
    await recordAck({ id: device.id, host: HOST }, payload);
    const out: string[] = [], err: string[] = [];
    const io = { out: (s: string) => out.push(s), err: (s: string) => err.push(s), env: {} };
    expect(await runSkillsCli(['preview', 'remove', 'video'], service, io)).toBe(2);
    expect(out.join('\n')).toContain(`still deployed on ${HOST}/alpha/zen-agent`);
    expect(await runSkillsCli(['propose', 'remove', 'video'], service, io)).not.toBe(0);
    expect(err.join('\n')).toContain('still deployed');
    expect(await service.changes()).toEqual([]);
    const resolved = await service.preview({ kind: 'remove', skill: 'video', resolve: true });
    expect(resolved.blocked).toEqual([]);
    expect(resolved.affectedHosts).toContain(HOST);
    expect(resolved.runningSessions).toMatch(/machines are synced/);
  });
  it('rechecks operational availability before applying removal', async () => {
    const { f } = fixture('version: 1\nmode: managed\n'); let available = true;
    const service = new SkillsService(f.vault, SETTINGS, { engineSkills: f.engine, db: false,
      observations: async () => { if (!available) throw new Error('offline fixture'); return empty(); } });
    const change = await service.propose({ kind: 'remove', skill: 'video' }); available = false;
    await expect(service.apply(change.id)).rejects.toThrow(/removal is refused/);
  });
});

describe('detail and machines share status evaluation', () => {
  it.each(['current', 'policy', 'failed', 'dirty', 'stale', 'missing', 'invalid'] as const)('handles %s consistently', async scenario => {
    const { f, service: initial } = fixture(scenario === 'missing' ? `${POLICY}pins:\n  report: engine:report\n` : POLICY);
    const state = await initial.current(), report = selectedCandidate(state.policy.policy, state.catalog, 'report').candidate!;
    const at = new Date(Date.now() - (scenario === 'stale' ? 48 * 3600_000 : 0));
    const ack: AckRow = { host: HOST, agent: 'alpha', runtime: 'zen-agent', status: scenario === 'failed' ? 'failed' : scenario === 'dirty' ? 'dirty' : 'current',
      error: scenario === 'failed' ? 'Fixture sync failure' : null, view_digest: null, policy_digest: state.policy.digest, generated_at: at, received_at: at,
      skills: [{ name: 'report', id: report.id, digest: report.digest! }], missing: [], dirty: scenario === 'dirty' ? ['report'] : [] };
    if (scenario === 'policy') write(join(f.vault, SETTINGS.policyFile), `${POLICY}agents:\n  alpha:\n    deny: [video]\n`);
    if (scenario === 'invalid') write(join(f.vault, '.agents/skills/report/SKILL.md'), '---\nname: report\n---\nInvalid without description.');
    if (scenario === 'missing') {
      rmSync(join(f.engine, 'report'), { recursive: true });
    }
    const data = { acks: [ack], hosts: [{ slug: HOST, display: HOST }], lastSeen: new Map([[HOST, at]]) };
    const service = new SkillsService(f.vault, SETTINGS, { engineSkills: f.engine, db: false, observations: async () => data });
    const machine = (await service.machines()).hosts[0]!.views[0]!;
    const detail = (await service.detail('report'))!.hosts[0]!;
    expect(detail.viewStatus).toBe(machine.status);
    expect(machine.status).toBe(scenario === 'policy' ? 'drift' : scenario === 'missing' || scenario === 'invalid' ? 'failed' : scenario);
    if (scenario === 'missing' || scenario === 'invalid') {
      expect(machine.excluded?.some(x => x.name === 'report')).toBe(true);
      expect(machine.error).toMatch(/report/);
    }
    expect(detail.state).toBe(machine.status === 'current' ? 'match' : machine.status === 'drift' ? 'drift' : 'unknown');
    if (scenario !== 'current') expect(detail.state).not.toBe('match');
  });
});
