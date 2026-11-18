import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ZenAgent } from '../src/agent.js';
import { loadConfig, type ZenConfig } from '../src/config.js';
import { packageDigest } from '../src/skillpkg.js';
import { resolveSkills, VIEW_FORMAT } from '../src/skills.js';
import { startServer } from '../src/serve.js';
import { skillTools } from '../src/tools/skill.js';
import type { ToolContext } from '../src/tools/index.js';

const VECTOR = 'sha256:66478e2630a89efdfb38a87df8c60158430330223f330ff2f322d485990e447c';

function pkg(dir: string, name: string, body = `Run scripts/run.sh.`): string {
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill.\n---\n\n# ${name}\n\n${body}\n`);
  writeFileSync(join(dir, 'scripts', 'run.sh'), `#!/bin/sh\necho ${name}\n`);
  chmodSync(join(dir, 'SKILL.md'), 0o644);
  chmodSync(join(dir, 'scripts', 'run.sh'), 0o755);
  return dir;
}

/** A managed root shaped like the engine's reconcile output: store/<hex>, views/<agent>/zen-agent -> zen-agent.<gen>. */
function managedRoot(): string {
  return mkdtempSync(join(tmpdir(), 'zen-managed-'));
}

function store(root: string, name: string, body?: string): string {
  const tmp = mkdtempSync(join(tmpdir(), 'zen-pkg-'));
  pkg(join(tmp, name), name, body);
  const d = packageDigest(join(tmp, name));
  assert.ok(d.ok);
  const hex = d.digest.slice('sha256:'.length);
  mkdirSync(join(root, 'store'), { recursive: true });
  renameSync(join(tmp, name), join(root, 'store', hex));
  return d.digest;
}

function view(root: string, agent: string, gen: number, skills: { name: string; digest: string }[]): void {
  const dir = join(root, 'views', agent, `zen-agent.${gen}`);
  mkdirSync(dir, { recursive: true });
  for (const s of skills) symlinkSync(join('..', '..', '..', 'store', s.digest.slice(7)), join(dir, s.name));
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      format: VIEW_FORMAT, agent, runtime: 'zen-agent', generatedAt: new Date().toISOString(), policyDigest: 'sha256:' + '0'.repeat(64),
      mode: 'managed', support: 'catalog-filtered',
      skills: skills.map((s) => ({ name: s.name, id: `private:${s.name}`, digest: s.digest, revision: 'a'.repeat(40), dirty: false, description: `${s.name} skill.`, path: s.name })),
    }),
  );
  const link = join(root, 'views', agent, 'zen-agent');
  const tmp = `${link}.tmp-${gen}`;
  symlinkSync(`zen-agent.${gen}`, tmp);
  renameSync(tmp, link);
}

function cfgFor(root: string | null, legacyDir: string, enforce = false): Pick<ZenConfig, 'skills' | 'sessionsDir' | 'managedSkills'> {
  return { skills: [legacyDir], sessionsDir: mkdtempSync(join(tmpdir(), 'zen-sessions-')), managedSkills: root ? { root, enforce, snapshots: null } : null };
}

function legacy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zen-legacy-'));
  pkg(join(dir, 'global-secret-skill'), 'global-secret-skill');
  return dir;
}

test('package digest v1 matches the engine test vector', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zen-vector-'));
  mkdirSync(join(dir, 'scripts'));
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: vector\ndescription: Digest test vector.\n---\n\n# vector\n\nRun scripts/run.sh.\n');
  writeFileSync(join(dir, 'scripts', 'run.sh'), '#!/bin/sh\necho vector\n');
  chmodSync(join(dir, 'SKILL.md'), 0o644);
  chmodSync(join(dir, 'scripts', 'run.sh'), 0o755);
  const d = packageDigest(dir);
  assert.ok(d.ok);
  assert.equal(d.digest, VECTOR);
  assert.deepEqual(d.files.map((f) => [f.path, f.exec]), [['SKILL.md', false], ['scripts/run.sh', true]]);
  // Ignored noise does not change the digest; the exec bit does.
  writeFileSync(join(dir, '.DS_Store'), 'x');
  assert.equal((packageDigest(dir) as { digest: string }).digest, VECTOR);
  chmodSync(join(dir, 'scripts', 'run.sh'), 0o644);
  assert.notEqual((packageDigest(dir) as { digest: string }).digest, VECTOR);
});

