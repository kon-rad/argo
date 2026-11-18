import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runSkillsCli } from '../src/addons/skills/cli.js';
import { machineStates, type AckRow } from '../src/addons/skills/machines.js';
import { ackPayload, inspectRoot, packBundle, planFromBundle, planViews, readCurrent, sendAck, syncViews, verifyView } from '../src/addons/skills/reconcile.js';
import { SkillsService } from '../src/addons/skills/service.js';
import { MANAGED_POLICY, SETTINGS, sh, skillMd, skillsFixture, write } from './helpers/skills.js';

async function fixture(policy = MANAGED_POLICY) {
  const f = skillsFixture();
  write(join(f.vault, SETTINGS.policyFile), policy);
  const service = new SkillsService(f.vault, SETTINGS, { engineSkills: f.engine, db: false, observations: async () => ({ acks: [], hosts: [], lastSeen: new Map() }) });
  const state = await service.current();
  const plan = planViews(state.catalog, state.policy, state.roster, { agents: ['alpha'] });
  return { f, service, plan, root: join(f.base, 'managed') };
}

describe('Vera review: skills transport and lifecycle', () => {
  it.each(['node_modules/credentials.json', '__pycache__/hidden.txt', '.git/extra'])('refuses unhashed bundle member %s before changing an existing view', async (path) => {
    const { plan, root } = await fixture();
    syncViews(root, plan, { env: { PATH: '' } });
    const before = readCurrent(root, 'alpha', 'zen-agent').dir;
    const bundle = packBundle(plan);
    const pkg = Object.values(bundle.packages)[0]!;
    pkg.files.push({ path, exec: false, data: Buffer.from('synthetic-only').toString('base64') });
    expect(() => planFromBundle(bundle)).toThrow(/ignored|credential|unsafe/);
    expect(readCurrent(root, 'alpha', 'zen-agent').dir).toBe(before);
    expect(verifyView(root, 'alpha', 'zen-agent').dirty).toEqual([]);
  });

  it('treats an ignored file added to a stored deployment as dirt', async () => {
    const { plan, root } = await fixture();
    syncViews(root, plan, { env: { PATH: '' } });
    const store = join(root, 'store', plan.views[0]!.skills[0]!.digest.slice(7));
    chmodSync(store, 0o755);
    write(join(store, 'node_modules', 'extra.txt'), 'not in the approved package');
    expect(verifyView(root, 'alpha', 'zen-agent').dirty.length).toBeGreaterThan(0);
  });

  it('never transmits a device token to a non-loopback HTTP destination', async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response('{}', { status: 200 }));
    const payload = { v: 1 as const, engine: null, policyDigest: null, views: [] };
    await expect(sendAck('http://brain.example.com', 'synthetic-token', payload, fetch)).rejects.toThrow(/HTTPS|https/);
    expect(fetch).not.toHaveBeenCalled();
    await expect(sendAck('https://brain.example.com', 'synthetic-token', payload, fetch)).resolves.toMatchObject({ ok: true });
    expect(fetch.mock.calls[0]![1]).toMatchObject({ redirect: 'error' });
    await expect(sendAck('http://127.0.0.1:1234', 'synthetic-token', payload, fetch)).resolves.toMatchObject({ ok: true });
  });

  it('refuses unhashed files introduced during staging and keeps the prior generation', async () => {
    const { f, service, plan, root } = await fixture();
    syncViews(root, plan, { env: { PATH: '' } });
    const before = readCurrent(root, 'alpha', 'zen-agent').dir;
    write(join(f.vault, '.agents', 'skills', 'report', 'SKILL.md'), skillMd('report', 'Updated report.'));
    service.invalidate();
    const state = await service.current();
    const next = planViews(state.catalog, state.policy, state.roster, { agents: ['alpha'] });
    const result = syncViews(root, next, { env: { PATH: '' }, hooks: {
      afterStage: (_digest, dir) => write(join(dir, 'node_modules', 'credentials.json'), 'synthetic-only'),
    } });
    expect(result.views[0]!.status).toBe('failed');
    expect(readCurrent(root, 'alpha', 'zen-agent').dir).toBe(before);
    expect(verifyView(root, 'alpha', 'zen-agent').dirty).toEqual([]);
  });

  it('refuses a stale create after a newer package occupies its destination', async () => {
    const { f, service } = await fixture();
    await service.createDraft('new-skill', undefined, 'Proposed skill.');
    const change = await service.propose({ kind: 'create', skill: 'new-skill', draft: 'new-skill' });
    const target = join(f.vault, '.agents', 'skills', 'new-skill', 'SKILL.md');
    const newer = skillMd('new-skill', 'Newer owner package.', '', '# Preserve me');
    write(target, newer);
    sh(f.vault, 'add', '.agents/skills/new-skill');
    sh(f.vault, 'commit', '-q', '-m', 'newer package');
    await expect(service.apply(change.id)).rejects.toThrow(/stale|exists|occupied/);
    expect(readFileSync(target, 'utf8')).toBe(newer);
    expect(sh(f.vault, 'show', 'HEAD:.agents/skills/new-skill/SKILL.md')).toBe(newer.trim());
  });

  it.each(['org', 'team', 'agent'])('blocks removal under a %s wildcard until explicitly resolved', async (scope) => {
    const wildcard = scope === 'org' ? 'org:\n  grant: ["*"]\n' : scope === 'team' ? 'teams:\n  media:\n    grant: ["*"]\n' : 'agents:\n  alpha:\n    grant: ["*"]\n';
    const { service } = await fixture(`version: 1\nmode: managed\n${wildcard}`);
    const before = await service.preview({ kind: 'remove', skill: 'video' });
    expect(before.blocked.join(' ')).toMatch(/still granted/);
    await expect(service.propose({ kind: 'remove', skill: 'video' })).rejects.toThrow(/not exported/);
    const resolved = await service.preview({ kind: 'remove', skill: 'video', resolve: true });
    expect(resolved.blocked).toEqual([]);
    expect(resolved.policyDiff).toMatch(/deny:.*video|deny:[\s\S]*video/);
    expect(resolved.policyDiff).toMatch(/status: removed/);
  });

  it('standalone acknowledgements retain missing prerequisites until they are fixed', async () => {
    const { service, plan, root } = await fixture();
    const first = syncViews(root, plan, { env: { PATH: '' } });
    expect(first.views[0]!.missing[0]!.env).toContain('FIXTURE_CLIP_KEY');
    const fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const io = { out: (_s: string) => {}, err: (_s: string) => {}, env: { PATH: '', SB_LEDGER_TOKEN: 'synthetic-token' }, fetch };
    expect(await runSkillsCli(['ack', '--root', root, '--server', 'https://brain.example.com'], service, io)).toBe(0);
    const body = JSON.parse(fetch.mock.calls[0]![1].body);
    expect(body.views[0].missing[0].env).toContain('FIXTURE_CLIP_KEY');
    expect(inspectRoot(root, { PATH: '', FIXTURE_CLIP_KEY: 'synthetic' })[0]!.missing[0]!.env).toEqual([]);
  });
});

