import { existsSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { markPolicyReviewed } from '../src/addons/skills/policy-review.js';
import { authorizeRemotePlan, packBundle, planFingerprint, planFromBundle, planViews, proposeViews, syncViews, type Plan } from '../src/addons/skills/reconcile.js';
import { SkillsService } from '../src/addons/skills/service.js';
import { SETTINGS, sh, skillsFixture, write } from './helpers/skills.js';

afterEach(() => vi.useRealTimers());
async function fixture() {
  const f = skillsFixture();
  write(join(f.vault, SETTINGS.policyFile), 'version: 1\nmode: managed\norg: {grant: [report]}\n');
  sh(f.vault, 'add', SETTINGS.policyFile); sh(f.vault, 'commit', '-qm', 'Committed policy fixture');
  const service = new SkillsService(f.vault, SETTINGS, { engineSkills: f.engine, db: false });
  const state = await service.current();
  return { f, state, root: join(f.base, 'managed'), proposal: () => proposeViews(state.catalog, state.policy, state.roster, { agents: ['alpha'] }) };
}
function trustedResponse(plan: Plan): typeof fetch {
  // Test-only server authority. Production gets this response from its authenticated HTTPS origin.
  return vi.fn(async () => new Response(JSON.stringify({ policyDigest: plan.policyDigest, fingerprint: planFingerprint(plan) }))) as unknown as typeof fetch;
}

it('keeps proposals and deserialized bundles untrusted until exact server authorization', async () => {
  const { state, root, proposal } = await fixture();
  expect(() => planViews(state.catalog, state.policy, state.roster, { agents: ['alpha'] })).toThrow(/no approval/);
  const plan = proposal();
  expect(() => packBundle(plan)).toThrow(/no current accepted policy review/);
  expect(() => syncViews(root, plan)).toThrow(/no current accepted policy review/);
  expect(existsSync(root)).toBe(false);
  await authorizeRemotePlan(plan, 'https://skills.test', 'fixture-token', trustedResponse(plan));
  const bundle = { ...packBundle(plan), authorized: true, reviewed: true };
  const restored = planFromBundle(bundle);
  expect(() => syncViews(root, restored)).toThrow(/no current accepted policy review/);
  await authorizeRemotePlan(restored, 'https://skills.test', 'fixture-token', trustedResponse(plan));
  expect(syncViews(root, restored).views[0]!.status).toBe('current');
});

it('binds every runtime manifest field and refuses post-authorization mutation before filesystem writes', async () => {
  const { root, proposal } = await fixture(), plan = proposal();
  await authorizeRemotePlan(plan, 'https://skills.test', 'fixture-token', trustedResponse(plan));
  plan.views[0]!.skills[0]!.id = 'private:substituted';
  expect(() => syncViews(root, plan)).toThrow(/modified after authorization/);
  expect(existsSync(root)).toBe(false);
});

it('leaves an existing view active when the server rejects changed grants or is unreachable', async () => {
  const { root, proposal } = await fixture(), plan = proposal();
  await authorizeRemotePlan(plan, 'https://skills.test', 'fixture-token', trustedResponse(plan));
  syncViews(root, plan);
  const active = join(root, 'views/alpha/zen-agent'), before = readlinkSync(active), changed = proposal();
  changed.views[0]!.skills = [];
  await expect(authorizeRemotePlan(changed, 'https://skills.test', 'fixture-token', async () => new Response('{}', { status: 409 }))).rejects.toThrow(/HTTP 409/);
  expect(() => syncViews(root, changed)).toThrow(/no current accepted policy review/);
  expect(readlinkSync(active)).toBe(before);
  await expect(authorizeRemotePlan(changed, 'https://skills.test', 'fixture-token', async () => { throw new Error('offline'); })).rejects.toThrow(/unavailable/);
  expect(readlinkSync(active)).toBe(before);
  // A failed recheck also revokes this object's earlier in-process authorization.
  await expect(authorizeRemotePlan(plan, 'https://skills.test', 'fixture-token', async () => new Response('{}', { status: 409 }))).rejects.toThrow(/HTTP 409/);
  expect(() => syncViews(root, plan)).toThrow(/no current accepted policy review/);
  expect(readlinkSync(active)).toBe(before);
});

it('rejects HTTP, redirect-shaped origins and mismatched protocol responses', async () => {
  const { proposal } = await fixture(), plan = proposal(), fetcher = trustedResponse(plan);
  for (const url of ['http://skills.test', 'https://user:password@skills.test', 'https://skills.test/path', 'https://skills.test/?next=elsewhere']) // public-ok: invalid credentials on a reserved .test host
    await expect(authorizeRemotePlan(plan, url, 'fixture-token', fetcher)).rejects.toThrow(/HTTPS/);
  expect(fetcher).not.toHaveBeenCalled();
  await expect(authorizeRemotePlan(plan, 'https://skills.test', 'fixture-token', async () => new Response(JSON.stringify({ policyDigest: plan.policyDigest, fingerprint: `sha256:${'0'.repeat(64)}` })))).rejects.toThrow(/does not match/);
  await authorizeRemotePlan(plan, 'https://skills.test', 'fixture-token', fetcher);
  expect(fetcher).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ redirect: 'error', credentials: 'omit', method: 'POST' }));
});

it('expires authorizations and invalidates exact policy capabilities after an in-memory grant edit', async () => {
  const { f, state, proposal, root } = await fixture(), plan = proposal();
  markPolicyReviewed(state.policy, { repo: 'fixture/vault', path: SETTINGS.policyFile, revision: sh(f.vault, 'rev-parse', 'HEAD'), digest: state.policy.digest!, source: 'fixture-owner-review', approvedBy: 'fixture-owner' });
  expect(planViews(state.catalog, state.policy, state.roster, { agents: ['alpha'] }).views).toHaveLength(1);
  state.policy.policy.org.grant.push('clip');
  expect(() => planViews(state.catalog, state.policy, state.roster, { agents: ['alpha'] })).toThrow(/changed|approval/);
  await authorizeRemotePlan(plan, 'https://skills.test', 'fixture-token', trustedResponse(plan));
  vi.useFakeTimers(); vi.setSystemTime(Date.now() + 60_001);
  expect(() => syncViews(root, plan)).toThrow(/no current accepted policy review/);
  expect(existsSync(root)).toBe(false);
});

it('refuses ignored package members and unknown Git provenance before proposing deployment', async () => {
  const { f, state, proposal } = await fixture();
  state.catalog.byName.get('report')![0]!.dirty = true;
  expect(proposal).toThrow(/dirty, untracked, or has unknown Git provenance/);
  state.catalog.byName.get('report')![0]!.dirty = null;
  state.catalog.byName.get('report')![0]!.tracked = null;
  expect(proposal).toThrow(/unknown Git provenance/);
  expect(existsSync(join(f.base, 'managed'))).toBe(false);
});
