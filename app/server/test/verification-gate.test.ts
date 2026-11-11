import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { admit, sha256, VerificationPolicy, type Failure } from '../src/verification/contract.js';
import { activationPending, evaluate, type Collected } from '../src/verification/evidence.js';
import { collect, GitHubVerificationSource } from '../src/verification/github.js';
import { runReview, type GateIO, type Job, type Snapshot, type Verdict } from '../src/review/gate.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const head = 'a'.repeat(40), other = 'd'.repeat(40), base = 'b'.repeat(40), merged = 'c'.repeat(40);
const WF = 'name: ci\n', RUNNER = '// runner\n', LOG = 'Tests 5 passed\n';
const contract = (extra: Record<string, unknown> = {}) => JSON.stringify({ version: 1, capabilities: ['postgres'], checks: [
  { id: 'build', covers: ['build'], cwd: 'app', argv: ['npm', 'run', 'build'], requires: [], timeoutSeconds: 60, count: 'none' },
  { id: 'tests', covers: ['unit', 'migrations'], cwd: 'app', argv: ['npm', 'test', '--', '--outputFile.json={report}'], requires: ['postgres'], timeoutSeconds: 60, count: 'required', report: 'vitest-json' },
], ...extra });
const policy = (extra: Record<string, unknown> = {}) => VerificationPolicy.parse({ version: 1, workflow: { path: '.github/workflows/ci.yml', job: 'app' },
  trustedFiles: { '.github/workflows/ci.yml': [sha256(WF)], 'scripts/verify.mjs': [sha256(RUNNER)] }, capabilities: ['postgres', 'loopback-listeners'],
  requiredChecks: [{ id: 'tests', argv: ['npm', 'test', '--', '--outputFile.json={report}'], covers: ['unit'], count: 'required' }], ...extra });
const ran = (id: string, argvTemplate: string[], extra: Record<string, unknown> = {}) => ({ id, covers: [], argvTemplate, status: 'pass', observed: 'exit', exitCode: 0, signal: null,
  count: 'unknown', log: { path: `logs/${id}.log`, bytes: Buffer.byteLength(LOG), sha256: sha256(LOG), truncated: false }, ...extra });
function good(text = contract()): Collected {
  return {
    run: { id: 7, run_attempt: 1, head_sha: head, path: '.github/workflows/ci.yml', event: 'pull_request', status: 'completed', conclusion: 'success' },
    jobs: [{ name: 'app', conclusion: 'success', runner_group_name: 'GitHub Actions', labels: ['ubuntu-latest'] }],
    evidence: { version: 1, source: { sha: head, clean: true }, contract: { path: 'verification/contract.json', sha256: sha256(text) },
      backend: { kind: 'github-hosted', provenance: { GITHUB_RUN_ID: '7', GITHUB_RUN_ATTEMPT: '1', RUNNER_ENVIRONMENT: 'github-hosted' } },
      preflight: { status: 'ready', problems: [] }, result: 'pass',
      checks: [ran('build', ['npm', 'run', 'build']), ran('tests', ['npm', 'test', '--', '--outputFile.json={report}'], { count: { total: 5, passed: 5, failed: 0, skipped: 0, suites: 1, failedSuites: 0 } })] },
    logs: { 'logs/build.log': LOG, 'logs/tests.log': LOG },
    files: { 'verification/contract.json': text, '.github/workflows/ci.yml': WF, 'scripts/verify.mjs': RUNNER },
  };
}
type Ev = { checks: Record<string, unknown>[]; [k: string]: unknown };
const codes = (c: Collected, p = policy()) => evaluate(p, head, c).failures.map(f => `${f.type}:${f.code}`);