test('escaping symlinks, directory symlinks and secret-like files make a package invalid', () => {
  const outside = mkdtempSync(join(tmpdir(), 'zen-outside-'));
  writeFileSync(join(outside, 'passwd'), 'nope');
  const a = pkg(join(mkdtempSync(join(tmpdir(), 'zen-esc-')), 'a'), 'a');
  symlinkSync(join(outside, 'passwd'), join(a, 'leak.txt'));
  assert.deepEqual(packageDigest(a), { ok: false, error: 'symlink escapes package: leak.txt' });

  const b = pkg(join(mkdtempSync(join(tmpdir(), 'zen-esc-')), 'b'), 'b');
  symlinkSync('scripts', join(b, 'more'));
  assert.match((packageDigest(b) as { error: string }).error, /directory symlink/);

  const c = pkg(join(mkdtempSync(join(tmpdir(), 'zen-esc-')), 'c'), 'c');
  writeFileSync(join(c, '.env'), 'TOKEN=x');
  assert.match((packageDigest(c) as { error: string }).error, /secret-like file/);

  const d = pkg(join(mkdtempSync(join(tmpdir(), 'zen-esc-')), 'd'), 'd');
  symlinkSync('scripts/run.sh', join(d, 'run'));
  assert.ok(packageDigest(d).ok, 'an in-package file link is fine');
});

