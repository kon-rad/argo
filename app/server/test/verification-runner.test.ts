import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// The repository-authored runner. The coordinator never imports it; these tests do.
import * as runner from '../../../scripts/verify.mjs';
import { evaluate } from '../src/verification/evidence.js';
import { sha256, VerificationPolicy } from '../src/verification/contract.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const HOSTED = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_RUN_ID: '101', GITHUB_RUN_ATTEMPT: '1', PATH: process.env.PATH!, HOME: process.env.HOME! };
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'verify-test-')); dirs.push(d); return d; };
const node = (code: string) => ['node', '-e', code];
const check = (id: string, argv: string[], extra: Record<string, unknown> = {}) => ({ id, covers: ['unit'], cwd: '.', argv, requires: [], timeoutSeconds: 30, count: 'none', ...extra });
const report = (r: Record<string, number>, exit: number) => node(`require('fs').writeFileSync(process.argv[1], JSON.stringify(${JSON.stringify({ numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, numTotalTestSuites: 1, numFailedTestSuites: 0, ...r })})); process.exit(${exit})`).concat('{report}');

function repo(contract: unknown): string {
  const dir = temp();
  mkdirSync(join(dir, 'verification'));
  writeFileSync(join(dir, 'verification/contract.json'), JSON.stringify(contract));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgSign=false', ...args], { cwd: dir, stdio: 'pipe' });
  git('init', '-q'); git('add', '.'); git('commit', '-q', '-m', 'fixture');
  return dir;
}
const contractOf = (...checks: unknown[]) => ({ version: 1, capabilities: [], checks });

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
  it('reports unknown capabilities as unsupported infrastructure, not a syntax error', () => {
    const v = runner.validateContract({ ...contractOf(check('a', ['npm', 'test'])), capabilities: ['gpu', 'docker-socket'] });
    expect(v).toMatchObject({ ok: false, errors: [], unsupported: ['gpu', 'docker-socket'] });
  });
  it('requires declared capabilities, a report placeholder per report and a report for a required count', () => {
    expect(runner.validateContract(contractOf(check('a', ['npm', 'test'], { requires: ['postgres'] }))).ok).toBe(false);
    expect(runner.validateContract(contractOf(check('a', ['npm', 'test'], { report: 'vitest-json' }))).ok).toBe(false);
    expect(runner.validateContract(contractOf(check('a', ['npm', 'test'], { count: 'required' }))).ok).toBe(false);
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
    const ev = await runner.run({ repo: dir, out, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    expect(ev.result).toBe('unavailable'); expect(ev.checks[0].status).toBe('not-run'); expect(existsSync(join(dir, 'ran'))).toBe(false);
  });
  it.each([['GITHUB_TOKEN'], ['ACTIONS_ID_TOKEN_REQUEST_TOKEN'], ['NODE_AUTH_TOKEN']])('refuses to run with %s present', async name => {
    const dir = repo(contractOf(check('a', node("require('fs').writeFileSync('ran','1')"))));
    const ev = await runner.run({ repo: dir, out: temp(), env: { ...HOSTED, [name]: 'x' } });
    expect(ev.result).toBe('unavailable'); expect(ev.preflight.problems[0].code).toBe('credential-present'); expect(existsSync(join(dir, 'ran'))).toBe(false);
  });
  it('refuses persisted checkout credentials', async () => {
    const dir = repo(contractOf(check('a', ['npm', 'test'])));
    execFileSync('git', ['config', 'http.https://github.com/.extraheader', 'AUTHORIZATION: basic eA=='], { cwd: dir });
    const ev = await runner.run({ repo: dir, out: temp(), env: HOSTED });
    expect(ev.preflight.problems.map((p: { code: string }) => p.code)).toEqual(['checkout-credentials']);
  });
  it('refuses a non-loopback database and an unreachable declared service before any check', async () => {
    const c = { version: 1, capabilities: ['postgres'], checks: [check('a', node("require('fs').writeFileSync('ran','1')"), { requires: ['postgres'] })] };
    const dir = repo(c);
    const remote = await runner.run({ repo: dir, out: temp(), env: { ...HOSTED, PGHOST: 'db.example.com' } });
    expect(remote.preflight.problems[0]).toMatchObject({ code: 'non-loopback-database', capability: 'postgres' });
    const server = createServer(); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port; await new Promise(r => server.close(r));
    const down = await runner.run({ repo: dir, out: temp(), env: { ...HOSTED, PGHOST: '127.0.0.1', PGPORT: String(port) } });
    expect(down.result).toBe('unavailable'); expect(down.preflight.problems[0].code).toBe('service-unreachable'); expect(existsSync(join(dir, 'ran'))).toBe(false);
  });
  it('rejects an unsupported capability immediately', async () => {
    const ev = await runner.run({ repo: repo({ ...contractOf(check('a', ['npm', 'test'])), capabilities: ['gpu'] }), out: temp(), env: HOSTED });
    expect(ev.result).toBe('unavailable'); expect(ev.preflight.problems[0]).toMatchObject({ code: 'unsupported-capability', capability: 'gpu' });
    expect(await runner.main(['validate'], HOSTED, repo({ ...contractOf(check('a', ['npm', 'test'])), capabilities: ['gpu'] }))).toBe(3);
  });
  it('refuses an evidence directory inside the checkout', async () => {
    const dir = repo(contractOf(check('a', ['npm', 'test'])));
    expect(await runner.main(['run', '--out', join(dir, 'out')], HOSTED, dir)).toBe(2);
  });
});