describe('trusted evidence evaluation', () => {
  it('passes exact-commit evidence from the configured hosted workflow', () => {
    const d = evaluate(policy(), head, good());
    expect(d.status).toBe('pass'); expect(d.record).toMatchObject({ head, runId: 7, contractHash: sha256(contract()), runner: 'GitHub Actions [ubuntu-latest]' });
  });
  it.each<[string, (c: Collected) => void, string]>([
    ['stale run SHA', c => { c.run!.head_sha = other; }, 'evidence:stale-run'],
    ['evidence for another commit', c => { (c.evidence as Ev).source = { sha: other, clean: true }; }, 'evidence:stale-evidence'],
    ['dirty source', c => { (c.evidence as Ev).source = { sha: head, clean: false }; }, 'evidence:stale-evidence'],
    ['changed contract after the run', c => { c.files['verification/contract.json'] = contract({ externalIntegrations: [] }); }, 'evidence:contract-mismatch'],
    ['an unpinned workflow edit', c => { c.files['.github/workflows/ci.yml'] = WF + 'permissions: write-all\n'; }, 'verifier-trust:trusted-file-changed'],
    ['an unpinned runner edit', c => { c.files['scripts/verify.mjs'] = RUNNER + 'process.exit(0)\n'; }, 'verifier-trust:trusted-file-changed'],
    ['a deleted runner', c => { c.files['scripts/verify.mjs'] = null; }, 'verifier-trust:trusted-file-missing'],
    ['another workflow', c => { c.run!.path = '.github/workflows/pr-owned.yml'; }, 'evidence:untrusted-workflow'],
    ['a self-hosted job', c => { c.jobs[0]!.labels = ['self-hosted', 'ubuntu-latest']; c.jobs[0]!.runner_group_name = 'Default'; }, 'infrastructure:untrusted-runner'],
    ['no run', c => { c.run = null; }, 'evidence:run-missing'],
    ['a pending run', c => { c.run!.status = 'in_progress'; }, 'evidence:run-pending'],
    ['missing evidence', c => { c.evidence = null; }, 'evidence:evidence-malformed'],
    ['evidence copied from another run', c => { (c.evidence as Ev).backend = { kind: 'github-hosted', provenance: { GITHUB_RUN_ID: '6', GITHUB_RUN_ATTEMPT: '1', RUNNER_ENVIRONMENT: 'github-hosted' } }; }, 'evidence:run-mismatch'],
    ['a forged pass', c => { (c.evidence as Ev).checks[0]!.exitCode = 1; }, 'evidence:forged-pass'],
    ['a tampered log', c => { c.logs['logs/build.log'] = 'all good'; }, 'evidence:log-mismatch'],
    ['a missing log', c => { delete c.logs['logs/tests.log']; }, 'evidence:log-missing'],
    ['a partial run', c => { (c.evidence as Ev).checks.pop(); }, 'evidence:check-missing'],
    ['a skipped required check', c => { Object.assign((c.evidence as Ev).checks[1]!, { status: 'not-run', log: null }); }, 'evidence:check-not-run'],
    ['a different command', c => { (c.evidence as Ev).checks[1]!.argvTemplate = ['npm', 'run', 'lint']; }, 'evidence:argv-mismatch'],
    ['an unknown count on a required count', c => { (c.evidence as Ev).checks[1]!.count = 'unknown'; }, 'evidence:count-missing'],
    ['a failed run conclusion', c => { c.run!.conclusion = 'failure'; }, 'unknown:conclusion-mismatch'],
  ])('refuses %s', (_, mutate, expected) => {
    const c = good(); mutate(c); expect(codes(c)).toContain(expected); expect(evaluate(policy(), head, c).status).toBe('fail');
  });
  it('reports an unavailable declared capability as infrastructure for the verifier', () => {
    const c = good(); Object.assign(c.evidence as Ev, { result: 'unavailable', preflight: { status: 'unavailable', problems: [{ code: 'service-unreachable', detail: 'postgres down', capability: 'postgres' }] },
      checks: (c.evidence as Ev).checks.map(x => ({ ...x, status: 'not-run', log: null })) });
    c.run!.conclusion = 'failure';
    expect(evaluate(policy(), head, c).failures).toEqual([expect.objectContaining({ type: 'infrastructure', route: 'verifier', code: 'service-unreachable' })]);
  });
});

