import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, symlinkSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SkillsService } from '../src/addons/skills/service.js';
import { planViews, readCurrent, syncViews } from '../src/addons/skills/reconcile.js';
import { assertPolicyReviewed, markPolicyReviewed, policySnapshot, type PolicyApprovalProvider, type PolicyProvenance } from '../src/addons/skills/policy-review.js';
import { parsePolicy } from '../src/addons/skills/policy.js';
import type { ReviewReceipt } from '../src/addons/skills/lifecycle.js';
import { query } from '../src/db.js';
import { SETTINGS, sh, skillsFixture, write } from './helpers/skills.js';

const POLICY = 'version: 1\nmode: managed\norg:\n  grant: [report]\n';
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
function fixture(db = false) {
  const f = skillsFixture(); write(join(f.vault, SETTINGS.policyFile), POLICY);
  sh(f.vault, 'add', SETTINGS.policyFile); sh(f.vault, 'commit', '-qm', 'Initial managed policy');
  sh(f.vault, 'remote', 'add', 'origin', 'https://github.com/fixture-org/fixture-vault.git');
  sh(f.vault, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  sh(f.vault, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const approvals: PolicyProvenance[] = [], reviews: ReviewReceipt[] = [];
  const provider: PolicyApprovalProvider = { read: async () => approvals.slice(-1), write: async receipt => { approvals.push({ ...receipt }); } };
  const service = new SkillsService(f.vault, SETTINGS, { engineSkills: f.engine, db, policyApprovals: db ? undefined : provider, reviewReceipts: async () => reviews });
  return { f, service, approvals, reviews, provider, revision: sh(f.vault, 'rev-parse', 'HEAD') };
}
async function approve(f: ReturnType<typeof fixture>) {
  const state = await f.service.current(true);
  return f.service.approvePolicy({ digest: state.policy.digest!, revision: sh(f.f.vault, 'log', '-1', '--format=%H', '--', SETTINGS.policyFile), source: 'owner-session', approvedBy: 'owner' });
}

it('requires exact owner approval and retains it through unrelated default-branch commits', async () => {
  const f = fixture(); await expect(f.service.reviewedPolicy()).rejects.toThrow(/no current accepted review/);
  const receipt = await approve(f); expect(receipt.revision).toBe(f.revision);
  const state = await f.service.reviewedPolicy(); expect(() => assertPolicyReviewed(state.policy)).not.toThrow();
  write(join(f.f.vault, 'Notes/note.md'), 'An unrelated note'); sh(f.f.vault, 'add', 'Notes/note.md'); sh(f.f.vault, 'commit', '-qm', 'Autosync note');
  sh(f.f.vault, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  expect((await f.service.reviewedPolicy()).policy.digest).toBe(receipt.digest);
  const status = (await f.service.library(true)).policy; expect(status.reviewed).toBe(true); expect(status.approval?.revision).toBe(f.revision);
});
it('binds authorization to the exact parsed object, bytes, schema and 60-second lifetime', () => {
  const policy = parsePolicy(POLICY), provenance = { repo: 'fixture-org/fixture-vault', path: SETTINGS.policyFile, revision: 'a'.repeat(40), digest: policy.digest!, source: 'test', approvedBy: 'owner' };
  markPolicyReviewed(policy, provenance); expect(() => assertPolicyReviewed(policy)).not.toThrow();
  expect(() => assertPolicyReviewed({ ...policy })).toThrow(/no approval/);
  policy.policy.org.grant.push('clip'); expect(() => assertPolicyReviewed(policy)).toThrow(/changed/);
  const clean = parsePolicy(POLICY); markPolicyReviewed(clean, provenance); vi.useFakeTimers(); vi.setSystemTime(Date.now() + 60_001);
  expect(() => assertPolicyReviewed(clean)).toThrow(/no approval/);
  expect(() => markPolicyReviewed(parsePolicy(POLICY), { ...provenance, digest: `sha256:${'b'.repeat(64)}` })).toThrow(/Invalid/);
});
it.each(['dirty', 'ignored', 'symlink', 'ancestor-link', 'wrong-tip'] as const)('refuses %s policy before saving an approval', async kind => {
  const f = fixture(), path = join(f.f.vault, SETTINGS.policyFile);
  if (kind === 'dirty') write(path, POLICY.replace('[report]', '[report, clip]'));
  if (kind === 'ignored') { sh(f.f.vault, 'rm', '--cached', SETTINGS.policyFile); write(join(f.f.vault, '.gitignore'), `/${SETTINGS.policyFile}\n`); sh(f.f.vault, 'add', '.gitignore'); sh(f.f.vault, 'commit', '-qm', 'Ignore policy'); sh(f.f.vault, 'update-ref', 'refs/remotes/origin/main', 'HEAD'); }
  if (kind === 'symlink') { const target = join(f.f.base, 'outside-policy.yaml'); write(target, POLICY); rmSync(path); symlinkSync(target, path); }
  if (kind === 'ancestor-link') { const target = join(f.f.base, 'policy-parent'); write(join(target, 'policy.yaml'), POLICY); symlinkSync(target, join(f.f.vault, 'policy-link')); }
  if (kind === 'wrong-tip') { write(join(f.f.vault, 'Notes/note.md'), 'Ahead of origin'); sh(f.f.vault, 'add', 'Notes/note.md'); sh(f.f.vault, 'commit', '-qm', 'Unpublished note'); }
  const service = kind === 'ancestor-link' ? new SkillsService(f.f.vault, { ...SETTINGS, policyFile: 'policy-link/policy.yaml' }, { engineSkills: f.f.engine, db: false, policyApprovals: f.provider }) : f.service;
  const policy = (await service.current(true)).policy;
  await expect(service.approvePolicy({ digest: policy.digest!, revision: f.revision, source: 'owner-session', approvedBy: 'owner' })).rejects.toThrow(/clean|tracked|regular|symlinks|tip/);
  expect(f.approvals).toEqual([]);
});
it('rejects approval of a stale digest or revision', async () => {
  const f = fixture(), policy = (await f.service.current()).policy;
  await expect(f.service.approvePolicy({ digest: `sha256:${'0'.repeat(64)}`, revision: f.revision, source: 'owner', approvedBy: 'owner' })).rejects.toThrow(/changed since/);
  await expect(f.service.approvePolicy({ digest: policy.digest!, revision: 'f'.repeat(40), source: 'owner', approvedBy: 'owner' })).rejects.toThrow(/changed since/);
  expect(f.approvals).toEqual([]);
});
it('accepts exact merged review evidence and refuses foreign or mismatched evidence', async () => {
  const f = fixture();
  f.reviews.push({ repo: 'other-org/other-vault', branch: 'main', head: f.revision, merged: f.revision });
  await expect(f.service.reviewedPolicy()).rejects.toThrow(/no current/);
  f.reviews[0]!.repo = 'fixture-org/fixture-vault'; f.reviews[0]!.branch = 'other';
  await expect(f.service.reviewedPolicy()).rejects.toThrow(/no current/);
  f.reviews[0]!.branch = 'main'; expect(() => assertPolicyReviewed(({} as never))).toThrow();
  expect((await f.service.reviewedPolicy()).policy.digest).toBe(parsePolicy(POLICY).digest);
  write(join(f.f.vault, SETTINGS.policyFile), POLICY.replace('[report]', '[clip]')); sh(f.f.vault, 'add', SETTINGS.policyFile); sh(f.f.vault, 'commit', '-qm', 'Different policy'); sh(f.f.vault, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  await expect(f.service.reviewedPolicy()).rejects.toThrow(/no current/);
});
it('does not replay an older owner approval after a newer approval supersedes the path', async () => {
  const f = fixture(); await approve(f);
  write(join(f.f.vault, SETTINGS.policyFile), POLICY.replace('[report]', '[clip]')); sh(f.f.vault, 'add', SETTINGS.policyFile); sh(f.f.vault, 'commit', '-qm', 'Superseding policy'); sh(f.f.vault, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  await approve(f); expect(f.approvals).toHaveLength(2);
  sh(f.f.vault, 'reset', '--hard', f.revision); sh(f.f.vault, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  f.reviews.push({ repo: 'fixture-org/fixture-vault', branch: 'main', head: f.revision, merged: f.revision });
  await expect(f.service.reviewedPolicy()).rejects.toThrow(/superseded policy/);
});
it('fails closed when the approval store is unavailable', async () => {
  const f = fixture(); f.provider.read = async () => { throw new Error('approval store unavailable'); };
  await expect(f.service.reviewedPolicy()).rejects.toMatchObject({ status: 503 });
});
it('persists only exact operational approval metadata and grants no writes to agents or PUBLIC', async () => {
  const f = fixture(true); const receipt = await approve(f);
  expect((await f.service.reviewedPolicy()).policy.digest).toBe(receipt.digest);
  const rows = await query('SELECT repo,path,revision,digest,source,approved_by FROM skill_policy_approvals WHERE repo=$1 AND path=$2 AND revision=$3', [receipt.repo, receipt.path, receipt.revision]);
  expect(rows.rows[0]).toMatchObject({ repo: receipt.repo, path: receipt.path, revision: receipt.revision, digest: receipt.digest, source: 'owner-session', approved_by: 'owner' });
  const rights = await query<{ name: string; allowed: boolean }>(`SELECT rolname AS name, has_table_privilege(oid,'skill_policy_approvals','INSERT,UPDATE,DELETE,TRUNCATE') AS allowed FROM pg_roles WHERE rolname IN ('sb_agent','sb_org')`);
  expect(rights.rows.some(row => row.name === 'sb_org')).toBe(true);
  expect(rights.rows.every(row => !row.allowed)).toBe(true);
  const publicWrites = await query(`SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name='skill_policy_approvals' AND grantee='PUBLIC' AND privilege_type <> 'SELECT'`);
  expect(publicWrites.rows).toEqual([]);
});
it.each(['compiled-team', 'source-team', 'ignored-source'] as const)('blocks %s roster edits under an approved policy', async kind => {
  const f = fixture(); await approve(f); await f.service.reviewedPolicy();
  if (kind === 'compiled-team') {
    const path = join(f.f.vault, '.agents/org/org.json'), doc = JSON.parse(readFileSync(path, 'utf8')); doc.agents.alpha.team = 'eng'; write(path, JSON.stringify(doc));
  } else if (kind === 'source-team') write(join(f.f.vault, '.agents/org/config/agents/alpha.yaml'), 'runtime: hermes\nteam: eng\n');
  else {
    write(join(f.f.vault, '.gitignore'), '/.agents/org/config/agents/local.yaml\n'); sh(f.f.vault, 'add', '.gitignore'); sh(f.f.vault, 'commit', '-qm', 'Ignore local source'); sh(f.f.vault, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    write(join(f.f.vault, '.agents/org/config/agents/local.yaml'), 'runtime: zen-agent\nteam: eng\n');
  }
  await expect(f.service.reviewedPolicy()).rejects.toThrow(/Roster authorization source/);
});

it('keeps failed Git status unknown and refuses policy authorization', async () => {
  const f = fixture(); await approve(f);
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), shim = join(f.f.base, 'git-shim');
  write(join(shim, 'git'), `#!/bin/sh\nfor arg in "$@"; do\nif [ "$arg" = "status" ]; then exit 73; fi\ndone\nexec '${realGit.replace(/'/g, `'\\''`)}' "$@"\n`, 0o755);
  vi.stubEnv('PATH', `${shim}${delimiter}${process.env.PATH ?? ''}`);
  const policy = (await f.service.current(true)).policy;
  await expect(policySnapshot(f.f.vault, f.service.policyPath, policy)).rejects.toThrow(/state is unknown/);
  await expect(f.service.reviewedPolicy()).rejects.toThrow(/state is unknown/);
});
it('rejects cached roster data parsed from dirty bytes even after the files are restored', async () => {
  const f = fixture(); await approve(f);
  const path = join(f.f.vault, '.agents/org/org.json'), original = readFileSync(path, 'utf8'), changed = JSON.parse(original);
  changed.agents.alpha.team = 'eng'; write(path, JSON.stringify(changed));
  const dirtyState = await f.service.current(true); write(path, original);
  vi.spyOn(f.service, 'current').mockResolvedValue(dirtyState);
  await expect(f.service.reviewedPolicy()).rejects.toThrow(/changed while loading/);
  expect(() => assertPolicyReviewed(dirtyState.policy)).toThrow(/no approval/);
});
it('accepts a clean committed roster update under the same owner policy baseline', async () => {
  const f = fixture(); const receipt = await approve(f);
  const path = join(f.f.vault, '.agents/org/org.json'), changed = JSON.parse(readFileSync(path, 'utf8'));
  changed.agents.alpha.team = 'eng'; write(path, JSON.stringify(changed));
  sh(f.f.vault, 'add', '.agents/org/org.json'); sh(f.f.vault, 'commit', '-qm', 'Commit roster team assignment'); sh(f.f.vault, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const state = await f.service.reviewedPolicy(); expect(state.roster.agents.find(agent => agent.name === 'alpha')!.team).toBe('eng');
  expect(state.policy.digest).toBe(receipt.digest);
});

it('keeps the prior active view when a local team edit would add a granted skill', async () => {
  const f = fixture(), path = join(f.f.vault, SETTINGS.policyFile);
  write(path, POLICY + 'teams:\n  eng:\n    grant: [clip]\n');
  sh(f.f.vault, 'add', SETTINGS.policyFile); sh(f.f.vault, 'commit', '-qm', 'Team-scoped policy'); sh(f.f.vault, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  await approve(f); const state = await f.service.reviewedPolicy(), root = join(f.f.base, 'managed');
  const plan = planViews(state.catalog, state.policy, state.roster, { agents: ['alpha'] });
  expect(syncViews(root, plan).views[0]!.status).toBe('current');
  const before = readCurrent(root, 'alpha', 'zen-agent'); expect(before.manifest!.skills.map(skill => skill.name)).toEqual(['report']);
  const rosterPath = join(f.f.vault, '.agents/org/org.json'), doc = JSON.parse(readFileSync(rosterPath, 'utf8')); doc.agents.alpha.team = 'eng'; write(rosterPath, JSON.stringify(doc));
  await expect(f.service.reviewedPolicy()).rejects.toThrow(/Roster authorization sources have uncommitted changes/);
  const after = readCurrent(root, 'alpha', 'zen-agent'); expect(after.dir).toBe(before.dir); expect(after.manifest).toEqual(before.manifest);
});
