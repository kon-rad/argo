import { execFileSync, spawnSync } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// The repository-authored runner. The coordinator never imports it; these tests do.
import * as runner from '../../../scripts/verify.mjs';
import { evaluate, summarize as coordinatorSummarize } from '../src/verification/evidence.js';
import { sha256, VerificationPolicy } from '../src/verification/contract.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const HOSTED = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_RUN_ID: '101', GITHUB_RUN_ATTEMPT: '1', PATH: process.env.PATH!, HOME: process.env.HOME! };
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'verify-test-')); dirs.push(d); return d; };
const node = (code: string) => ['node', '-e', code];
const check = (id: string, argv: string[], extra: Record<string, unknown> = {}) => ({ id, covers: ['unit'], cwd: '.', argv, requires: [], timeoutSeconds: 30, count: 'none', ...extra });
const vitest = (r: Record<string, unknown>) => JSON.stringify({ numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, numTotalTestSuites: 1, numFailedTestSuites: 0, testResults: [], ...r });
const report = (r: Record<string, unknown>, exit: number) => node(`require('fs').writeFileSync(process.argv[1], ${JSON.stringify(vitest(r))}); process.exit(${exit})`).concat('{report}');
const failed = (n: number, message: string) => ({ numFailedTests: n, testResults: [{ name: 'a.test.ts', status: 'failed', assertionResults: Array.from({ length: n }, (_, i) => ({ status: 'failed', fullName: `case ${i}`, failureMessages: [message] })) }] });

function repo(contract: unknown): string {
  const dir = temp();
  mkdirSync(join(dir, 'verification'));
  writeFileSync(join(dir, 'verification/contract.json'), JSON.stringify(contract));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'commit.gpgSign=false', ...args], { cwd: dir, stdio: 'pipe' });
  git('init', '-q'); git('add', '.'); git('commit', '-q', '-m', 'fixture');
  return dir;
}
const contractOf = (...checks: unknown[]) => ({ version: 1, capabilities: [], checks });

/**
 * Test double for the Linux user sandbox, which only exists on the disposable CI VM. It runs checks as this user
 * from a clone at the canonical paths' stand-ins. `probe: 'simulated'` reports what the real boundary proves on CI;
 * `probe: 'real'` runs the actual probe here, unisolated, and must be detected as a breach.
 */
function double(opts: { probe?: 'simulated' | 'real'; unavailable?: string[] } = {}) {
  const base = temp(), work = join(base, 'work'), reports = join(base, 'reports'), home = join(base, 'home'), pids = join(base, 'pids');
  mkdirSync(reports); mkdirSync(home);
  const map = (s: string) => s.replace(runner.SANDBOX.work, work).replace(runner.SANDBOX.reports, reports).replace(runner.SANDBOX.home, home);
  const WRAP = `const [cwd, env, argv, pids] = JSON.parse(process.argv[1]); const c = require('child_process').spawn(argv[0], argv.slice(1), { cwd, env, stdio: 'inherit', detached: true });
    require('fs').appendFileSync(pids, c.pid + '\\n'); c.on('error', () => process.exit(127)); c.on('exit', (code, sig) => sig ? process.kill(process.pid, sig) : process.exit(code));`;
  const args = (argv: string[], cwd: string, env: Record<string, string>) => [process.execPath, ['-e', WRAP, JSON.stringify([map(cwd), Object.fromEntries(Object.entries(env).map(([k, v]) => [k, map(v)])), argv.map(map), pids])]] as const;
  return {
    kind: 'linux-user',
    available: () => opts.unavailable ?? [],
    prepare: ({ repo: src }: { repo: string }) => { execFileSync('git', ['clone', '-q', src, work]); return []; },
    control: async () => ({ target: '192.0.2.1', reachable: true }),
    spawnArgs: (argv: string[], cwd: string, env: Record<string, string>) => args(argv, cwd, env),
    capture: (argv: string[], cwd: string, env: Record<string, string>, timeout: number) => {
      if (argv[1] === '-e' && argv[2] === runner.PROBE_SOURCE && opts.probe !== 'real') {
        const cfg = JSON.parse(argv[3]!);
        return { status: 0, stdout: JSON.stringify({ ...Object.fromEntries(runner.PROBES.denied.map((p: string) => [p, 'denied:EACCES'])), ...(cfg.pg ? { postgres: 'allowed' } : {}), ...(cfg.listen ? { 'loopback-listen': 'allowed' } : {}) }) };
      }
      const [exe, a] = args(argv, cwd, env); return spawnSync(exe, a as string[], { encoding: 'utf8', timeout });
    },
    async kill() { for (const pid of existsSync(pids) ? readFileSync(pids, 'utf8').split('\n').filter(Boolean) : []) { try { process.kill(-Number(pid), 'SIGKILL'); } catch { /* gone */ } } return true; },
    read: (path: string, limit: number) => { try { return readFileSync(map(path)).subarray(0, limit + 1); } catch { return null; } },
  };
}