describe('admission before builder launch', () => {
  it('admits the shipped contract under the example installation policy', () => {
    const p = VerificationPolicy.parse(JSON.parse(readFileSync(join(ROOT, 'app/deploy/verification-policy.example.json'), 'utf8')));
    expect(admit(readFileSync(join(ROOT, 'verification/contract.json'), 'utf8'), p)).toMatchObject({ status: 'admitted', failures: [] });
  });
  it.each([['gpu', 'unsupported-capability'], ['dependency-download:pypi', 'capability-not-offered']])('reports %s as verification infrastructure unavailable', (cap, code) => {
    const a = admit(contract({ capabilities: ['postgres', cap] }), policy());
    expect(a.status).toBe('unavailable'); expect(a.failures[0]).toMatchObject({ type: 'infrastructure', route: 'verifier', code });
  });
  it.each<[string, string | null, string]>([
    ['a missing contract', null, 'contract-missing'],
    ['host mounts', contract({ mounts: ['/:/host'] }), 'contract-invalid'],
    ['a shell executable', contract().replace('"npm","run","build"', '"bash","-c","build"'), 'contract-invalid'],
    ['a dropped required check', JSON.stringify({ ...JSON.parse(contract()), checks: [JSON.parse(contract()).checks[0]] }), 'required-check-missing'],
    ['a rewritten required command', contract().replace('"npm","test","--"', '"node","-e","0","--"'), 'required-check-changed'],
    ['a weakened required count', contract().replace('"count":"required","report"', '"count":"optional","report"'), 'required-check-weakened'],
  ])('refuses %s', (_, text, code) => {
    const a = admit(text, policy()); expect(a.status).toBe('invalid'); expect(a.failures.map(f => f.code)).toContain(code);
  });
  it('rejects a self-hosted switch in installation policy', () => {
    expect(() => policy({ runner: { group: 'GitHub Actions', labels: ['ubuntu-latest'], selfHosted: true } })).toThrow();
    expect(() => policy({ trustedFiles: { '.github/workflows/ci.yml': [sha256(WF)] } })).toThrow(/scripts\/verify.mjs/);
  });
});

describe('external integration evidence and activation', () => {
  const OBS = '{"status":200,"scopes":["read"]}';
  const withIntegration = (evidence: unknown[]) => contract({ externalIntegrations: [{ id: 'photos', operation: 'GET /v1/media', flag: 'PHOTOS_ENABLED', offStateCheck: 'tests',
    assumptions: [{ id: 'token-scope', statement: 'A read token lists media', evidence }] }] });
  const collected = (text: string) => { const c = good(text); c.files['verification/observed/photos.json'] = OBS; return c; };
  it('fixtures alone leave the integration experimental and block merge by default', () => {
    const d = evaluate(policy(), head, collected(withIntegration([{ kind: 'fixture', path: 'app/test/fixtures/photos.json' }])));
    expect(d.integrations[0]).toMatchObject({ status: 'experimental', reasons: [expect.stringMatching(/fixtures do not establish/)] });
    expect(d.failures).toEqual([expect.objectContaining({ type: 'external-contract', route: 'integration-validation' })]);
  });
  it('merge-disabled needs explicit installation policy and a provable off state, and then never completes', () => {
    const text = withIntegration([{ kind: 'fixture', path: 'app/test/fixtures/photos.json' }]);
    const d = evaluate(policy({ mergeDisabled: true }), head, collected(text));
    expect(d.status).toBe('pass'); expect(d.integrations[0]!.offStateProven).toBe(true);
    expect(activationPending(d.integrations, merged, {})).toEqual([expect.stringMatching(/^merge-disabled: photos stays off/)]);
    const unproven = collected(text); (unproven.evidence as Ev).checks[1]!.count = { total: 5, passed: 4, failed: 1, skipped: 0, suites: 1, failedSuites: 0 };
    Object.assign((unproven.evidence as Ev).checks[1]!, { status: 'fail', exitCode: 1 }); unproven.run!.conclusion = 'failure';
    expect(evaluate(policy({ mergeDisabled: true }), head, unproven).failures.map(f => f.type)).toEqual(['assertion']);
  });
  it('an observed response must match its pinned hash', () => {
    expect(evaluate(policy(), head, collected(withIntegration([{ kind: 'observed-response', path: 'verification/observed/photos.json', sha256: sha256('other') }]))).integrations[0]!.status).toBe('experimental');
    expect(evaluate(policy(), head, collected(withIntegration([{ kind: 'observed-response', path: 'verification/observed/photos.json', sha256: sha256(OBS) }]))).integrations[0]!.status).toBe('supported');
  });
  it('a supported integration still needs live authorization and an observed integration on the exact revision', () => {
    const d = evaluate(policy(), head, collected(withIntegration([{ kind: 'documentation', url: 'https://docs.example.com/media', quote: 'Read tokens may list media.' }])));
    expect(d.status).toBe('pass');
    const receipt = (r: Record<string, unknown>) => ({ photos: { integration: 'photos', revision: merged, authorized: true, observed: true, evidenceSha256: sha256('x'), ...r } });
    expect(activationPending(d.integrations, merged, {})).toEqual([expect.stringMatching(/no live receipt/)]);
    expect(activationPending(d.integrations, merged, receipt({ revision: other }))).toEqual([expect.stringMatching(/no live receipt/)]);
    expect(activationPending(d.integrations, merged, receipt({ authorized: false }))).toEqual([expect.stringMatching(/owner authorization/)]);
    expect(activationPending(d.integrations, merged, receipt({ observed: false }))).toEqual([expect.stringMatching(/live integration/)]);
    expect(activationPending(d.integrations, merged, receipt({}))).toEqual([]);
  });
});

