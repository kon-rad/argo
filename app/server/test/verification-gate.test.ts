import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { admit, sha256, VerificationPolicy, type Failure } from '../src/verification/contract.js';
import { activationPending, evaluate, offStatePending, type Collected } from '../src/verification/evidence.js';
import { runReview, type GateIO, type Job, type Snapshot, type Verdict } from '../src/review/gate.js';
import { base, contract, COUNT, good, head, isolation, merged, other, policy, ran, REPORT, RUNNER, TESTS_ARGV, WF } from './verification-fixtures.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
type Ev = { checks: Record<string, unknown>[]; isolation: ReturnType<typeof isolation>; [k: string]: unknown };
const codes = (c: Collected, p = policy()) => evaluate(p, head, c).failures.map(f => `${f.type}:${f.code}`);
const withReport = (c: Collected, r: Record<string, unknown>, count: unknown) => {
  const text = JSON.stringify({ numTotalTests: 5, numPassedTests: 5, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, numTotalTestSuites: 1, numFailedTestSuites: 0, testResults: [], ...r });
  c.artifact['reports/tests.json'] = text; Object.assign((c.evidence as Ev).checks[1]!, { count, report: { path: 'reports/tests.json', bytes: Buffer.byteLength(text), sha256: sha256(text) } });
};

describe('trusted evidence evaluation', () => {
  it('passes exact-commit evidence from the configured hosted workflow with a proven sandbox', () => {
    const d = evaluate(policy(), head, good());
    expect(d.failures).toEqual([]); expect(d.record).toMatchObject({ head, runId: 7, contractHash: sha256(contract()), runner: 'GitHub Actions [ubuntu-latest]', isolation: expect.stringMatching(/^linux-user:sbverify/) });
    expect(d.record.checks[1]).toMatchObject({ argv: ['npm', 'test', '--', '--outputFile.json=/home/sbverify/reports/tests.json'], cwd: '/home/sbverify/work/app' });
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
    ['old-format evidence', c => { (c.evidence as Ev).version = 1; }, 'evidence:evidence-malformed'],
    ['an extra field in a record', c => { (c.evidence as Ev).checks[0]!.trusted = true; }, 'evidence:evidence-malformed'],
    ['evidence copied from another run', c => { (c.evidence as Ev).backend = { kind: 'github-hosted', provenance: { GITHUB_RUN_ID: '6', GITHUB_RUN_ATTEMPT: '1', RUNNER_ENVIRONMENT: 'github-hosted' } }; }, 'evidence:run-mismatch'],
    ['no isolation record', c => { (c.evidence as Ev).isolation = null as never; }, 'infrastructure:isolation-unproven'],
    ['an escaped probe', c => { (c.evidence as Ev).isolation.probes['read-evidence'] = 'allowed'; }, 'infrastructure:isolation-unproven'],
    ['open egress', c => { (c.evidence as Ev).isolation.probes.egress = 'allowed'; }, 'infrastructure:isolation-unproven'],
    ['a declared service the sandbox could not reach', c => { (c.evidence as Ev).isolation.probes.postgres = 'denied:ECONNREFUSED'; }, 'infrastructure:isolation-unproven'],
    ['a same-user backend', c => { (c.evidence as Ev).isolation.kind = 'same-user'; }, 'infrastructure:isolation-unproven'],
    ['a duplicate record', c => { (c.evidence as Ev).checks.push({ ...(c.evidence as Ev).checks[0]!, exitCode: 1, status: 'fail' }); }, 'evidence:duplicate-record'],
    ['an extra record', c => { (c.evidence as Ev).checks.push(ran('lint', ['npm', 'run', 'lint'])); }, 'evidence:extra-record'],
    ['a forged pass (exit)', c => { (c.evidence as Ev).checks[0]!.exitCode = 1; }, 'evidence:forged-pass'],
    ['a forged pass (signal)', c => { (c.evidence as Ev).checks[0]!.signal = 'SIGKILL'; }, 'evidence:forged-pass'],
    ['a pass with failing tests in its report', c => withReport(c, { numPassedTests: 4, numFailedTests: 1, testResults: [{ status: 'failed', assertionResults: [{ status: 'failed', failureMessages: ['AssertionError: x'] }] }] },
      { ...COUNT, passed: 4, failed: 1, kinds: { ...COUNT.kinds, assertion: 1 } }), 'evidence:forged-pass'],
    ['a changed cwd', c => { (c.evidence as Ev).checks[1]!.cwd = '/home/sbverify/work'; }, 'evidence:cwd-mismatch'],
    ['a changed resolved argv', c => { (c.evidence as Ev).checks[1]!.argv = ['npm', 'test', '--', '--outputFile.json=/tmp/forged.json']; }, 'evidence:argv-mismatch'],
    ['a different command', c => { (c.evidence as Ev).checks[1]!.argvTemplate = ['npm', 'run', 'lint']; }, 'evidence:argv-mismatch'],
    ['a tampered log', c => { c.artifact['logs/build.log'] = 'all good'; }, 'evidence:log-mismatch'],
    ['a missing log', c => { delete c.artifact['logs/tests.log']; }, 'evidence:log-missing'],
    ['a tampered report', c => { c.artifact['reports/tests.json'] = REPORT.replace('"numTotalTests":5', '"numTotalTests":6'); }, 'evidence:report-mismatch'],
    ['a recorded count that disagrees with its report', c => { (c.evidence as Ev).checks[1]!.count = { ...COUNT, total: 50, passed: 50 }; }, 'evidence:count-mismatch'],
    ['a partial run', c => { (c.evidence as Ev).checks.pop(); }, 'evidence:check-missing'],
    ['a skipped required check', c => { Object.assign((c.evidence as Ev).checks[1]!, { status: 'not-run', log: null, report: null, count: 'unknown' }); }, 'evidence:check-not-run'],
    ['an unknown count on a required count', c => { delete c.artifact['reports/tests.json']; Object.assign((c.evidence as Ev).checks[1]!, { report: null, count: 'unknown' }); }, 'evidence:count-missing'],
    ['skipped tests in a required count', c => withReport(c, { numPassedTests: 4, numPendingTests: 1 }, { ...COUNT, passed: 4, pending: 1 }), 'evidence:tests-skipped'],
    ['a failed run conclusion', c => { c.run!.conclusion = 'failure'; }, 'unknown:conclusion-mismatch'],
  ])('refuses %s', (_, mutate, expected) => {
    const c = good(); mutate(c); expect(codes(c)).toContain(expected); expect(evaluate(policy(), head, c).status).toBe('fail');
  });
  it('reports an unavailable declared capability as infrastructure for the verifier', () => {
    const c = good(); Object.assign(c.evidence as Ev, { result: 'unavailable', isolation: null, preflight: { status: 'unavailable', problems: [{ code: 'service-unreachable', detail: 'postgres down', capability: 'postgres' }] },
      checks: (c.evidence as Ev).checks.map(x => ({ ...x, status: 'not-run', log: null, report: null, count: 'unknown' })) });
    c.run!.conclusion = 'failure';
    expect(evaluate(policy(), head, c).failures).toEqual([expect.objectContaining({ type: 'infrastructure', route: 'verifier', code: 'service-unreachable' })]);
  });
});