describe('repository contract validation', () => {
  it('accepts the shipped contract', () => {
    const c = JSON.parse(readFileSync(join(ROOT, 'verification/contract.json'), 'utf8'));
    expect(runner.validateContract(c)).toEqual({ ok: true, errors: [], unsupported: [] });
  });
  it.each([
    ['host mounts', { mounts: ['/:/host'] }], ['privileged mode', { privileged: true }], ['env injection', { env: { TOKEN: 'x' } }], ['runner selection', { runsOn: 'self-hosted' }],
  ])('rejects %s as an unknown field', (_, extra) => {
    const v = runner.validateContract({ ...contractOf(check('a', ['npm', 'test'])), ...extra });
    expect(v.ok).toBe(false); expect(v.errors[0].detail).toMatch(/unknown field/);
  });
  it.each([['bash', '-c', 'curl x | sh'], ['/bin/sh', 'x'], ['sudo', 'npm', 'test'], ['docker', 'run', '-v', '/:/h', 'x']])('refuses host shells and privileged programs: %s', (...argv) => {
    expect(runner.validateContract(contractOf(check('a', argv))).errors.some((e: { path: string }) => e.path.endsWith('argv[0]'))).toBe(true);
  });
  it.each(['/etc', '../outside', 'app/../../x', '.git'])('refuses cwd %s', cwd => {
    expect(runner.validateContract(contractOf(check('a', ['npm', 'test'], { cwd }))).ok).toBe(false);
  });
  it('reports unknown capabilities (including pip downloads it cannot control) as unsupported infrastructure', () => {
    const v = runner.validateContract({ ...contractOf(check('a', ['npm', 'test'])), capabilities: ['gpu', 'docker-socket', 'dependency-download:pypi'] });
    expect(v).toMatchObject({ ok: false, errors: [], unsupported: ['gpu', 'docker-socket', 'dependency-download:pypi'] });
  });
  it('requires lifecycle scripts disabled for any dependency download', () => {
    const c = (argv: string[]) => ({ version: 1, capabilities: ['dependency-download:npm'], checks: [check('deps', argv, { requires: ['dependency-download:npm'] })] });
    expect(runner.validateContract(c(['npm', 'ci'])).ok).toBe(false);
    expect(runner.validateContract(c(['npm', 'install', '--ignore-scripts'])).ok).toBe(false);
    expect(runner.validateContract(c(['npm', 'ci', '--ignore-scripts'])).ok).toBe(true);
  });
  it('requires declared capabilities, a report placeholder per report and a report for a required count', () => {
    expect(runner.validateContract(contractOf(check('a', ['npm', 'test'], { requires: ['postgres'] }))).ok).toBe(false);
    expect(runner.validateContract(contractOf(check('a', ['npm', 'test'], { report: 'vitest-json' }))).ok).toBe(false);
    expect(runner.validateContract(contractOf(check('a', ['npm', 'test'], { count: 'required' }))).ok).toBe(false);
  });
});