test('two personas get different catalogs; read_skill refuses the other persona\'s skill; legacy dirs are not read', async () => {
  const root = managedRoot();
  const report = store(root, 'report');
  const render = store(root, 'render');
  view(root, 'writer', 1, [{ name: 'report', digest: report }]);
  view(root, 'editor', 1, [{ name: 'render', digest: render }]);
  const cfg = cfgFor(root, legacy());

  const w = resolveSkills(cfg, 'writer', 's-writer');
  const e = resolveSkills(cfg, 'editor', 's-editor');
  assert.equal(w.mode, 'managed');
  assert.deepEqual(w.skills.map((s) => s.name), ['report']);
  assert.deepEqual(e.skills.map((s) => s.name), ['render']);
  assert.deepEqual(w.packages, [{ name: 'report', id: 'private:report', digest: report, revision: 'a'.repeat(40) }]);
  assert.equal(w.support, 'catalog-filtered');

  const [readSkill] = skillTools({ skills: w.skills } as unknown as ToolContext);
  const ok = await readSkill!.execute('1', { name: 'report' });
  assert.match((ok.content[0] as { text: string }).text, /# report/);
  assert.equal((ok.details as { digest: string }).digest, report);
  await assert.rejects(() => readSkill!.execute('2', { name: 'render' }), /no skill "render"/);
  await assert.rejects(() => readSkill!.execute('3', { name: 'global-secret-skill' }), /no skill/);
});

test('a tampered store package is rejected and listed', () => {
  const root = managedRoot();
  const good = store(root, 'good');
  const bad = store(root, 'bad');
  view(root, 'writer', 1, [{ name: 'good', digest: good }, { name: 'bad', digest: bad }]);
  const file = join(root, 'store', bad.slice(7), 'scripts', 'run.sh');
  writeFileSync(file, '#!/bin/sh\ncurl example.invalid\n');
  const r = resolveSkills(cfgFor(root, legacy()), 'writer', 's1');
  assert.deepEqual(r.skills.map((s) => s.name), ['good']);
  assert.equal(r.rejected.length, 1);
  assert.equal(r.rejected[0]!.name, 'bad');
  assert.match(r.rejected[0]!.reason, /does not match the manifest/);
});

test('missing views: enforce gives no skills, otherwise legacy; default config is legacy exactly', () => {
  const root = managedRoot();
  const leg = legacy();
  const enforced = resolveSkills(cfgFor(root, leg, true), 'writer', 's1');
  assert.equal(enforced.mode, 'managed-missing');
  assert.deepEqual(enforced.skills, []);
  const loose = resolveSkills(cfgFor(root, leg, false), 'writer', 's2');
  assert.equal(loose.mode, 'legacy');
  assert.deepEqual(loose.skills.map((s) => s.name), ['global-secret-skill']);
  const off = resolveSkills(cfgFor(null, leg), 'writer', 's3');
  assert.equal(off.mode, 'legacy');
  assert.deepEqual(off.packages, []);
  assert.deepEqual(off.skills.map((s) => s.name), ['global-secret-skill']);
  assert.equal(resolveSkills(cfgFor(root, leg, true), null, 's4').skills.length, 0);
  // loadConfig default
  assert.equal(loadConfig({ workdir: mkdtempSync(join(tmpdir(), 'zen-cfg-')), env: {} }).managedSkills, null);
});

test('a managed run pins a stable snapshot: a later sync does not change it, and the trace records exact digests', async () => {
  const vault = mkdtempSync(join(tmpdir(), 'zen-vault-'));
  writeFileSync(join(vault, 'AGENTS.md'), '# Rules');
  mkdirSync(join(vault, 'defs'));
  writeFileSync(join(vault, 'defs', 'writer.md'), 'You write.');
  const root = managedRoot();
  const v1 = store(root, 'report', 'Version one steps.');
  view(root, 'writer', 1, [{ name: 'report', digest: v1 }]);

  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const cfg = loadConfig({
    workdir: vault, env: {},
    overrides: { model: 'faux/faux-1', tools: ['skills'], skills: [legacy()], managedSkills: { root, enforce: true, snapshots: null }, persona: { org: join(vault, 'none.json'), definitions: join(vault, 'defs'), memory: join(vault, 'mem') } },
  });
  const zen = new ZenAgent({ config: cfg, persona: 'writer', models, env: {} });
  assert.deepEqual(zen.skills.map((s) => s.name), ['report']);

  // A sync activates version two while the run is open.
  const v2 = store(root, 'report', 'Version two steps.');
  assert.notEqual(v1, v2);
  view(root, 'writer', 2, [{ name: 'report', digest: v2 }]);

  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('read_skill', { name: 'report' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxText('done')]),
  ]);
  const r = await zen.run('use the report skill');
  assert.equal(r.stopped, 'done');
  const log = readFileSync(r.sessionPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const meta = log[0];
  assert.equal(meta.skills_mode, 'managed');
  assert.equal(meta.skills_support, 'catalog-filtered');
  assert.deepEqual(meta.skills_packages, [{ name: 'report', id: 'private:report', digest: v1, revision: 'a'.repeat(40) }]);
  const toolResult = log.find((l) => l.type === 'message' && l.message.role === 'toolResult');
  assert.match(JSON.stringify(toolResult), /Version one steps/);
  assert.doesNotMatch(JSON.stringify(toolResult), /Version two/);
  // The snapshot is read-only and still hashes to v1.
  assert.equal((packageDigest(join(meta.skills_snapshot, 'report')) as { digest: string }).digest, v1);
  assert.throws(() => writeFileSync(join(meta.skills_snapshot, 'report', 'SKILL.md'), 'x'));

  // Resuming the session reuses its snapshot, not the newer view.
  const resumed = resolveSkills(cfg, 'writer', r.sessionId);
  assert.deepEqual(resumed.packages.map((p) => p.digest), [v1]);
  // A new session gets the new version.
  assert.deepEqual(resolveSkills(cfg, 'writer', 'fresh').packages.map((p) => p.digest), [v2]);
});

for (const enforce of [false, true]) test(`resume survives view removal (enforce=${enforce})`, () => {
  const root = managedRoot();
  view(root, 'writer', 1, [{ name: 'report', digest: store(root, 'report') }]);
  const cfg = cfgFor(root, legacy(), enforce);
  const first = resolveSkills(cfg, 'writer', 'resume-removed');
  rmSync(join(root, 'views'), { recursive: true, force: true });
  const resumed = resolveSkills(cfg, 'writer', 'resume-removed');
  assert.equal(resumed.mode, 'managed');
  assert.deepEqual(resumed.packages, first.packages);
  assert.deepEqual(resumed.skills.map((s) => s.name), ['report']);
  assert.equal(resolveSkills({ ...cfg, managedSkills: null }, 'writer', 'resume-removed').mode, 'managed');
});

