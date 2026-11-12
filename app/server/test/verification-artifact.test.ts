import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256, VerificationPolicy } from '../src/verification/contract.js';
import { artifactLimit, artifactName, evaluate } from '../src/verification/evidence.js';
import { backendFailures, collect, GitHubVerificationSource, verifyHead, verifyMain, type VerificationSource } from '../src/verification/github.js';
import { crc32, readZip } from '../src/verification/zip.js';
import { good, head } from './verification-fixtures.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
type Entry = { name: string; data: Buffer | string; method?: 0 | 8; type?: number; declared?: number; madeBy?: number };
/** Minimal zip writer for adversarial archives. */
function zip(entries: Entry[]): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = []; let offset = 0;
  for (const e of entries) {
    const data = Buffer.from(e.data), method = e.method ?? 8, body = method === 8 ? deflateRawSync(data) : data, name = Buffer.from(e.name);
    const size = e.declared ?? data.length, crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(((e.madeBy ?? 3) << 8) | 20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(((e.type ?? 0o100644) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, name, body); centrals.push(central, name); offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const limits = { maxEntries: 64, maxTotalBytes: 5_000_000, allowed: artifactName, maxEntryBytes: artifactLimit };

describe('artifact archive is inspected before anything is expanded', () => {
  it('reads a well-formed artifact in memory', () => {
    const m = readZip(zip([{ name: 'evidence.json', data: '{}' }, { name: 'logs/', data: '' }, { name: 'logs/tests.log', data: 'ok', method: 0 }, { name: 'reports/tests.json', data: '{"x":1}' }]), limits);
    expect([...m.keys()]).toEqual(['evidence.json', 'logs/tests.log', 'reports/tests.json']); expect(m.get('logs/tests.log')!.toString()).toBe('ok');
  });
  it.each<[string, Entry[], RegExp]>([
    ['path traversal', [{ name: '../../etc/cron.d/x', data: 'x' }], /unexpected member name/],
    ['an absolute path', [{ name: '/tmp/x.log', data: 'x' }], /unexpected member name/],
    ['a traversal hidden under logs/', [{ name: 'logs/../../x.log', data: 'x' }], /unexpected member name/],
    ['an unexpected file', [{ name: 'logs/tests.sh', data: 'x' }], /unexpected member name/],
    ['a symbolic link', [{ name: 'logs/tests.log', data: '/home/runner/.ssh/id_rsa', type: 0o120777 }], /not a regular file/],
    ['a special file', [{ name: 'logs/tests.log', data: '', type: 0o010644 }], /not a regular file/],
    ['a duplicate member', [{ name: 'evidence.json', data: '{}' }, { name: 'evidence.json', data: '{"result":"pass"}' }], /duplicate member/],
    ['too many members', Array.from({ length: 65 }, (_, i) => ({ name: `logs/l${i}.log`, data: 'x' })), /65 members, limit 64/],
    ['an oversized member', [{ name: 'logs/tests.log', data: Buffer.alloc(2_000_001) }], /limit 2000000/],
    ['a high-expansion member that lies about its size', [{ name: 'logs/tests.log', data: Buffer.alloc(1_000_000), declared: 100 }], /expands beyond its declared size/],
    ['an archive whose members together expand past the total', Array.from({ length: 3 }, (_, i) => ({ name: `logs/l${i}.log`, data: Buffer.alloc(1_900_000) })), /expanded size above 5000000/],
  ])('refuses %s', (_, entries, why) => {
    expect(() => readZip(zip(entries), limits)).toThrow(why);
  });
  it('refuses a corrupted member and a truncated archive', () => {
    const z = zip([{ name: 'logs/tests.log', data: 'hello world', method: 0 }]); z[30 + 'logs/tests.log'.length] ^= 0xff;
    expect(() => readZip(z, limits)).toThrow(/CRC mismatch/);
    expect(() => readZip(z.subarray(0, 20), limits)).toThrow(/no end of central directory/);
  });
});

describe('GitHub collector', () => {
  function gh(archive: Buffer, artifacts = [{ id: 55, name: 'verification-evidence', size_in_bytes: archive.length, expired: false, workflow_run: { id: 7 } }]) {
    const calls: string[][] = [];
    const g = good();
    const json = async (args: string[]) => {
      calls.push(args);
      if (args[1]?.includes('/actions/runs?')) return JSON.stringify({ workflow_runs: [g.run, { ...g.run, id: 9, path: '.github/workflows/other.yml' }, { ...g.run, id: 8, head_sha: 'd'.repeat(40) }] });
      if (args[1]?.includes('/jobs')) return JSON.stringify({ jobs: g.jobs });
      if (args[1]?.includes('/artifacts?')) return JSON.stringify({ artifacts });
      throw new Error(`unexpected ${args.join(' ')}`);
    };
    const bytes = async (args: string[], max: number) => { calls.push(args); expect(max).toBe(50_000_000); return archive; };
    const git = async (args: string[]) => { const f = g.files[args[1]!.split(':')[1]!]; if (f == null) throw new Error('missing'); return f; };
    return { src: new GitHubVerificationSource(json, bytes, git, 'example/engine', async () => { throw new Error('no fetch'); }), calls, g };
  }
  const policy = () => VerificationPolicy.parse({ version: 1, workflow: { path: '.github/workflows/ci.yml', job: 'app' },
    trustedFiles: { '.github/workflows/ci.yml': [sha256('name: ci\n')], 'scripts/verify.mjs': [sha256('// runner\n')] }, capabilities: ['postgres'],
    requiredChecks: [{ id: 'tests', argv: ['npm', 'test', '--', '--outputFile.json={report}'], covers: ['unit'], count: 'required', cwd: 'app', requires: ['postgres'], report: 'vitest-json', minTimeoutSeconds: 60 }] });
  const archiveOf = (g: ReturnType<typeof good>, extra: Entry[] = []) => zip([{ name: 'evidence.json', data: JSON.stringify(g.evidence) },
    ...Object.entries(g.artifact).map(([name, data]) => ({ name, data: Buffer.from(data) })), ...extra]);
  it('reads only the configured artifact of the exact run, by id, into memory', async () => {
    const s = gh(archiveOf(good()));
    const c = await collect(s.src, policy(), head);
    expect(c.run!.id).toBe(7); expect(Object.keys(c.artifact).sort()).toEqual(['logs/build.log', 'logs/tests.log', 'reports/tests.json']);
    expect(evaluate(policy(), head, c).failures).toEqual([]);
    expect(s.calls.find(a => a[1]?.endsWith('/zip'))).toEqual(['api', 'repos/example/engine/actions/artifacts/55/zip']);
    expect(s.calls.flat()).not.toContain('download');
  });
  it.each<[string, (a: Buffer) => Parameters<typeof gh>]>([
    ['two artifacts with the configured name', a => [a, [{ id: 55, name: 'verification-evidence', size_in_bytes: a.length, expired: false, workflow_run: { id: 7 } }, { id: 56, name: 'verification-evidence', size_in_bytes: a.length, expired: false, workflow_run: { id: 7 } }]]],
    ['an artifact of another run', a => [a, [{ id: 55, name: 'verification-evidence', size_in_bytes: a.length, expired: false, workflow_run: { id: 6 } }]]],
    ['an oversized compressed artifact', a => [a, [{ id: 55, name: 'verification-evidence', size_in_bytes: 60_000_000, expired: false, workflow_run: { id: 7 } }]]],
  ])('yields no evidence for %s', async (_, args) => {
    const archive = archiveOf(good());
    const c = await collect(gh(...args(archive)).src, policy(), head);
    expect(c.evidence).toBeNull(); expect(evaluate(policy(), head, c).failures.map(f => f.code)).toEqual(['evidence-malformed']);
  });
  it('a hostile archive is an evidence failure for the verifier, never a pass', async () => {
    const s = gh(archiveOf(good(), [{ name: 'logs/x.log', data: 'x', type: 0o120777 }]));
    const d = await verifyHead(s.src, policy(), head);
    expect(d.status).toBe('fail'); expect(d.failures[0]).toMatchObject({ type: 'evidence', route: 'verifier', code: 'collection-failed', detail: expect.stringMatching(/not a regular file/) });
  });
});

describe('admission checks the verifier backend before builder launch', () => {
  const policy = () => VerificationPolicy.parse({ version: 1, workflow: { path: '.github/workflows/ci.yml', job: 'app' },
    trustedFiles: { '.github/workflows/ci.yml': [sha256('wf')], 'scripts/verify.mjs': [sha256('r')] }, capabilities: ['postgres', 'loopback-listeners'],
    requiredChecks: [{ id: 'tests', argv: ['npm', 'test'], covers: ['unit'], count: 'none', cwd: '.', requires: [], report: null, minTimeoutSeconds: 1 }] });
  const now = Date.parse('2026-06-15T00:00:00Z');
  function backend(patch: Partial<Record<'enabled' | 'state' | 'run' | 'job' | 'evidence', unknown>> = {}): VerificationSource {
    const g = good(), o = { enabled: true, state: 'active', run: { ...g.run!, event: 'push', created_at: '2026-06-14T00:00:00Z' }, job: g.jobs[0], evidence: g.evidence, ...patch };
    return { runs: async () => [], file: async () => null, document: async () => null,
      actionsEnabled: async () => o.enabled as boolean, workflow: async () => o.state === null ? null : { state: o.state as string },
      latestSuccess: async () => o.run as never, jobs: async () => (o.job ? [o.job] : []) as never, artifact: async () => (o.evidence ? { evidence: o.evidence, files: {} } : null) };
  }
  it('admits when a recent hosted run proved isolation and every requested capability', async () => {
    expect(await backendFailures(backend(), policy(), ['postgres'], now)).toEqual([]);
  });
  it.each<[string, Parameters<typeof backend>[0], string[], string]>([
    ['Actions disabled', { enabled: false }, ['postgres'], 'actions-disabled'],
    ['a disabled workflow', { state: 'disabled_manually' }, ['postgres'], 'workflow-unavailable'],
    ['a missing workflow', { state: null }, ['postgres'], 'workflow-unavailable'],
    ['no recent successful run', { run: null }, ['postgres'], 'no-recent-verifier-run'],
    ['a stale last success', { run: { ...good().run!, created_at: '2026-01-01T00:00:00Z' } }, ['postgres'], 'no-recent-verifier-run'],
    ['a self-hosted last success', { job: { ...good().jobs[0]!, labels: ['self-hosted'] } }, ['postgres'], 'untrusted-runner'],
    ['no isolation proof', { evidence: { ...(good().evidence as object), isolation: null } }, ['postgres'], 'isolation-unproven'],
    ['a capability the backend never proved', {}, ['loopback-listeners'], 'capability-unproven'],
  ])('stops launch with infrastructure unavailable for %s', async (_, patch, caps, code) => {
    expect(await backendFailures(backend(patch), policy(), caps, now)).toEqual([expect.objectContaining({ type: 'infrastructure', route: 'verifier', code })]);
  });
  it.each<[string, () => VerificationSource, number, string]>([
    ['Actions access removed', () => ({ ...backend(), actionsEnabled: async () => { throw new Error('HTTP 403: Resource not accessible by integration'); } }), 3, 'unavailable'],
    ['the workflow disabled', () => backend({ state: 'disabled_manually' }), 3, 'unavailable'],
    ['a usable backend', () => backend({ run: { ...good().run!, event: 'push', created_at: new Date().toISOString() } }), 0, 'admitted'],
  ])('`verify admit` with %s exits %i', async (_, make, exit, status) => {
    const dir = mkdtempSync(join(tmpdir(), 'admit-')); dirs.push(dir);
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'commit.gpgSign=false', ...a], { cwd: dir, encoding: 'utf8' });
    mkdirSync(join(dir, 'verification'));
    writeFileSync(join(dir, 'verification/contract.json'), JSON.stringify({ version: 1, capabilities: ['postgres'], checks: [{ id: 'tests', covers: ['unit'], cwd: '.', argv: ['npm', 'test'], requires: [], timeoutSeconds: 60, count: 'none' }] }));
    git('init', '-q'); git('add', '.'); git('commit', '-q', '-m', 'c');
    const policyPath = join(dir, 'policy.json'), requestPath = join(dir, 'request.json');
    writeFileSync(policyPath, JSON.stringify(policy())); chmodSync(policyPath, 0o600);
    writeFileSync(requestPath, JSON.stringify({ repository: dir, revision: git('rev-parse', 'HEAD').trim(), github: 'example/engine', gh: '/usr/bin/false', home: dir }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await verifyMain(['admit', requestPath, policyPath], (() => make()) as never)).toBe(exit);
      expect(JSON.parse(String(log.mock.calls.at(-1)![0]))).toMatchObject({ status });
    } finally { log.mockRestore(); }
  });
});