describe('machine-reported counts', () => {
  const full = { numTotalTests: 3, numPassedTests: 3 };
  it('accepts a consistent report and agrees with the coordinator reading', () => {
    expect(runner.summarize(vitest(full))).toMatchObject({ total: 3, passed: 3, failed: 0, pending: 0, todo: 0 });
    expect(coordinatorSummarize(vitest(full)).count).toEqual(runner.summarize(vitest(full)));
  });
  it.each<[string, Record<string, unknown>]>([
    ['an omitted pending field', { ...full, numPendingTests: undefined }],
    ['an omitted todo field', { ...full, numTodoTests: undefined }],
    ['inconsistent totals', { numTotalTests: 5, numPassedTests: 3 }],
    ['more failed suites than suites', { ...full, numFailedTestSuites: 2 }],
    ['a failure count without typed failures', { numTotalTests: 1, numFailedTests: 1 }],
  ])('treats %s as unknown in runner and coordinator', (_, r) => {
    expect(runner.summarize(vitest(r))).toBe('unknown'); expect(coordinatorSummarize(vitest(r)).count).toBe('unknown');
  });
  it('types failures from the serialized error, never from log text', () => {
    expect(runner.failureKind('AssertionError: expected 500 to be 200')).toBe('assertion');
    expect(runner.failureKind('Error: connect ECONNREFUSED 127.0.0.1:5432')).toBe('service');
    expect(runner.failureKind('error: terminating connection due to administrator command')).toBe('service');
    expect(runner.failureKind("Error: Cannot find module 'pg'")).toBe('dependency');
    expect(runner.failureKind('Error: spawn EPERM')).toBe('permission');
    expect(runner.failureKind("TypeError: Cannot read properties of undefined (reading 'x')")).toBe('other');
    expect(runner.failureKind('Error: boom\n    at AssertionError (x.js:1)')).toBe('other');
  });
});