describe('admission before builder launch', () => {
  it('admits the shipped contract under the example installation policy', () => {
    const p = VerificationPolicy.parse(JSON.parse(readFileSync(join(ROOT, 'app/deploy/verification-policy.example.json'), 'utf8')));
    expect(admit(readFileSync(join(ROOT, 'verification/contract.json'), 'utf8'), p)).toMatchObject({ status: 'admitted', failures: [] });
  });
  it.each([['gpu', 'unsupported-capability'], ['dependency-download:pypi', 'unsupported-capability'], ['loopback-listeners', 'capability-not-offered']])('reports %s as verification infrastructure unavailable', (cap, code) => {
    const a = admit(contract({ capabilities: ['postgres', cap] }), policy({ capabilities: ['postgres'] }));
    expect(a.status).toBe('unavailable'); expect(a.failures[0]).toMatchObject({ type: 'infrastructure', route: 'verifier', code });
  });
  const tests = (patch: Record<string, unknown>) => { const c = JSON.parse(contract()); Object.assign(c.checks[1], patch); return JSON.stringify(c); };
  it.each<[string, string | null, string]>([
    ['a missing contract', null, 'contract-missing'],
    ['host mounts', contract({ mounts: ['/:/host'] }), 'contract-invalid'],
    ['a shell executable', contract().replace('"npm","run","build"', '"bash","-c","build"'), 'contract-invalid'],
    ['dependency downloads with lifecycle scripts', contract({ capabilities: ['postgres', 'dependency-download:npm'], checks: [...JSON.parse(contract()).checks,
      { id: 'deps', covers: ['dependencies'], cwd: 'app', argv: ['npm', 'ci'], requires: ['dependency-download:npm'], timeoutSeconds: 60, count: 'none' }] }), 'contract-invalid'],
    ['a dropped required check', JSON.stringify({ ...JSON.parse(contract()), checks: [JSON.parse(contract()).checks[0]] }), 'required-check-missing'],
    ['a rewritten required command', tests({ argv: ['node', '-e', '0', '--', '{report}'] }), 'required-check-changed'],
    ['a moved working directory', tests({ cwd: 'zen-agent' }), 'required-check-changed'],
    ['a dropped postgres requirement', tests({ requires: [] }), 'required-check-changed'],
    ['a changed report type', tests({ report: undefined, count: 'optional', argv: ['npm', 'test'] }), 'required-check-changed'],
    ['a shortened timeout', tests({ timeoutSeconds: 5 }), 'required-check-changed'],
    ['narrower coverage', tests({ covers: ['migrations'] }), 'required-check-changed'],
    ['a weakened required count', tests({ count: 'optional' }), 'required-check-changed'],
  ])('refuses %s', (_, text, code) => {
    const a = admit(text, policy({ capabilities: ['postgres', 'loopback-listeners', 'dependency-download:npm'] })); expect(a.status).toBe('invalid'); expect(a.failures.map(f => f.code)).toContain(code);
  });
  it('rejects a self-hosted switch and unpinned trusted files in installation policy', () => {
    expect(() => policy({ runner: { group: 'GitHub Actions', labels: ['ubuntu-latest'], selfHosted: true } })).toThrow();
    expect(() => policy({ trustedFiles: { '.github/workflows/ci.yml': [sha256(WF)] } })).toThrow(/scripts\/verify.mjs/);
    expect(() => policy({ requiredChecks: [{ id: 'tests', argv: TESTS_ARGV, covers: ['unit'], count: 'required' }] })).toThrow(); // every field must be pinned
  });
});

