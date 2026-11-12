import { sha256, VerificationPolicy } from '../src/verification/contract.js';
import type { Collected } from '../src/verification/evidence.js';

/** Shared fake data for the verification tests. Generic placeholders only. */
export const head = 'a'.repeat(40), other = 'd'.repeat(40), base = 'b'.repeat(40), merged = 'c'.repeat(40);
export const WF = 'name: ci\n', RUNNER = '// runner\n', LOG = 'Tests 5 passed\n';
export const TESTS_ARGV = ['npm', 'test', '--', '--outputFile.json={report}'];
export const REPORT = JSON.stringify({ numTotalTests: 5, numPassedTests: 5, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, numTotalTestSuites: 1, numFailedTestSuites: 0, testResults: [] });
export const COUNT = { total: 5, passed: 5, failed: 0, pending: 0, todo: 0, suites: 1, failedSuites: 0, kinds: { assertion: 0, service: 0, dependency: 0, permission: 0, other: 0 } };
export const contract = (extra: Record<string, unknown> = {}) => JSON.stringify({ version: 1, capabilities: ['postgres'], checks: [
  { id: 'build', covers: ['build'], cwd: 'app', argv: ['npm', 'run', 'build'], requires: [], timeoutSeconds: 60, count: 'none' },
  { id: 'tests', covers: ['unit', 'migrations'], cwd: 'app', argv: TESTS_ARGV, requires: ['postgres'], timeoutSeconds: 60, count: 'required', report: 'vitest-json' },
], ...extra });
export const required = { id: 'tests', argv: TESTS_ARGV, covers: ['unit'], count: 'required', cwd: 'app', requires: ['postgres'], report: 'vitest-json', minTimeoutSeconds: 60 };
export const policy = (extra: Record<string, unknown> = {}) => VerificationPolicy.parse({ version: 1, workflow: { path: '.github/workflows/ci.yml', job: 'app' },
  trustedFiles: { '.github/workflows/ci.yml': [sha256(WF)], 'scripts/verify.mjs': [sha256(RUNNER)] }, capabilities: ['postgres', 'loopback-listeners'],
  requiredChecks: [required], ...extra });
const DENIED = ['read-evidence', 'write-evidence', 'write-checkout', 'supervisor-environ', 'signal-supervisor', 'docker-socket', 'sudo', 'egress', 'dns-resolver', 'dns-lookup'];
export const isolation = () => ({ kind: 'linux-user', user: 'sbverify', egress: 'loopback-only', downloads: [] as string[], provided: ['postgres'], problems: [] as string[],
  probes: { ...Object.fromEntries(DENIED.map(p => [p, 'denied:EACCES'])), postgres: 'allowed' } as Record<string, string> });
export const ran = (id: string, argvTemplate: string[], extra: Record<string, unknown> = {}) => ({ id, covers: [], argvTemplate,
  argv: argvTemplate.map(a => a.replace('{report}', `/home/sbverify/reports/${id}.json`)), cwd: '/home/sbverify/work/app', status: 'pass', observed: 'exit', exitCode: 0, signal: null,
  count: 'unknown', report: null, log: { path: `logs/${id}.log`, bytes: Buffer.byteLength(LOG), sha256: sha256(LOG), truncated: false }, ...extra });
/** Exact-commit evidence that passes: what a healthy CI run of the configured workflow produces. */
export function good(text = contract()): Collected {
  return {
    run: { id: 7, run_attempt: 1, head_sha: head, path: '.github/workflows/ci.yml', event: 'pull_request', status: 'completed', conclusion: 'success' },
    jobs: [{ name: 'app', conclusion: 'success', runner_group_name: 'GitHub Actions', labels: ['ubuntu-latest'] }],
    evidence: { version: 2, source: { sha: head, clean: true }, contract: { path: 'verification/contract.json', sha256: sha256(text) },
      backend: { kind: 'github-hosted', provenance: { GITHUB_RUN_ID: '7', GITHUB_RUN_ATTEMPT: '1', RUNNER_ENVIRONMENT: 'github-hosted' } },
      startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:10:00Z', preflight: { status: 'ready', problems: [] }, isolation: isolation(), result: 'pass', problems: [],
      checks: [ran('build', ['npm', 'run', 'build']), ran('tests', TESTS_ARGV, { count: COUNT, report: { path: 'reports/tests.json', bytes: Buffer.byteLength(REPORT), sha256: sha256(REPORT) } })] },
    artifact: { 'logs/build.log': LOG, 'logs/tests.log': LOG, 'reports/tests.json': REPORT },
    files: { 'verification/contract.json': text, '.github/workflows/ci.yml': WF, 'scripts/verify.mjs': RUNNER },
  };
}