describe('GitHub collector', () => {
  it.each([false, true])('reads only the configured artifact of the exact run (log path traversal %s)', async traverse => {
    const calls: string[][] = [], text = contract();
    const gh = async (args: string[]) => {
      calls.push(args);
      if (args[1]?.includes('/actions/runs?')) return JSON.stringify({ workflow_runs: [good().run, { ...good().run, id: 9, path: '.github/workflows/other.yml' }, { ...good().run, id: 8, head_sha: other }] });
      if (args[1]?.includes('/jobs')) return JSON.stringify({ jobs: good().jobs });
      if (args[1]?.includes('/artifacts')) return JSON.stringify({ artifacts: [{ name: 'verification-evidence', size_in_bytes: 100, expired: false, workflow_run: { id: 7 } }] });
      const dir = args[args.indexOf('--dir') + 1]!; mkdirSync(join(dir, 'logs'));
      const ev = good(text).evidence as Ev; if (traverse) ev.checks[0]!.log = { ...(ev.checks[0]!.log as object), path: 'logs/../../../etc/passwd' };
      writeFileSync(join(dir, 'evidence.json'), JSON.stringify(ev)); writeFileSync(join(dir, 'logs/tests.log'), LOG); writeFileSync(join(dir, 'logs/build.log'), LOG);
      return '';
    };
    const files: Record<string, string> = { 'verification/contract.json': text, '.github/workflows/ci.yml': WF, 'scripts/verify.mjs': RUNNER };
    const git = async (args: string[]) => { const f = files[args[1]!.split(':')[1]!]; if (f === undefined) throw new Error('missing'); return f; };
    const c = await collect(new GitHubVerificationSource(gh, git, 'example/engine'), policy(), head);
    expect(c.run!.id).toBe(7);
    expect(calls.find(a => a[0] === 'run')).toEqual(['run', 'download', '7', '--repo', 'example/engine', '--name', 'verification-evidence', '--dir', expect.any(String)]);
    if (traverse) { expect(c.logs).toEqual({}); expect(codes(c)).toEqual(['evidence:evidence-malformed']); } // strict log schema: nothing read
    else { expect(Object.keys(c.logs).sort()).toEqual(['logs/build.log', 'logs/tests.log']); expect(codes(c)).toEqual([]); }
  });
});