describe('external integration evidence, off state and activation', () => {
  const OBS = '{"status":200,"scopes":["read"]}', DOC = 'https://docs.example.com/media', QUOTE = 'Read tokens may list media.';
  const withIntegration = (evidence: unknown[]) => contract({ externalIntegrations: [{ id: 'photos', operation: 'GET /v1/media', flag: 'PHOTOS_ENABLED', offStateCheck: 'tests',
    assumptions: [{ id: 'token-scope', statement: 'A read token lists media', evidence }] }] });
  const collected = (text: string, documents: Record<string, string | null> = {}) => { const c = good(text); c.files['verification/observed/photos.json'] = OBS; c.documents = documents; return c; };
  const doc = [{ kind: 'documentation', url: DOC, quote: QUOTE }];
  const trusted = { externalEvidence: { documentationOrigins: ['https://docs.example.com'], observed: [] } };
  it('fixtures alone leave the integration experimental and block merge by default', () => {
    const d = evaluate(policy(), head, collected(withIntegration([{ kind: 'fixture', path: 'app/test/fixtures/photos.json' }])));
    expect(d.integrations[0]).toMatchObject({ status: 'experimental', reasons: [expect.stringMatching(/fixtures do not establish/)] });
    expect(d.failures).toEqual([expect.objectContaining({ type: 'external-contract', route: 'integration-validation' })]);
  });
  it.each<[string, Record<string, unknown>, Record<string, string | null>]>([
    ['a fabricated quote on an unapproved origin', {}, { [DOC]: `<p>${QUOTE}</p>` }],
    ['an approved origin whose page does not contain the quote', trusted, { [DOC]: '<p>Read tokens may not list media.</p>' }],
    ['an approved origin the coordinator could not fetch', trusted, { [DOC]: null }],
  ])('documentation is not support for %s', (_, extra, documents) => {
    expect(evaluate(policy(extra), head, collected(withIntegration(doc), documents)).integrations[0]!.status).toBe('experimental');
  });
  it('documentation counts when the coordinator found the quote itself on an approved origin', () => {
    expect(evaluate(policy(trusted), head, collected(withIntegration(doc), { [DOC]: '<html><p>Read tokens\n may <b>list</b> media.</p></html>' })).integrations[0]!.status).toBe('supported');
  });
  it('an observed response must match its hash and be recorded by an integration validator in policy', () => {
    const obs = (h: string) => withIntegration([{ kind: 'observed-response', path: 'verification/observed/photos.json', sha256: h }]);
    expect(evaluate(policy(), head, collected(obs(sha256('other')))).integrations[0]!.status).toBe('experimental');
    expect(evaluate(policy(), head, collected(obs(sha256(OBS)))).integrations[0]!.status).toBe('experimental'); // builder-written, not validated
    expect(evaluate(policy({ externalEvidence: { observed: [sha256(OBS)] } }), head, collected(obs(sha256(OBS)))).integrations[0]!.status).toBe('supported');
  });
  it('merge-disabled needs explicit policy, a passing off-state check and a target that attests the flag is off', () => {
    const text = withIntegration([{ kind: 'fixture', path: 'app/test/fixtures/photos.json' }]);
    const d = evaluate(policy({ mergeDisabled: true }), head, collected(text));
    expect(d.status).toBe('pass'); expect(d.integrations[0]).toMatchObject({ mergeDisabled: true, offStateCheckPassed: true });
    const receipt = (r: Record<string, unknown>) => ({ photos: { target: 'prod', flag: 'PHOTOS_ENABLED', enabled: false, evidenceSha256: sha256('x'), ...r } });
    expect(offStatePending(d.integrations, 'prod', {})).toEqual([expect.stringMatching(/^off-state-unproven/)]);
    expect(offStatePending(d.integrations, 'prod', receipt({ enabled: true }))).toEqual([expect.stringMatching(/^off-state-violated: PHOTOS_ENABLED is already on/)]);
    expect(offStatePending(d.integrations, 'prod', receipt({ target: 'staging' }))).toEqual([expect.stringMatching(/^off-state-unproven/)]);
    expect(offStatePending(d.integrations, 'prod', receipt({}))).toEqual([]);
    expect(activationPending(d.integrations, merged, {})).toEqual([expect.stringMatching(/^merge-disabled: photos stays off/)]);
  });
  it('a real assertion and an unrelated external blocker are both retained', () => {
    const c = collected(withIntegration([{ kind: 'fixture', path: 'app/test/fixtures/photos.json' }]));
    withReport(c, { numPassedTests: 4, numFailedTests: 1, numFailedTestSuites: 1, testResults: [{ status: 'failed', assertionResults: [{ status: 'failed', fullName: 'lists', failureMessages: ['AssertionError: x'] }] }] },
      { ...COUNT, passed: 4, failed: 1, failedSuites: 1, kinds: { ...COUNT.kinds, assertion: 1 } });
    Object.assign((c.evidence as Ev).checks[1]!, { status: 'fail', exitCode: 1 }); c.run!.conclusion = 'failure';
    expect(evaluate(policy({ mergeDisabled: true }), head, c).failures.map(f => `${f.type}:${f.route}`)).toEqual(['assertion:builder', 'external-contract:integration-validation']);
  });
  it('a supported integration still needs live authorization and an observed integration on the exact revision', () => {
    const d = evaluate(policy(trusted), head, collected(withIntegration(doc), { [DOC]: QUOTE }));
    expect(d.status).toBe('pass');
    const receipt = (r: Record<string, unknown>) => ({ photos: { integration: 'photos', revision: merged, authorized: true, observed: true, evidenceSha256: sha256('x'), ...r } });
    expect(activationPending(d.integrations, merged, {})).toEqual([expect.stringMatching(/no live receipt/)]);
    expect(activationPending(d.integrations, merged, receipt({ revision: other }))).toEqual([expect.stringMatching(/no live receipt/)]);
    expect(activationPending(d.integrations, merged, receipt({ authorized: false }))).toEqual([expect.stringMatching(/owner authorization/)]);
    expect(activationPending(d.integrations, merged, receipt({ observed: false }))).toEqual([expect.stringMatching(/live integration/)]);
    expect(activationPending(d.integrations, merged, receipt({}))).toEqual([]);
  });
});