for (const mismatch of ['agent', 'runtime']) test(`rejects a substituted view ${mismatch}`, () => {
  const root = managedRoot();
  view(root, 'writer', 1, [{ name: 'report', digest: store(root, 'report') }]);
  const file = join(root, 'views', 'writer', 'zen-agent', 'manifest.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  manifest[mismatch] = mismatch === 'agent' ? 'editor' : 'codex';
  writeFileSync(file, JSON.stringify(manifest));
  const resolved = resolveSkills(cfgFor(root, legacy(), false), 'writer', 'wrong-identity');
  assert.equal(resolved.mode, 'managed-missing'); assert.deepEqual(resolved.skills, []);
  assert.match(resolved.rejected[0]!.reason, /agent|persona|runtime/);
});

for (const corruption of ['record', 'package']) test(`damaged snapshot ${corruption} fails closed`, () => {
  const root = managedRoot();
  view(root, 'writer', 1, [{ name: 'report', digest: store(root, 'report') }, { name: 'second', digest: store(root, 'second') }]);
  const cfg = cfgFor(root, legacy(), false);
  const first = resolveSkills(cfg, 'writer', 'damaged-snapshot');
  rmSync(join(root, 'views'), { recursive: true, force: true });
  const file = corruption === 'record' ? join(first.snapshot!, '.snapshot.json') : join(first.snapshot!, 'report', 'SKILL.md');
  chmodSync(file, 0o644);
  writeFileSync(file, corruption === 'record' ? '{broken' : '# changed after the session started');
  const resumed = resolveSkills(cfg, 'writer', 'damaged-snapshot');
  assert.equal(resumed.mode, 'managed-missing'); assert.deepEqual(resumed.skills, []);
  assert.match(resumed.rejected[0]!.reason, /snapshot/);
});

test('managed chat HTTP catalogs are scoped to their verified snapshots', async () => {
  const vault = mkdtempSync(join(tmpdir(), 'zen-chat-managed-'));
  writeFileSync(join(vault, 'AGENTS.md'), '# Fixture rules'); mkdirSync(join(vault, 'defs'));
  for (const name of ['writer', 'editor']) writeFileSync(join(vault, 'defs', `${name}.md`), `You are ${name}.`);
  const root = managedRoot();
  view(root, 'writer', 1, [{ name: 'report', digest: store(root, 'report') }]);
  view(root, 'editor', 1, [{ name: 'render', digest: store(root, 'render') }]);
  const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  const cfg = loadConfig({ workdir: vault, env: {}, overrides: {
    model: 'faux/faux-1', tools: ['skills'], skills: [legacy()], managedSkills: { root, enforce: true, snapshots: null },
    persona: { org: join(vault, 'none.json'), definitions: join(vault, 'defs'), memory: join(vault, 'mem') },
  } });
  const started = await startServer({ config: cfg, models, env: {}, token: 'synthetic-fixture-token', port: 0 });
  try {
    const writer = started.host.create({ persona: 'writer' }); const editor = started.host.create({ persona: 'editor' });
    const headers = { authorization: 'Bearer synthetic-fixture-token' };
    const global = await (await fetch(`${started.url}/zen/skills`, { headers })).json() as { skills: { name: string }[] };
    assert.deepEqual(global.skills, []);
    for (const [chat, name] of [[writer, 'report'], [editor, 'render']] as const) {
      const scoped = await (await fetch(`${started.url}/zen/chats/${chat.id}/skills`, { headers })).json() as { skills: { name: string }[] };
      assert.deepEqual(scoped.skills.map((s) => s.name), [name]);
    }
  } finally { await new Promise<void>((resolve) => started.server.close(() => resolve())); }
});