it('reports policy drift even when the acknowledged package digests still match, including new hosts', () => {
  const now = new Date();
  const digest = `sha256:${'a'.repeat(64)}`;
  const row: AckRow = { host: 'new-host', agent: 'alpha', runtime: 'codex', status: 'current', error: null,
    view_digest: digest, policy_digest: `sha256:${'b'.repeat(64)}`, generated_at: now, received_at: now,
    skills: [{ name: 'report', id: 'private:report', digest }], missing: [], dirty: [] };
  const data = { acks: [row], hosts: [{ slug: 'new-host', display: 'New host' }], lastSeen: new Map([['new-host', now]]) };
  const desired = () => new Map([['report', digest]]);
  const hosts = machineStates(data, desired, 24, now, `sha256:${'c'.repeat(64)}`);
  expect(hosts[0]!.status).toBe('drift');
  expect(hosts[0]!.views[0]!.error).toMatch(/policy/i);
  expect(machineStates(data, desired, 24, now, row.policy_digest)[0]!.status).toBe('current');
  expect(machineStates({ ...data, hosts: [] }, desired, 24, now, row.policy_digest)[0]!.host).toBe('new-host');
});

it('binds an exported draft to the digest that was previewed', async () => {
  const {service} = await fixture();
  await service.createDraft('report', 'report');
  const preview = await service.preview({kind: 'update', skill: 'report', draft: 'report'});
  await service.writeDraftFile('report', 'SKILL.md', skillMd('report', 'Changed after preview.'), undefined, (await service.readDraftFile('report', 'SKILL.md')).version);
  await expect(service.propose({kind: 'update', skill: 'report', draft: 'report', expectedDraftDigest: preview.targetDigest!})).rejects.toThrow(/changed after preview/);
  expect(await service.changes()).toEqual([]);
  const next = await service.preview({kind: 'update', skill: 'report', draft: 'report'});
  const change = await service.propose({kind: 'update', skill: 'report', draft: 'report', expectedDraftDigest: next.targetDigest!});
  expect(change.preview.targetDigest).toBe(next.targetDigest);
});
it.each(['node_modules/helper.js', 'cache.pyc'])('explicitly refuses ignored draft content: %s', async path => {
  const {f,service} = await fixture(); await service.createDraft('report', 'report');
  await expect(service.writeDraftFile('report', path, 'ignored')).rejects.toThrow(/ignored/);
  write(join(f.vault, SETTINGS.draftsDir, 'report', path), 'previously saved ignored content');
  const draft = await service.draft('report'); expect(draft.validation.valid).toBe(false);
  expect(draft.validation.errors.join(' ')).toMatch(/ignored/);
  await expect(service.propose({kind: 'update', skill: 'report', draft: 'report'})).rejects.toThrow(/does not validate/);
});
it('fails acknowledgement explicitly when 65 deployed views exceed the protocol limit', async () => {
  const {plan,root}=await fixture();
  plan.views=Array.from({length:65}, (_,i)=>({...plan.views[0]!,agent:`agent-${i}`}));
  const report=syncViews(root,plan,{env:{PATH:''}});
  expect(report.views).toHaveLength(65); expect(report.views.every(v=>v.status==='current')).toBe(true);
  expect(()=>ackPayload(report,null)).toThrow(/65 views.*64/);
});

it('refuses a policy action when its source policy changed after the inspected preview',async()=>{
 const {f,service}=await fixture();
 const request={kind:'disable' as const,skill:'report'};
 const preview=await service.preview(request);expect(preview.fingerprint).toMatch(/^sha256:/);
 write(join(f.vault,SETTINGS.policyFile),MANAGED_POLICY.replace('grant: [report]','grant: [report, ingest]'));
 await expect(service.propose({...request,expectedPreviewDigest:preview.fingerprint})).rejects.toThrow(/changed after preview/);
 expect(await service.changes()).toEqual([]);
 const fresh=await service.preview(request);
 const change=await service.propose({...request,expectedPreviewDigest:fresh.fingerprint});
 expect(change.preview.fingerprint).toBe(fresh.fingerprint);
});