describe('execution and evidence on a disposable backend', () => {
  const policyFor = (dir: string, c: { checks: { id: string; argv: string[]; covers: string[]; count: string }[] }) => VerificationPolicy.parse({
    version: 1, workflow: { path: '.github/workflows/ci.yml', job: 'app' }, capabilities: [],
    trustedFiles: { '.github/workflows/ci.yml': [sha256('wf')], 'scripts/verify.mjs': [sha256('runner')] },
    requiredChecks: c.checks.map(x => ({ id: x.id, argv: x.argv, covers: x.covers, count: x.count })),
  });
  async function verified(c: ReturnType<typeof contractOf> & { checks: ReturnType<typeof check>[] }, env: Record<string, string> = HOSTED) {
    const dir = repo(c), out = temp();
    const ev = await runner.run({ repo: dir, out, env });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    const logs = Object.fromEntries(ev.checks.filter((x: { log: unknown }) => x.log).map((x: { log: { path: string } }) => [x.log.path, readFileSync(join(out, x.log.path))]));
    const decision = evaluate(policyFor(dir, c as never), head, {
      run: { id: 101, run_attempt: 1, head_sha: head, path: '.github/workflows/ci.yml', event: 'pull_request', status: 'completed', conclusion: ev.result === 'pass' ? 'success' : 'failure' },
      jobs: [{ name: 'app', conclusion: null, runner_group_name: 'GitHub Actions', labels: ['ubuntu-latest'] }],
      evidence: JSON.parse(readFileSync(join(out, 'evidence.json'), 'utf8')), logs,
      files: { 'verification/contract.json': readFileSync(join(dir, 'verification/contract.json'), 'utf8'), '.github/workflows/ci.yml': 'wf', 'scripts/verify.mjs': 'runner' } });
    return { ev, decision, out, head };
  }
  it('passes with exact SHA, contract hash, argv, exit code, machine count and a hashed log', async () => {
    const { ev, decision, head } = await verified(contractOf(check('tests', report({ numTotalTests: 3, numPassedTests: 3 }, 0), { report: 'vitest-json', count: 'required' })));
    expect(ev.result).toBe('pass'); expect(ev.source).toEqual({ sha: head, clean: true });
    expect(ev.checks[0]).toMatchObject({ status: 'pass', exitCode: 0, count: { total: 3, passed: 3, failed: 0 } });
    expect(decision.status).toBe('pass'); expect(decision.record.checks[0]!.log!.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it('routes a machine-reported failing test to the original builder as an assertion', async () => {
    const { decision } = await verified(contractOf(check('tests', report({ numTotalTests: 2, numPassedTests: 1, numFailedTests: 1 }, 1), { report: 'vitest-json', count: 'required' })));
    expect(decision.failures).toEqual([expect.objectContaining({ type: 'assertion', route: 'builder', code: 'tests-failed', check: 'tests' })]);
  });
  it('does not infer an assertion from a nonzero exit or an assertion-looking log line', async () => {
    const { decision } = await verified(contractOf(check('build', node("console.log('AssertionError: expected 1 to be 2'); process.exit(1)"))));
    expect(decision.failures).toEqual([expect.objectContaining({ type: 'unknown', route: 'verifier-triage', code: 'unclassified' })]);
  });
  it('classifies a suite that failed before assertions (a service, say) as unknown, not assertion', async () => {
    const { decision } = await verified(contractOf(check('tests', report({ numTotalTests: 0, numFailedTestSuites: 1 }, 1), { report: 'vitest-json', count: 'required' })));
    expect(decision.failures[0]).toMatchObject({ type: 'unknown', code: 'suite-error' });
  });
  it('routes a dependency install failure to reproducible-environment repair and never passes the skipped checks', async () => {
    const c = contractOf(check('dependencies', node('process.exit(1)'), { covers: ['dependencies'] }), check('tests', node('process.exit(0)')));
    const { ev, decision } = await verified(c);
    expect(ev.checks.map((x: { status: string }) => x.status)).toEqual(['fail', 'not-run']);
    expect(decision.failures).toEqual([expect.objectContaining({ type: 'dependency', route: 'environment-repair' })]);
  });
  it('routes a missing executable to the verifier and treats a timeout as unknown', async () => {
    const missing = await verified(contractOf(check('a', ['node', '--version'])), { ...HOSTED, PATH: '/nonexistent' });
    expect(missing.decision.failures[0]).toMatchObject({ type: 'infrastructure', route: 'verifier', code: 'executable-unavailable' });
    const slow = await verified(contractOf(check('a', node('setTimeout(() => {}, 20000)'), { timeoutSeconds: 1 })));
    expect(slow.ev.checks[0].status).toBe('timeout'); expect(slow.decision.failures[0]).toMatchObject({ type: 'unknown', code: 'timeout' });
  });
  it('a passing exit with a missing or zero required count never passes', async () => {
    const { ev, decision } = await verified(contractOf(check('tests', report({ numTotalTests: 0 }, 0), { report: 'vitest-json', count: 'required' })));
    expect(ev.checks[0].status).toBe('incomplete'); expect(decision.failures[0]).toMatchObject({ type: 'evidence', code: 'count-missing' });
  });
  it('passes no ambient secrets or database settings to checks', async () => {
    const env = { ...HOSTED, SOME_API_KEY: 'leak-me', PGHOST: '127.0.0.1' };
    const { out } = await verified(contractOf(check('a', node('console.log(JSON.stringify(process.env))'))), env);
    const seen = JSON.parse(readFileSync(join(out, 'logs/a.log'), 'utf8'));
    expect(seen.SOME_API_KEY).toBeUndefined(); expect(seen.PGHOST).toBeUndefined(); expect(seen.GITHUB_RUN_ID).toBeUndefined(); expect(seen.CI).toBe('true');
  });
  it('bounds retained logs and records truncation', async () => {
    const { ev } = await verified(contractOf(check('a', node("process.stdout.write('x'.repeat(2100000))"))));
    expect(ev.checks[0].log).toMatchObject({ bytes: runner.LIMITS.logBytes, truncated: true });
  });
});