describe('review gate with trusted verification', () => {
  const snapshot = (): Snapshot => ({ repo: 'example/engine', pr: 7, head, base, branch: 'main', merged: null, checks: [{ name: 'app', state: 'pass' }],
    sources: [{ ref: 'ticket', revision: '1', text: 'Acceptance: tests', essential: true, missing: false, truncated: false }] });
  const checked = () => ({ status: 'checked' as const, evidence: ['ticket'], rationale: 'Verified' });
  function fixture(failures: Failure[] = [], pending: string[] = []) {
    const job: Job = { id: 1, card: 't_123abc', builder: 'builder', reviewer: 'auditor', target: 'test', round: 0, state: 'queued', snapshot: null, verdict: null, merged: null, deployed: null };
    let current = snapshot(); const order: string[] = [], rejected: string[] = []; let completions = 0;
    const state = { failures, pending };
    const io: GateIO = {
      async gather() { return structuredClone(current); },
      async review(s, e) { order.push('review'); return { decision: 'accept', reviewer: 'auditor', repo: s.repo, pr: s.pr, head: s.head, base: s.base, evidence: e, findings: [],
        categories: { security: checked(), compatibility: checked(), migrations: checked(), regressions: checked(), scope: checked(), placeholders: checked(), tests: checked() } } satisfies Verdict; },
      async save(patch) { Object.assign(job, patch); },
      async reject(text) { rejected.push(text); },
      async merge() { order.push('merge'); current.merged = merged; return merged; },
      async deploy(r) { order.push('deploy'); return r; }, async health(r) { order.push('health'); return r === merged; },
      async verifyMerge() {}, async complete() { completions++; },
      async verify(s) { order.push(`verify:${s.head.slice(0, 1)}`); return { failures: state.failures, checks: ['app'] }; },
      async activation() { order.push('activation'); return state.pending; },
    };
    return { job, io, order, rejected, state, setCurrent(s: Snapshot) { current = s; }, completions: () => completions };
  }
  const f = (type: Failure['type'], route: Failure['route'], code = 'x'): Failure => ({ type, route, code, detail: `${code} detail`, check: 'tests' });
  it('verifies before independent review, then merge, deploy, health and completion', async () => {
    const t = fixture(); await runReview(t.job, ['app'], t.io);
    expect(t.order).toEqual(['verify:a', 'review', 'verify:a', 'merge', 'deploy', 'health', 'activation']); expect(t.job.state).toBe('done'); expect(t.completions()).toBe(1);
  });
  it('returns a real assertion to the original builder with the command and failure', async () => {
    const t = fixture([f('assertion', 'builder', 'tests-failed')]); t.setCurrent({ ...snapshot(), checks: [{ name: 'app', state: 'fail' }] });
    await runReview(t.job, ['app'], t.io);
    expect(t.job.state).toBe('rejected'); expect(t.order).not.toContain('review'); expect(t.job.builder).toBe('builder');
    expect(t.rejected[0]).toContain('tests-failed detail'); expect(t.rejected[0]).not.toContain('Fix the failure in app'); // red CI job not double-reported
  });
  it.each<[Failure['type'], Failure['route']]>([['infrastructure', 'verifier'], ['dependency', 'environment-repair'], ['unknown', 'verifier-triage'], ['evidence', 'verifier'], ['verifier-trust', 'owner'], ['external-contract', 'integration-validation']])(
    'blocks %s failures for %s without returning them to the builder, even when CI is red', async (type, route) => {
      const t = fixture([f(type, route)]); t.setCurrent({ ...snapshot(), checks: [{ name: 'app', state: 'fail' }] });
      await runReview(t.job, ['app'], t.io);
      expect(t.job.state).toBe('blocked'); expect(t.job.error).toContain(`${type} -> ${route}`); expect(t.rejected).toEqual([]); expect(t.order).not.toContain('review');
    });
  it('a changed head after approval invalidates the approval before merge', async () => {
    const t = fixture(); const review = t.io.review;
    t.io.review = async (s, e) => { const v = await review(s, e); t.setCurrent({ ...snapshot(), head: other }); return v; };
    await runReview(t.job, ['app'], t.io);
    expect(t.job.state).toBe('blocked'); expect(t.job.verdict).toBeNull(); expect(t.order).not.toContain('merge');
  });
  it('a verification regression found just before merge clears approval', async () => {
    const t = fixture(); const review = t.io.review;
    t.io.review = async (s, e) => { const v = await review(s, e); t.state.failures = [f('evidence', 'verifier', 'stale-run')]; return v; };
    await runReview(t.job, ['app'], t.io);
    expect(t.job.state).toBe('blocked'); expect(t.job.verdict).toBeNull(); expect(t.order).not.toContain('merge');
  });
  it('merge-disabled and activation-pending stay open after deploy and health: no false done', async () => {
    const t = fixture([], ['merge-disabled: photos stays off (PHOTOS_ENABLED); external contract unverified']);
    await runReview(t.job, ['app'], t.io);
    expect(t.job).toMatchObject({ state: 'blocked', merged, deployed: merged, health: merged }); expect(t.job.error).toMatch(/^merge-disabled/); expect(t.completions()).toBe(0);
    t.state.pending = ['activation-pending: photos awaits owner authorization'];
    await runReview(t.job, ['app'], t.io); expect(t.job.state).toBe('blocked'); expect(t.completions()).toBe(0);
    expect(t.order.filter(x => x === 'merge' || x === 'deploy')).toEqual(['merge', 'deploy']); // no replayed effects
    t.state.pending = []; await runReview(t.job, ['app'], t.io); expect(t.job.state).toBe('done'); expect(t.completions()).toBe(1);
  });
});

describe('CI workflow hardening', () => {
  const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const app = ci.slice(ci.indexOf('\n  app:'), ci.indexOf('\n  python:'));
  it('runs the shared entry point on a hosted VM with a read-only token, no secrets and no persisted checkout credentials', () => {
    expect(ci).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(ci).not.toMatch(/secrets\.|self-hosted|write-all|id-token/);
    expect(app).toContain('runs-on: ubuntu-latest'); expect(app).toContain('persist-credentials: false'); expect(app).toMatch(/timeout-minutes: \d+/);
    expect(app).toContain('node scripts/verify.mjs run --out "$RUNNER_TEMP/verification"'); expect(app).toContain('name: verification-evidence');
    expect(app).toContain('github.event.pull_request.head.sha');
    expect(app).not.toMatch(/docker\.sock|volumes:|privileged|options: .*--network/);
  });
});