describe('backend preflight', () => {
  it('refuses a local host and a self-hosted runner; accepts only GitHub-hosted', () => {
    expect(runner.detectBackend({}).code).toBe('no-disposable-backend');
    expect(runner.detectBackend({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted' }).code).toBe('self-hosted-runner');
    expect(runner.detectBackend({ GITHUB_ACTIONS: 'true' }).code).toBe('self-hosted-runner');
    expect(runner.detectBackend(HOSTED).kind).toBe('github-hosted');
  });
  it('on a non-disposable host runs nothing and reports unavailable (exit 3)', async () => {
    const dir = repo(contractOf(check('a', node("require('fs').writeFileSync('ran','1')")))), out = temp();
    const ev = await runner.run({ repo: dir, out, env: { PATH: process.env.PATH, HOME: process.env.HOME }, sandbox: double() });
    expect(ev.result).toBe('unavailable'); expect(ev.checks[0].status).toBe('not-run'); expect(existsSync(join(dir, 'ran'))).toBe(false);
  });
  it('reports unavailable, not a pass, when the user and egress boundary cannot be established', async () => {
    const real = runner.linuxSandbox(() => ({ status: 1, stdout: '', stderr: 'sudo: a password is required' }));
    expect(real.available()[0]).toMatch(process.platform === 'linux' ? /passwordless sudo/ : /Linux VM/);
    const ev = await runner.run({ repo: repo(contractOf(check('a', ['npm', 'test']))), out: temp(), env: HOSTED, sandbox: double({ unavailable: ['iptables is unavailable'] }) });
    expect(ev.result).toBe('unavailable'); expect(ev.preflight.problems).toEqual([{ code: 'isolation-unavailable', detail: 'iptables is unavailable' }]);
  });
  it.each([['GITHUB_TOKEN'], ['ACTIONS_ID_TOKEN_REQUEST_TOKEN'], ['ACTIONS_RUNTIME_TOKEN'], ['NODE_AUTH_TOKEN']])('refuses to run with %s present', async name => {
    const dir = repo(contractOf(check('a', node("require('fs').writeFileSync('ran','1')"))));
    const ev = await runner.run({ repo: dir, out: temp(), env: { ...HOSTED, [name]: 'x' }, sandbox: double() });
    expect(ev.result).toBe('unavailable'); expect(ev.preflight.problems[0].code).toBe('credential-present'); expect(existsSync(join(dir, 'ran'))).toBe(false);
  });
  it('refuses persisted checkout credentials', async () => {
    const dir = repo(contractOf(check('a', ['npm', 'test'])));
    execFileSync('git', ['config', 'http.https://github.com/.extraheader', 'AUTHORIZATION: basic eA=='], { cwd: dir });
    const ev = await runner.run({ repo: dir, out: temp(), env: HOSTED, sandbox: double() });
    expect(ev.preflight.problems.map((p: { code: string }) => p.code)).toEqual(['checkout-credentials']);
  });
  it('refuses a non-loopback database and an unreachable declared service before any check', async () => {
    const c = { version: 1, capabilities: ['postgres'], checks: [check('a', node("require('fs').writeFileSync('ran','1')"), { requires: ['postgres'] })] };
    const dir = repo(c);
    const remote = await runner.run({ repo: dir, out: temp(), env: { ...HOSTED, PGHOST: 'db.example.com' }, sandbox: double() });
    expect(remote.preflight.problems[0]).toMatchObject({ code: 'non-loopback-database', capability: 'postgres' });
    const server = createServer(); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port; await new Promise(r => server.close(r));
    const down = await runner.run({ repo: dir, out: temp(), env: { ...HOSTED, PGHOST: '127.0.0.1', PGPORT: String(port) }, sandbox: double() });
    expect(down.result).toBe('unavailable'); expect(down.preflight.problems[0].code).toBe('service-unreachable'); expect(existsSync(join(dir, 'ran'))).toBe(false);
  });
  it('rejects an unsupported capability immediately', async () => {
    const ev = await runner.run({ repo: repo({ ...contractOf(check('a', ['npm', 'test'])), capabilities: ['gpu'] }), out: temp(), env: HOSTED, sandbox: double() });
    expect(ev.result).toBe('unavailable'); expect(ev.preflight.problems[0]).toMatchObject({ code: 'unsupported-capability', capability: 'gpu' });
    expect(await runner.main(['validate'], HOSTED, repo({ ...contractOf(check('a', ['npm', 'test'])), capabilities: ['gpu'] }))).toBe(3);
  });
  it('refuses an evidence directory inside the checkout', async () => {
    const dir = repo(contractOf(check('a', ['npm', 'test'])));
    expect(await runner.main(['run', '--out', join(dir, 'out')], HOSTED, dir, double())).toBe(2);
  });
});

describe('isolation boundary', () => {
  it('builds a fresh unprivileged user with loopback-only, DNS-less egress and runs checks through env -i as that user', () => {
    const calls: string[][] = [];
    const sudo = (args: string[]) => { calls.push(args); return { status: 0, stdout: args.includes('rev-parse') ? 'f'.repeat(40) + '\n' : '', stderr: '' }; };
    const sb = runner.linuxSandbox(sudo);
    expect(sb.prepare({ repo: repo(contractOf(check('a', ['npm', 'test']))), sha: 'f'.repeat(40) })).toEqual([]);
    expect(calls[1]).toEqual(['useradd', '--create-home', '--home-dir', '/home/sbverify', '--shell', '/usr/sbin/nologin', '--user-group', '--groups', 'sbverify-aux', 'sbverify']);
    const rules = calls.filter(c => c[0] === 'iptables').map(c => c.slice(5).join(' '));
    expect(rules).toEqual(['-m owner --uid-owner sbverify -j REJECT', '-m owner --uid-owner sbverify -o lo -j ACCEPT',
      '-m owner --uid-owner sbverify -p udp --dport 53 -j REJECT', '-m owner --uid-owner sbverify -p tcp --dport 53 -j REJECT']);
    expect(calls.filter(c => c[0] === 'ip6tables')).toHaveLength(4);
    expect(calls.flat().join(' ')).not.toMatch(/docker|--groups (?:sudo|adm)|-v |--privileged/);
    const [exe, args] = sb.spawnArgs(['npm', 'test'], '/home/sbverify/work/app', { PATH: '/usr/bin', HOME: '/home/sbverify' });
    expect([exe, ...args]).toEqual(['sudo', '-n', '-u', 'sbverify', '--', '/usr/bin/env', '-i', '-C', '/home/sbverify/work/app', 'PATH=/usr/bin', 'HOME=/home/sbverify', 'npm', 'test']);
  });
  it('the adversarial probe run without isolation reads evidence, signals the supervisor and is refused as infrastructure', async () => {
    const dir = repo(contractOf(check('a', node("require('fs').writeFileSync('ran','1')"))));
    const ev = await runner.run({ repo: dir, out: temp(), env: HOSTED, sandbox: double({ probe: 'real' }) });
    expect(ev.result).toBe('unavailable'); expect(ev.checks[0].status).toBe('not-run');
    expect(ev.isolation.probes).toMatchObject({ 'read-evidence': 'allowed', 'write-evidence': 'allowed', 'signal-supervisor': 'allowed' });
    expect(ev.preflight.problems.map((p: { detail: string }) => p.detail)).toEqual(expect.arrayContaining([expect.stringMatching(/^read-evidence: allowed/), expect.stringMatching(/^signal-supervisor: allowed/)]));
    expect(ev.preflight.problems.every((p: { code: string }) => p.code === 'isolation-unavailable')).toBe(true);
  }, 30_000); // the unisolated egress probe may wait out its own 5 s connect timeout
  it('judges every probe: a single allowed escape or a broken declared capability means no safe backend', () => {
    const ok = { ...Object.fromEntries(runner.PROBES.denied.map((p: string) => [p, 'denied:EACCES'])), postgres: 'allowed', 'loopback-listen': 'allowed' };
    expect(runner.judgeProbes(ok, ['postgres', 'loopback-listeners'])).toEqual([]);
    for (const name of runner.PROBES.denied) expect(runner.judgeProbes({ ...ok, [name]: 'allowed' }, [])).toEqual([`${name}: allowed (must be denied)`]);
    expect(runner.judgeProbes({ ...ok, postgres: 'denied:ECONNREFUSED' }, ['postgres'])).toEqual(['postgres: denied:ECONNREFUSED (declared postgres must work)']);
    expect(runner.judgeProbes(null, [])).toEqual(['the boundary probe produced no result']);
  });
  it('a check that tampers with the evidence directory is detected after it exits and stops the run as infrastructure', async () => {
    const out = temp();
    const dir = repo(contractOf(check('a', node(`require('fs').writeFileSync(${JSON.stringify(join(out, 'evidence.json'))}, '{"result":"pass"}')`)), check('b', node('0'))));
    const ev = await runner.run({ repo: dir, out, env: HOSTED, sandbox: double() });
    expect(ev.result).toBe('unavailable'); expect(ev.checks.map((c: { status: string }) => c.status)).toEqual(['pass', 'not-run']);
    expect(ev.preflight.problems[0]).toMatchObject({ code: 'isolation-breach', detail: expect.stringMatching(/unexpected files.*evidence\.json/) });
    expect(JSON.parse(readFileSync(join(out, 'evidence.json'), 'utf8')).result).toBe('unavailable'); // the supervisor's record wins
  });
  it('locks dependency sources to the approved registry with sha512 integrity', () => {
    const lock = (packages: Record<string, unknown>) => JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...packages } });
    const reg = runner.DOWNLOADS['dependency-download:npm'].registry;
    expect(runner.lockedSources(lock({ 'node_modules/a': { resolved: `${reg}a/-/a-1.tgz`, integrity: 'sha512-x' }, 'node_modules/w': { resolved: 'shared', link: true } }), reg)).toEqual([]);
    expect(runner.lockedSources(lock({ 'node_modules/a': { resolved: 'git+ssh://git@example.com/a.git' } }), reg)).toHaveLength(1);
    expect(runner.lockedSources(lock({ 'node_modules/a': { resolved: 'https://registry.example.com/a.tgz', integrity: 'sha512-x' } }), reg)).toHaveLength(1);
    expect(runner.lockedSources(lock({ 'node_modules/a': { resolved: `${reg}a.tgz`, integrity: 'sha1-x' } }), reg)).toHaveLength(1);
    expect(runner.lockedSources(readFileSync(join(ROOT, 'app/package-lock.json'), 'utf8'), reg)).toEqual([]);
  });
  it('the download proxy refuses every host but the approved registry', async () => {
    const proxy = await runner.downloadProxy(['registry.npmjs.org']);
    const ask = (line: string) => new Promise<string>(r => { const s = connect(proxy.port, '127.0.0.1', () => s.write(line)); let b = ''; s.on('data', d => { b += d; }); s.on('close', () => r(b)); s.on('error', () => r(b)); });
    expect(await ask('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n')).toMatch(/^HTTP\/1\.1 403/);
    expect(await ask('CONNECT registry.npmjs.org:80 HTTP/1.1\r\n\r\n')).toMatch(/^HTTP\/1\.1 403/);
    expect(await ask('GET http://registry.npmjs.org/ HTTP/1.1\r\n\r\n')).toMatch(/^HTTP\/1\.1 403/);
    await proxy.close(); expect(proxy.log).toEqual({ allowed: 0, denied: ['example.com', 'malformed', 'malformed'] });
  });
});