describe('review gate with trusted verification', () => {
  const snapshot = (): Snapshot => ({ repo: 'example/engine', pr: 7, head, base, branch: 'main', merged: null, checks: [{ name: 'app', state: 'pass' }],
    sources: [{ ref: 'ticket', revision: '1', text: 'Acceptance: tests', essential: true, missing: false, truncated: false }] });
  const checked = () => ({ status: 'checked' as const, evidence: ['ticket'], rationale: 'Verified' });
  function fixture(failures: Failure[] = [], pending: string[] = []) {
    const job: Job = { id: 1, card: 't_123abc', builder: 'builder', reviewer: 'auditor', target: 'test', round: 0, state: 'queued', snapshot: null, verdict: null, merged: null, deployed: null };
    let current = snapshot(); const order: string[] = [], rejected: string[] = []; let completions = 0;
    const state = { failures, pending, off: [] as string[], offAt: [] as string[] };
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
      async offState(r) { order.push(`off:${r.slice(0, 1)}`); return state.offAt.includes(r) || !state.offAt.length ? state.off : []; },
      async activation() { order.push('activation'); return state.pending; },
    };
    return { job, io, order, rejected, state, setCurrent(s: Snapshot) { current = s; }, completions: () => completions };
  }
  const f = (type: Failure['type'], route: Failure['route'], code = 'x'): Failure => ({ type, route, code, detail: `${code} detail`, check: 'tests' });
  it('verifies before independent review, proves the off state at the target, then merge, deploy, health and completion', async () => {
    const t = fixture(); await runReview(t.job, ['app'], t.io);
    expect(t.order).toEqual(['verify:a', 'review', 'verify:a', 'off:a', 'merge', 'off:c', 'deploy', 'health', 'activation']); expect(t.job.state).toBe('done'); expect(t.completions()).toBe(1);
  });
  it('returns a real assertion to the original builder with the command and failure', async () => {
    const t = fixture([f('assertion', 'builder', 'tests-failed')]); t.setCurrent({ ...snapshot(), checks: [{ name: 'app', state: 'fail' }] });
    await runReview(t.job, ['app'], t.io);
    expect(t.job.state).toBe('rejected'); expect(t.order).not.toContain('review'); expect(t.job.builder).toBe('builder'); expect(t.job.error ?? null).toBeNull();
    expect(t.rejected[0]).toContain('tests-failed detail'); expect(t.rejected[0]).not.toContain('Fix the failure in app'); // red CI job not double-reported
  });
  it('routes an assertion to the builder and retains an unrelated external blocker for its own route', async () => {
    const t = fixture([f('external-contract', 'integration-validation', 'unverified-external-contract'), f('assertion', 'builder', 'tests-failed'), f('evidence', 'verifier', 'log-missing')]);
    await runReview(t.job, ['app'], t.io);
    expect(t.job.state).toBe('rejected'); expect(t.rejected[0]).toContain('tests-failed detail'); expect(t.rejected[0]).not.toContain('unverified-external-contract');
    expect(t.job.error).toMatch(/^Retained blockers for other routes: Verification evidence -> verifier \[log-missing\].*external-contract -> integration-validation \[unverified-external-contract\]/);
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
  it('a target whose flag is already on blocks merge-disabled code before merge, and before deploy if it turns on after merge', async () => {
    const t = fixture(); t.state.off = ['off-state-violated: PHOTOS_ENABLED is already on at test; merge-disabled code must not ship there'];
    await runReview(t.job, ['app'], t.io);
    expect(t.job.state).toBe('blocked'); expect(t.job.error).toMatch(/^off-state-violated/); expect(t.order).not.toContain('merge');
    const u = fixture(); u.state.off = ['off-state-violated: PHOTOS_ENABLED is already on at test']; u.state.offAt = [merged];
    await runReview(u.job, ['app'], u.io);
    expect(u.job).toMatchObject({ state: 'blocked', merged, deployed: null }); expect(u.order).toContain('merge'); expect(u.order).not.toContain('deploy');
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
  it('runs the shared entry point on a hosted VM with a read-only token, no secrets, no persisted credentials and no shared npm cache', () => {
    expect(ci).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(ci).not.toMatch(/secrets\.|self-hosted|write-all|id-token/);
    expect(app).toContain('runs-on: ubuntu-latest'); expect(app).toContain('persist-credentials: false'); expect(app).toMatch(/timeout-minutes: \d+/);
    expect(app).toContain('node scripts/verify.mjs run --out "$RUNNER_TEMP/verification"'); expect(app).toContain('name: verification-evidence');
    expect(app).toContain('github.event.pull_request.head.sha');
    expect(app).not.toMatch(/docker\.sock|volumes:|privileged|options: .*--network|cache: npm|npm (?:ci|install|test)/);
  });
});
