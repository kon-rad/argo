import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runSkillsCli } from '../src/addons/skills/cli.js';
import { scanPackage } from '../src/addons/skills/package.js';
import { packBundle, planFromBundle, planViews, ReconcileError, syncViews, verifyView } from '../src/addons/skills/reconcile.js';
import { SkillsService } from '../src/addons/skills/service.js';
import { MANAGED_POLICY, SETTINGS, sh, skillMd, skillsFixture, write } from './helpers/skills.js';

const svc = (vault: string, engine: string | null) => new SkillsService(vault, SETTINGS, { engineSkills: engine, db: false, observations: async () => ({ acks: [], hosts: [], lastSeen: new Map() }) });
const policy = (vault: string, text: string) => write(join(vault, '.agents', 'skills-policy.yaml'), text);

describe('skills catalog', () => {
  it('lists every candidate, keeps private precedence, flags overrides and duplicates, and treats a link-skills link as the same package', async () => {
    const f = skillsFixture();
    const lib = await svc(f.vault, f.engine).library();
    const report = lib.skills.find((s) => s.name === 'report')!;
    expect(report.candidates.map((c) => c.id)).toEqual(['private:report', 'engine:report', 'legacy:media/report']);
    expect(report.effective!.id).toBe('private:report');
    expect(report.candidates[1]!.shadowedBy).toBe('private:report');
    expect(report.flags).toMatchObject({ override: true, duplicate: true, invalid: false });
    const ingest = lib.skills.find((s) => s.name === 'ingest')!;
    expect(ingest.candidates.map((c) => [c.id, c.linkOf])).toEqual([['private:ingest', 'engine:ingest'], ['engine:ingest', null]]);
    expect(ingest.flags.override).toBe(false);
    expect(ingest.flags.duplicate).toBe(false);
    expect(lib.skills.find((s) => s.name === 'video')!.effective!.id).toBe('legacy:media/video');
    expect(lib.mode).toBe('legacy');
    expect(lib.policy.exists).toBe(false);
    // Source revision and full digest shown together.
    expect(report.effective!.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(report.effective!.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(report.effective!.dirty).toBe(false);
  });

  it('reports malformed metadata, escaping symlinks, secret files and package links outside the roots as invalid without reading them', async () => {
    const f = skillsFixture();
    const lib = await svc(f.vault, f.engine).library();
    const errs = (n: string) => lib.skills.find((s) => s.name === n)!.effective!.errors.join(' | ');
    expect(errs('broken')).toMatch(/no description/);
    expect(errs('bad-yaml')).toMatch(/frontmatter YAML/);
    expect(errs('leaky')).toMatch(/symlink escapes package: notes.txt/);
    expect(errs('creds')).toMatch(/secret-like file \.env/);
    expect(errs('outside')).toMatch(/outside the configured skill roots/);
    for (const n of ['broken', 'leaky', 'creds', 'outside']) expect(lib.skills.find((s) => s.name === n)!.flags.invalid).toBe(true);
    // The escaping file is never offered for reading.
    expect(await svc(f.vault, f.engine).file('leaky', undefined, 'notes.txt')).toBeNull();
    expect(await svc(f.vault, f.engine).file('report', undefined, '../../../outside/secret.txt')).toBeNull();
  });

  it('digests the full package: a script edit changes identity and Git marks it dirty; the digest matches the zen-agent vector', async () => {
    const f = skillsFixture();
    const before = (await svc(f.vault, f.engine).library()).skills.find((s) => s.name === 'clip')!.effective!;
    writeFileSync(join(f.vault, '.agents', 'skills', 'clip', 'scripts', 'cut.sh'), '#!/bin/sh\necho changed\n');
    const after = (await svc(f.vault, f.engine).library()).skills.find((s) => s.name === 'clip')!.effective!;
    expect(after.digest).not.toBe(before.digest);
    expect(after.dirty).toBe(true);
    expect(after.revision).toBe(before.revision);
    chmodSync(join(f.vault, '.agents', 'skills', 'clip', 'scripts', 'cut.sh'), 0o644);
    expect((await svc(f.vault, f.engine).library()).skills.find((s) => s.name === 'clip')!.effective!.digest).not.toBe(after.digest); // the exec bit counts
    const vec = mkdtempSync(join(tmpdir(), 'sb-vec-'));
    write(join(vec, 'SKILL.md'), '---\nname: vector\ndescription: Digest test vector.\n---\n\n# vector\n\nRun scripts/run.sh.\n');
    write(join(vec, 'scripts', 'run.sh'), '#!/bin/sh\necho vector\n', 0o755);
    const scan = scanPackage(vec);
    expect(scan.ok && scan.digest).toBe('sha256:66478e2630a89efdfb38a87df8c60158430330223f330ff2f322d485990e447c');
  });

  it('serves package files only from the scanned list, text bounded and binary flagged', async () => {
    const f = skillsFixture();
    write(join(f.vault, '.agents', 'skills', 'report', 'assets', 'logo.bin'), '\0\x01binary');
    const s = svc(f.vault, f.engine);
    const text = await s.file('report', 'private:report', 'SKILL.md');
    expect(text).toMatchObject({ kind: 'text', truncated: false });
    expect(text!.content).toMatch(/Private report skill/);
    expect((await s.file('report', 'private:report', 'assets/logo.bin'))!.kind).toBe('binary');
    expect((await s.file('report', 'engine:report', 'SKILL.md'))!.content).toMatch(/Engine report skill/);
    // A file swapped for an escaping link after the scan is refused at read time.
    await s.library();
    const md = join(f.vault, '.agents', 'skills', 'report', 'assets', 'logo.bin');
    rmSync(md);
    symlinkSync(join(f.outside, 'secret.txt'), md);
    expect(await s.file('report', 'private:report', 'assets/logo.bin')).toBeNull();
    rmSync(md);
    const d = await s.detail('report');
    expect(d!.instructions).toMatch(/Do the thing/);
    expect(d!.history[0]!.subject).toBe('fixture');
  });
});

describe('skills policy', () => {
  it('without a policy every agent keeps legacy behaviour and knowledge paths are references, not grants', async () => {
    const f = skillsFixture();
    const m = await svc(f.vault, f.engine).matrix();
    expect(m.mode).toBe('legacy');
    expect(m.agents.map((a) => a.name)).toEqual(['alpha', 'beta', 'gamma']);
    const ref = m.cells.find((c) => c.agent === 'alpha' && c.skill === 'video')!;
    expect(ref.reference).toBe(true);
    expect(ref.state).toBe('legacy');
    expect(m.cells.some((c) => c.state === 'assigned')).toBe(false);
    expect(m.agents.find((a) => a.name === 'alpha')!.support).toBe('catalog-filtered');
    expect(m.agents.find((a) => a.name === 'beta')!.support).toBe('catalog-only');
  });

  it('resolves org, team and agent grants with denial winning, explains each, and refuses invalid packages', async () => {
    const f = skillsFixture();
    policy(f.vault, MANAGED_POLICY);
    const s = svc(f.vault, f.engine);
    const alpha = (await s.agent('alpha'))!;
    const cell = (n: string) => alpha.cells.find((c) => c.skill === n)!;
    expect(cell('report').state).toBe('assigned');
    expect(cell('report').reasons[0]).toMatchObject({ level: 'org', kind: 'grant' });
    expect(cell('clip').state).toBe('assigned');
    expect(cell('video').state).toBe('denied');
    expect(cell('video').reasons.map((r) => `${r.level}:${r.kind}`)).toEqual(['knowledge:note', 'team:grant', 'agent:deny']);
    expect(cell('video').reference).toBe(true);
    expect(cell('ingest')?.state ?? 'not-assigned').toBe('not-assigned');
    const gamma = (await s.agent('gamma'))!;
    expect(gamma.cells.find((c) => c.skill === 'broken')!.state).toBe('unavailable');
    expect(gamma.cells.find((c) => c.skill === 'ingest')!.state).toBe('assigned');
    // '*' with an org deny: the deny still wins.
    policy(f.vault, 'version: 1\nmode: managed\nagents:\n  beta: { grant: ["*"] }\norg:\n  deny: [report]\n');
    s.invalidate();
    const beta = (await s.agent('beta'))!;
    expect(beta.cells.find((c) => c.skill === 'report')!.state).toBe('denied');
    const betaClip = beta.cells.find((c) => c.skill === 'clip')!;
    expect(betaClip.state).toBe('unavailable');
    expect(betaClip.reasons).toContainEqual({ level: 'package', kind: 'deny', detail: 'unresolved skill dependencies: report (denied)' });
  });

  it('fails closed on an invalid managed policy and reports lifecycle-disabled skills as unavailable', async () => {
    const f = skillsFixture();
    policy(f.vault, 'version: 1\nmode: managed\norg: { grant: [Report!] }\n');
    const s = svc(f.vault, f.engine);
    const lib = await s.library();
    expect(lib.policy.valid).toBe(false);
    expect((await s.agent('alpha'))!.cells.every((c) => c.state === 'unavailable' || c.reference)).toBe(true);
    policy(f.vault, `${MANAGED_POLICY}lifecycle:\n  clip: { status: disabled, note: replaced }\n`);
    s.invalidate();
    const clip = (await s.agent('alpha'))!.cells.find((c) => c.skill === 'clip')!;
    expect(clip.state).toBe('unavailable');
    expect(clip.reasons.at(-1)!.detail).toMatch(/disabled: replaced/);
  });
});

describe('skills lifecycle', () => {
  it('saves drafts outside every root, rejects traversal, secrets and symlinks, and never activates a draft', async () => {
    const f = skillsFixture();
    const s = svc(f.vault, f.engine);
    const d = await s.createDraft('report', 'report');
    expect(d.base).toMatchObject({ id: 'private:report' });
    await expect(s.writeDraftFile('report', '../escape.md', 'x')).rejects.toThrow(/unsafe package path/);
    await expect(s.writeDraftFile('report', 'scripts/../../x', 'x')).rejects.toThrow(/unsafe package path/);
    await expect(s.writeDraftFile('report', '.env', 'x')).rejects.toThrow(/unsafe|credential/);
    await expect(s.writeDraftFile('report', 'keys/server.pem', 'x')).rejects.toThrow(/credential/);
    symlinkSync(f.outside, join(f.vault, '.agents', 'skill-drafts', 'report', 'linked'));
    await expect(s.writeDraftFile('report', 'linked/new.md', 'x')).rejects.toThrow(/symlink/);
    rmSync(join(f.vault, '.agents', 'skill-drafts', 'report', 'linked'));
    const edited = await s.writeDraftFile('report', 'SKILL.md', skillMd('report', 'Private report skill, improved.'), undefined, (await s.readDraftFile('report', 'SKILL.md')).version);
    expect(edited.digest).not.toBe(d.digest);
    // The live package and catalog are untouched.
    expect(readFileSync(join(f.vault, '.agents', 'skills', 'report', 'SKILL.md'), 'utf8')).toMatch(/Private report skill\.$/m);
    s.invalidate();
    expect((await s.library(true)).skills.find((x) => x.name === 'report')!.effective!.description).toBe('Private report skill.');
    const p = await s.preview({ kind: 'update', skill: 'report', draft: 'report' });
    expect(p.blocked).toEqual([]);
    expect(p.files[0]!.diff).toMatch(/^-description: Private report skill\.$/m);
    expect(p.files[0]!.diff).toMatch(/^\+description: Private report skill, improved\.$/m);
    expect(p.runningSessions).toMatch(/Sessions already running keep what they loaded/);
    // Preview writes nothing.
    expect(existsSync(join(f.vault, '.agents', 'skill-changes'))).toBe(false);
    const c = await s.propose({ kind: 'update', skill: 'report', draft: 'report' });
    expect(c.status).toBe('proposed');
    expect(readFileSync(join(f.vault, '.agents', 'skills', 'report', 'SKILL.md'), 'utf8')).toMatch(/Private report skill\.$/m);
    // An invalid draft cannot be exported.
    await s.writeDraftFile('report', 'SKILL.md', '---\nname: report\n---\nno description\n', undefined, (await s.readDraftFile('report', 'SKILL.md')).version);
    await expect(s.propose({ kind: 'update', skill: 'report', draft: 'report' })).rejects.toThrow(/does not validate/);
  });

  it('refuses to remove a granted or depended-on skill, and resolves grants only when asked', async () => {
    const f = skillsFixture();
    policy(f.vault, MANAGED_POLICY);
    const s = svc(f.vault, f.engine);
    const dep = await s.preview({ kind: 'remove', skill: 'report' });
    expect(dep.blocked.join(' ')).toMatch(/depend on report: clip/);
    const granted = await s.preview({ kind: 'remove', skill: 'video' });
    expect(granted.blocked.join(' ')).toMatch(/still granted or pinned by teams\.media\.grant/);
    await expect(s.propose({ kind: 'remove', skill: 'video' })).rejects.toThrow(/not exported/);
    const resolved = await s.preview({ kind: 'remove', skill: 'video', resolve: true });
    expect(resolved.blocked).toEqual([]);
    expect(resolved.policyDiff).toMatch(/^-\s+grant: \[clip, video\]$/m);
    expect(resolved.policyDiff).toMatch(/status: removed/);
    expect(resolved.summary).toMatch(/package files and their Git history are kept/);
    // The source package stays where it is.
    const c = await s.propose({ kind: 'remove', skill: 'video', resolve: true });
    expect(existsSync(join(f.vault, '.hermes', 'skills', 'media', 'video', 'SKILL.md'))).toBe(true);
    expect(readFileSync(join(f.vault, '.agents', 'skill-changes', c.id, 'policy.yaml'), 'utf8')).toMatch(/^# fixture policy/);
  });

  it('rolls a package back to an earlier revision through a review branch, leaving the checkout untouched; restore re-activates', async () => {
    const f = skillsFixture();
    const original = readFileSync(join(f.vault, '.agents', 'skills', 'clip', 'scripts', 'cut.sh'), 'utf8');
    const first = sh(f.vault, 'rev-parse', 'HEAD');
    write(join(f.vault, '.agents', 'skills', 'clip', 'scripts', 'cut.sh'), '#!/bin/sh\necho v2\n', 0o755);
    sh(f.vault, 'commit', '-qam', 'clip v2');
    const s = svc(f.vault, f.engine);
    const p = await s.preview({ kind: 'rollback', skill: 'clip', revision: first });
    expect(p.blocked).toEqual([]);
    expect(p.files.map((x) => x.path)).toEqual(['scripts/cut.sh']);
    const c = await s.propose({ kind: 'rollback', skill: 'clip', revision: first });
    const branchBefore = sh(f.vault, 'rev-parse', '--abbrev-ref', 'HEAD');
    const r = await s.apply(c.id);
    expect(r.branch).toBe(`skills/${c.id}`);
    expect(sh(f.vault, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branchBefore);
    expect(readFileSync(join(f.vault, '.agents', 'skills', 'clip', 'scripts', 'cut.sh'), 'utf8')).toMatch(/v2/);
    expect(sh(f.vault, 'show', `${r.branch}:.agents/skills/clip/scripts/cut.sh`)).toBe(original.trim());
    expect(sh(f.vault, 'worktree', 'list').split('\n')).toHaveLength(1);
    expect((await s.changes()).find((x) => x.id === c.id)!.status).toBe('branch');
    await expect(s.apply(c.id)).rejects.toThrow(/already on branch/);
    // A merge without an authoritative review receipt remains pending.
    sh(f.vault, 'merge', '-q', '--ff-only', r.branch);
    sh(f.vault, 'update-ref', 'refs/remotes/origin/main', r.commit);
    sh(f.vault, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    s.invalidate();
    expect((await s.changes()).find((x) => x.id === c.id)!.status).toBe('pending');
    expect((await s.library(true)).skills.find((x) => x.name === 'clip')!.effective!.digest).toBe(p.targetDigest);
    // Disable then restore through the same flow.
    policy(f.vault, `${MANAGED_POLICY}lifecycle:\n  clip: { status: disabled }\n`);
    s.invalidate();
    const restore = await s.preview({ kind: 'restore', skill: 'clip' });
    expect(restore.blocked).toEqual([]);
    expect(restore.affectedAgents).toContain('alpha');
    expect(restore.policyDiff).toMatch(/^-\s+clip:/m);
  });

  it('marks a proposal stale when its base moves', async () => {
    const f = skillsFixture();
    const s = svc(f.vault, f.engine);
    const c = await s.propose({ kind: 'disable', skill: 'video' });
    policy(f.vault, 'version: 1\nmode: legacy\n');
    s.invalidate();
    expect((await s.changes()).find((x) => x.id === c.id)!.status).toBe('stale');
    await expect(s.apply(c.id)).rejects.toThrow(/stale/);
  });
});

describe('skills reconciliation', () => {
  async function managed() {
    const f = skillsFixture();
    policy(f.vault, MANAGED_POLICY);
    const s = svc(f.vault, f.engine);
    const root = join(f.base, 'managed');
    return { f, s, root };
  }

  it('refuses to deploy from a legacy or missing policy', async () => {
    const f = skillsFixture();
    const st = await svc(f.vault, f.engine).current();
    expect(() => planViews(st.catalog, st.policy, st.roster)).toThrow(ReconcileError);
  });

  it('deploys per-agent views with verified full packages and gives two personas different catalogs', async () => {
    const { s, root } = await managed();
    const st = await s.current();
    const rejected = syncViews(root, planViews(st.catalog, st.policy, st.roster), { env: { PATH: '' } });
    expect(rejected.views.every(v => v.status === 'failed')).toBe(true);
    expect(rejected.views.every(v => v.skills.length === 0)).toBe(true);
    expect(rejected.views.find(v => v.agent === 'gamma')!.excluded).toEqual([expect.objectContaining({name:'broken',reason:expect.stringContaining('invalid')})]);
    expect(existsSync(join(root, 'views', 'alpha', 'zen-agent'))).toBe(false);
    const report = syncViews(root, planViews(st.catalog, st.policy, st.roster, { agents: ['alpha', 'beta'] }), { env: { PATH: '' } });
    const byAgent = Object.fromEntries(report.views.map((v) => [v.agent, v]));
    expect(byAgent['alpha']!.skills.map((x) => x.name)).toEqual(['clip', 'report']);
    expect(byAgent['beta']!.skills.map((x) => x.name)).toEqual(['ingest', 'report']);
    expect(byAgent['alpha']!.status).toBe('not-ready');
    expect(byAgent['beta']!.status).toBe('current');
    // Missing requirements are reported by name; values are never read.
    expect(byAgent['alpha']!.missing).toEqual([{ skill: 'clip', bins: ['definitely-not-a-real-program-xyz'], env: ['FIXTURE_CLIP_KEY'] }]);
    const link = join(root, 'views', 'alpha', 'zen-agent');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    const manifest = JSON.parse(readFileSync(join(link, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ format: 'secondbrain-skills-view/1', agent: 'alpha', runtime: 'zen-agent', mode: 'managed', support: 'catalog-filtered' });
    const clip = manifest.skills.find((x: { name: string }) => x.name === 'clip');
    const scan = scanPackage(join(link, 'clip'));
    expect(scan.ok && scan.digest).toBe(clip.digest);
    expect(scan.ok && scan.files.map((x) => x.path)).toEqual(['SKILL.md', 'scripts/cut.sh']);
    // Store files are read-only.
    expect(lstatSync(join(link, 'clip', 'SKILL.md')).mode & 0o222).toBe(0);
    // A revoked skill leaves the view on the next sync; the source package is untouched.
    policy(join(root, '..', 'vault'), MANAGED_POLICY.replace('grant: [clip, video]', 'grant: [video]'));
    s.invalidate();
    const st2 = await s.current();
    const r2 = syncViews(root, planViews(st2.catalog, st2.policy, st2.roster, { agents: ['alpha'] }), { env: { PATH: '' } });
    expect(r2.views[0]!.skills.map((x) => x.name)).toEqual(['report']);
    expect(existsSync(join(root, 'views', 'alpha', 'zen-agent', 'clip'))).toBe(false);
    expect(existsSync(join(root, '..', 'vault', '.agents', 'skills', 'clip', 'scripts', 'cut.sh'))).toBe(true);
  });

  it('detects a tampered deployment, leaves it alone, and redeploys only with --repair', async () => {
    const { s, root } = await managed();
    const st = await s.current();
    const plan = planViews(st.catalog, st.policy, st.roster, { agents: ['alpha'] });
    syncViews(root, plan, { env: { PATH: '' } });
    const target = join(root, 'views', 'alpha', 'zen-agent', 'clip', 'scripts', 'cut.sh');
    const storeDir = join(root, 'views', 'alpha', 'zen-agent', 'clip');
    const real = join(root, 'store', readlinkSync(storeDir).split('/').pop()!);
    chmodSync(real, 0o755); chmodSync(join(real, 'scripts'), 0o755); chmodSync(target, 0o755);
    writeFileSync(target, '#!/bin/sh\necho tampered\n');
    expect(verifyView(root, 'alpha', 'zen-agent').dirty).toEqual(['clip']);
    const r = syncViews(root, plan, { env: { PATH: '' } });
    expect(r.views[0]!.status).toBe('dirty');
    expect(readFileSync(target, 'utf8')).toMatch(/tampered/); // never silently overwritten
    const repaired = syncViews(root, plan, { repair: true, env: { PATH: '' } });
    expect(repaired.views[0]!.status).toBe('not-ready');
    expect(verifyView(root, 'alpha', 'zen-agent').dirty).toEqual([]);
    expect(readFileSync(join(root, 'views', 'alpha', 'zen-agent', 'clip', 'scripts', 'cut.sh'), 'utf8')).toMatch(/echo cut/);
  });

  it('keeps the previous deployment intact when staging fails verification (atomic activation)', async () => {
    const { s, root } = await managed();
    const st = await s.current();
    const plan = planViews(st.catalog, st.policy, st.roster, { agents: ['alpha'] });
    const first = syncViews(root, plan, { env: { PATH: '' } });
    const before = readlinkSync(join(root, 'views', 'alpha', 'zen-agent'));
    // A new revision whose source changes between resolution and staging: digest mismatch.
    write(join(st.catalog.byName.get('report')![0]!.dir, 'SKILL.md'), skillMd('report', 'Private report skill v2.'));
    s.invalidate();
    const st2 = await s.current();
    const plan2 = planViews(st2.catalog, st2.policy, st2.roster, { agents: ['alpha'] });
    const r = syncViews(root, plan2, { env: { PATH: '' }, hooks: { afterStage: (_d, dir) => { writeFileSync(join(dir, 'SKILL.md'), 'tampered in transit'); } } });
    expect(r.views[0]!.status).toBe('failed');
    expect(r.views[0]!.error).toMatch(/does not match the approved/);
    expect(readlinkSync(join(root, 'views', 'alpha', 'zen-agent'))).toBe(before);
    expect(r.views[0]!.viewDigest).toBe(first.views[0]!.viewDigest);
    expect(verifyView(root, 'alpha', 'zen-agent').dirty).toEqual([]);
    expect(existsSync(join(root, '.staging'))).toBe(false);
    // A failure just before the switch also leaves the old view.
    const r2 = syncViews(root, plan2, { env: { PATH: '' }, hooks: { beforeActivate: () => { throw new Error('disk full'); } } });
    expect(r2.views[0]!.status).toBe('failed');
    expect(readlinkSync(join(root, 'views', 'alpha', 'zen-agent'))).toBe(before);
  });

  it('refuses to replace an unmanaged folder and rejects traversal in a bundle', async () => {
    const { s, root } = await managed();
    const st = await s.current();
    mkdirSync(join(root, 'views', 'beta', 'claude-code'), { recursive: true });
    writeFileSync(join(root, 'views', 'beta', 'claude-code', 'hand-made.md'), 'mine');
    const r = syncViews(root, planViews(st.catalog, st.policy, st.roster, { agents: ['beta'] }), { env: { PATH: '' } });
    expect(r.views[0]!.status).toBe('failed');
    expect(readFileSync(join(root, 'views', 'beta', 'claude-code', 'hand-made.md'), 'utf8')).toBe('mine');
    const bundle = packBundle(planViews(st.catalog, st.policy, st.roster, { agents: ['alpha'] }));
    const digest = Object.keys(bundle.packages)[0]!;
    bundle.packages[digest]!.files.push({ path: '../../escape.sh', exec: true, data: Buffer.from('x').toString('base64') });
    const other = join(mkdtempSync(join(tmpdir(), 'sb-host2-')), 'managed');
    expect(() => planFromBundle(JSON.parse(JSON.stringify(bundle)))).toThrow(/unsafe path/);
    expect(existsSync(join(other, '..', 'escape.sh'))).toBe(false);
  });

  it('a second host deploys the same digests from a bundle (explicit transport) and the CLI reports honestly', async () => {
    const { f, s, root } = await managed();
    const out: string[] = [];
    const io = { out: (x: string) => out.push(x), err: (x: string) => out.push(`ERR ${x}`), env: { PATH: '' } as NodeJS.ProcessEnv };
    expect(await runSkillsCli(['sync', '--agents', 'alpha,beta', '--root', root], s, io)).toBe(2);
    const bundleFile = join(f.base, 'bundle.json');
    expect(await runSkillsCli(['pack', '--out', bundleFile, '--agents', 'alpha,beta'], s, io)).toBe(0);
    const host2 = join(f.base, 'host2');
    const empty = svc(join(f.base, 'no-vault'), null);
    expect(await runSkillsCli(['sync', '--bundle', bundleFile, '--root', host2], empty, io)).toBe(2);
    const m1 = JSON.parse(readFileSync(join(root, 'views', 'beta', 'claude-code', 'manifest.json'), 'utf8'));
    const m2 = JSON.parse(readFileSync(join(host2, 'views', 'beta', 'claude-code', 'manifest.json'), 'utf8'));
    expect(m2.viewDigest).toBe(m1.viewDigest);
    expect(await runSkillsCli(['status', '--root', host2], empty, io)).toBe(2);
    expect(await runSkillsCli(['preview', 'disable', 'video'], s, io)).toBe(0);
    expect(out.join('\n')).toMatch(/This was a preview\. Nothing was saved\./);
    expect(await runSkillsCli(['propose', 'disable', 'video'], s, io)).toBe(0);
    expect(out.join('\n')).toMatch(/Exported for review as change .*Nothing is active yet/);
    // An acknowledgement without a token is refused locally, never sent.
    expect(await runSkillsCli(['ack', '--server', 'http://127.0.0.1:9', '--root', root], s, io)).toBe(1);
    expect(out.at(-1)).toMatch(/no device token/);
  });
});