describe('execution and evidence on a disposable backend', () => {
  const policyFor = (c: { checks: ReturnType<typeof check>[] }) => VerificationPolicy.parse({
    version: 1, workflow: { path: '.github/workflows/ci.yml', job: 'app' }, capabilities: [],
    trustedFiles: { '.github/workflows/ci.yml': [sha256('wf')], 'scripts/verify.mjs': [sha256('runner')] },
    requiredChecks: c.checks.map(x => ({ id: x.id, argv: x.argv, covers: x.covers, count: x.count, cwd: x.cwd, requires: x.requires, report: (x as { report?: string }).report ?? null, minTimeoutSeconds: 1 })),
  });
  async function verified(c: ReturnType<typeof contractOf> & { checks: ReturnType<typeof check>[] }, env: Record<string, string> = HOSTED) {
    const dir = repo(c), out = temp();
    const ev = await runner.run({ repo: dir, out, env, sandbox: double() });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    const artifact = Object.fromEntries(ev.checks.flatMap((x: { log: { path: string } | null; report: { path: string } | null }) => [x.log, x.report]).filter(Boolean)
      .map((r: { path: string }) => [r.path, readFileSync(join(out, r.path))]));
    const decision = evaluate(policyFor(c), head, {
      run: { id: 101, run_attempt: 1, head_sha: head, path: '.github/workflows/ci.yml', event: 'pull_request', status: 'completed', conclusion: ev.result === 'pass' ? 'success' : 'failure' },
      jobs: [{ name: 'app', conclusion: null, runner_group_name: 'GitHub Actions', labels: ['ubuntu-latest'] }],
      evidence: JSON.parse(readFileSync(join(out, 'evidence.json'), 'utf8')), artifact,
      files: { 'verification/contract.json': readFileSync(join(dir, 'verification/contract.json'), 'utf8'), '.github/workflows/ci.yml': 'wf', 'scripts/verify.mjs': 'runner' } });
    return { ev, decision, out, head };
  }
  const tests = (r: Record<string, unknown>, exit: number) => contractOf(check('tests', report(r, exit), { report: 'vitest-json', count: 'required' }));
  it('passes with exact SHA, contract hash, resolved argv and cwd, exit code, machine count, hashed report and log', async () => {
    const { ev, decision, head } = await verified(tests({ numTotalTests: 3, numPassedTests: 3 }, 0));
    expect(ev.result).toBe('pass'); expect(ev.source).toEqual({ sha: head, clean: true });
    expect(ev.checks[0]).toMatchObject({ status: 'pass', exitCode: 0, signal: null, cwd: '/home/sbverify/work', count: { total: 3, passed: 3, failed: 0 } });
    expect(ev.checks[0].argv.at(-1)).toBe('/home/sbverify/reports/tests.json');
    expect(decision.failures).toEqual([]); expect(decision.record.checks[0]).toMatchObject({ cwd: '/home/sbverify/work', report: { path: 'reports/tests.json' } });
    expect(decision.record.isolation).toMatch(/^linux-user:sbverify egress loopback-only/);
  });
  it('routes failing tests typed as AssertionError to the original builder', async () => {
    const { decision } = await verified(tests({ numTotalTests: 2, numPassedTests: 1, ...failed(1, 'AssertionError: expected 1 to be 2') }, 1));
    expect(decision.failures).toEqual([expect.objectContaining({ type: 'assertion', route: 'builder', code: 'tests-failed', check: 'tests' })]);
    expect(decision.failures[0]!.detail).toContain('case 0: AssertionError: expected 1 to be 2');
  });
  it.each<[string, string, string, string]>([
    ['service loss after preflight', 'Error: Connection terminated unexpectedly', 'infrastructure', 'service-lost'],
    ['a module that fails to load', "Error: Cannot find module 'pg'", 'dependency', 'module-missing'],
    ['a permission denial', 'Error: spawn EPERM', 'infrastructure', 'sandbox-denied'],
    ['an untyped error', "TypeError: Cannot read properties of undefined (reading 'x')", 'unknown', 'untyped-failure'],
  ])('does not route %s to the builder', async (_, message, type, code) => {
    const { decision } = await verified(tests({ numTotalTests: 2, numPassedTests: 1, ...failed(1, message) }, 1));
    expect(decision.failures).toEqual([expect.objectContaining({ type, code })]); expect(decision.failures[0]!.route).not.toBe('builder');
  });
  it('a typed assertion mixed with a service failure is not an assertion', async () => {
    const r = { numTotalTests: 2, numFailedTests: 2, testResults: [{ status: 'failed', assertionResults: [{ status: 'failed', failureMessages: ['AssertionError: x'] }, { status: 'failed', failureMessages: ['Error: connect ECONNREFUSED 127.0.0.1:5432'] }] }] };
    expect((await verified(tests(r, 1))).decision.failures[0]).toMatchObject({ type: 'infrastructure', code: 'service-lost' });
  });
  it('does not infer an assertion from a nonzero exit or an assertion-looking log line', async () => {
    const { decision } = await verified(contractOf(check('build', node("console.log('AssertionError: expected 1 to be 2'); process.exit(1)"))));
    expect(decision.failures).toEqual([expect.objectContaining({ type: 'unknown', route: 'verifier-triage', code: 'unclassified' })]);
  });
  it('classifies a suite that failed to load with no test assertions by its typed error', async () => {
    const r = { numTotalTests: 0, numFailedTestSuites: 1, testResults: [{ name: 'a.test.ts', status: 'failed', message: 'Error: connect ECONNREFUSED 127.0.0.1:5432', assertionResults: [] }] };
    expect((await verified(tests(r, 1))).decision.failures[0]).toMatchObject({ type: 'infrastructure', code: 'service-lost' });
  });
  it('routes a dependency install failure to reproducible-environment repair and never passes the skipped checks', async () => {
    const c = contractOf(check('dependencies', node('process.exit(1)'), { covers: ['dependencies'] }), check('tests', node('process.exit(0)')));
    const { ev, decision } = await verified(c);
    expect(ev.checks.map((x: { status: string }) => x.status)).toEqual(['fail', 'not-run']);
    expect(decision.failures).toEqual([expect.objectContaining({ type: 'dependency', route: 'environment-repair' })]);
  });
  it('treats a timeout as unknown and kills the whole sandbox', async () => {
    const slow = await verified(contractOf(check('a', node('setTimeout(() => {}, 20000)'), { timeoutSeconds: 1 })));
    expect(slow.ev.checks[0].status).toBe('timeout'); expect(slow.decision.failures[0]).toMatchObject({ type: 'unknown', code: 'timeout' });
  });
  it.each<[string, Record<string, unknown>]>([
    ['a zero count', { numTotalTests: 0 }],
    ['pending (skipped) tests', { numTotalTests: 3, numPassedTests: 2, numPendingTests: 1 }],
    ['todo tests', { numTotalTests: 3, numPassedTests: 2, numTodoTests: 1 }],
    ['an omitted pending field', { numTotalTests: 3, numPassedTests: 3, numPendingTests: undefined }],
    ['inconsistent totals', { numTotalTests: 4, numPassedTests: 3 }],
  ])('a passing exit with %s never passes a required count', async (_, r) => {
    const { ev, decision } = await verified(tests(r, 0));
    expect(ev.checks[0].status).toBe('incomplete'); expect(decision.status).toBe('fail'); expect(decision.failures[0]).toMatchObject({ type: 'evidence', code: 'count-missing' });
  });
  it('passes no ambient secrets to checks; database settings only when postgres is declared', async () => {
    const env = { ...HOSTED, SOME_API_KEY: 'leak-me', PGHOST: '127.0.0.1' };
    const { out } = await verified(contractOf(check('a', node('console.log(JSON.stringify(process.env))'))), env);
    const seen = JSON.parse(readFileSync(join(out, 'logs/a.log'), 'utf8'));
    expect(seen.SOME_API_KEY).toBeUndefined(); expect(seen.PGHOST).toBeUndefined(); expect(seen.GITHUB_RUN_ID).toBeUndefined(); expect(seen.CI).toBe('true');
    expect(seen.HOME).toMatch(/\/home$/); // the sandbox home, never the supervisor's
  });
  it('bounds retained logs and records truncation', async () => {
    const { ev } = await verified(contractOf(check('a', node("process.stdout.write('x'.repeat(2100000))"))));
    expect(ev.checks[0].log).toMatchObject({ bytes: runner.LIMITS.logBytes, truncated: true });
  });
});
