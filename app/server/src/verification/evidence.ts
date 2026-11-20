import { z } from 'zod';
import { admit, ALLOWED_PROBES, DENIED_PROBES, failure, resolvedCheck, Sha, Sha256, sha256, type Check, type Contract, type Failure, type Integration, type VerificationPolicy } from './contract.js';

/** What the trusted coordinator obtained itself: GitHub run metadata, the run's artifact, Git objects at the head and fetched documents. */
export type RunInfo = { id: number; head_sha: string; path: string; event: string; status: string; conclusion: string | null; run_attempt?: number; created_at?: string };
export type JobInfo = { name: string; conclusion: string | null; runner_group_name: string | null; labels: string[] };
export type Collected = { run: RunInfo | null; jobs: JobInfo[]; evidence: unknown; artifact: Record<string, string | Buffer>; files: Record<string, string | null>; documents?: Record<string, string | null> };

const Int = z.number().int().min(0);
const Kinds = z.object({ assertion: Int, service: Int, dependency: Int, permission: Int, other: Int }).strict();
const Count = z.union([z.literal('unknown'), z.object({ total: Int, passed: Int, failed: Int, pending: Int, todo: Int, suites: Int, failedSuites: Int, kinds: Kinds }).strict()]);
export type Count = z.infer<typeof Count>;
const Ref = (pattern: RegExp) => z.object({ path: z.string().regex(pattern), bytes: Int, sha256: Sha256 }).strict();
const LOG = /^logs\/[a-z][a-z0-9-]{0,39}\.log$/, REPORT = /^reports\/[a-z][a-z0-9-]{0,39}\.json$/;
const RunnerCheck = z.object({ id: z.string(), covers: z.array(z.string()), argvTemplate: z.array(z.string()), argv: z.array(z.string()), cwd: z.string(),
  status: z.enum(['pass', 'fail', 'error', 'timeout', 'incomplete', 'not-run']), observed: z.string().optional(), detail: z.string().optional(),
  exitCode: z.number().int().nullable(), signal: z.string().nullable(), durationMs: Int.optional(), count: Count, report: Ref(REPORT).nullable(),
  downloads: z.object({ allowed: Int, denied: z.array(z.string()) }).strict().optional(), log: Ref(LOG).extend({ truncated: z.boolean() }).strict().nullable() }).strict();
const Isolation = z.object({ kind: z.string(), user: z.string(), egress: z.string(), downloads: z.array(z.string()), probes: z.record(z.string(), z.string()).nullable(),
  provided: z.array(z.string()), problems: z.array(z.string()) }).strict();
export const RunnerEvidence = z.object({ version: z.literal(2), source: z.object({ sha: Sha.nullable(), clean: z.boolean() }).strict(),
  contract: z.object({ path: z.string(), sha256: Sha256.nullable() }).strict(), backend: z.object({ kind: z.string(), code: z.string().optional(), detail: z.string().optional(), provenance: z.record(z.string(), z.string()) }).strict(),
  startedAt: z.string(), finishedAt: z.string(),
  preflight: z.object({ status: z.string(), problems: z.array(z.object({ code: z.string(), detail: z.string(), capability: z.string().optional() }).strict()) }).passthrough().nullable(),
  isolation: Isolation.nullable(), checks: z.array(RunnerCheck).max(20), result: z.enum(['pass', 'fail', 'invalid', 'unavailable']), problems: z.array(z.unknown()) }).strict();
type RunnerCheck = z.infer<typeof RunnerCheck>;
export const ARTIFACT_LIMITS = { evidence: 1_000_000, log: 2_000_000, report: 10_000_000 };
export const artifactName = (name: string) => name === 'evidence.json' || LOG.test(name) || REPORT.test(name);
export const artifactLimit = (name: string) => name === 'evidence.json' ? ARTIFACT_LIMITS.evidence : LOG.test(name) ? ARTIFACT_LIMITS.log : ARTIFACT_LIMITS.report;

export type IntegrationStatus = { id: string; flag: string; status: 'supported' | 'experimental'; offStateCheckPassed: boolean; mergeDisabled: boolean; reasons: string[] };
export type CheckRecord = { id: string; argv: string[]; cwd: string; status: string; exitCode: number | null; count: Count; report: { path: string; sha256: string } | null; log: { path: string; sha256: string; bytes: number; truncated: boolean } | null };
export type Decision = {
  status: 'pass' | 'fail'; head: string; failures: Failure[]; integrations: IntegrationStatus[];
  /** Deterministic for one run, so it can be review evidence without churning the approval fingerprint. */
  record: { head: string; contractHash: string | null; workflow: string; runId: number | null; runAttempt: number | null; runner: string | null; isolation: string | null; checks: CheckRecord[]; failures: Failure[]; integrations: IntegrationStatus[] };
};

const tail = (text: string | Buffer | undefined, n = 1500) => { const s = String(text ?? ''); return s.length > n ? '...' + s.slice(-n) : s; };

/** Failure type from the error name and code the test runner serialized. Mirrors scripts/verify.mjs failureKind. */
export function failureKind(message: unknown): keyof z.infer<typeof Kinds> {
  const first = String(message ?? '').split('\n')[0]!;
  if (/^\s*AssertionError\b/.test(first)) return 'assertion';
  const text = String(message ?? '').slice(0, 4000);
  if (/\b(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|ENOTFOUND|57P01|57P03|08006|08001)\b|Connection terminated|terminating connection due to administrator command|the database system is (?:starting up|shutting down)/.test(text)) return 'service';
  if (/\b(ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND)\b|Cannot find (?:module|package)\b|Failed to load url\b/.test(text)) return 'dependency';
  if (/\b(EACCES|EPERM)\b|permission denied/i.test(text)) return 'permission';
  return 'other';
}
type Report = { testResults?: { name?: string; status?: string; message?: string; assertionResults?: { status?: string; fullName?: string; failureMessages?: string[] }[] }[] } & Record<string, unknown>;
const FIELDS = ['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests', 'numTodoTests', 'numTotalTestSuites', 'numFailedTestSuites'] as const;
/** The coordinator's own reading of a vitest JSON report. Mirrors scripts/verify.mjs summarize. */
export function summarize(text: string | Buffer): { count: Count; failing: string[] } {
  let r: Report; try { r = JSON.parse(String(text)) as Report; } catch { return { count: 'unknown', failing: [] }; }
  if (!r || typeof r !== 'object' || FIELDS.some(k => !Number.isSafeInteger(r[k]) || (r[k] as number) < 0)) return { count: 'unknown', failing: [] };
  const [total, passed, failed, pending, todo, suites, failedSuites] = FIELDS.map(k => r[k] as number) as [number, number, number, number, number, number, number];
  if (passed + failed + pending + todo !== total || failedSuites > suites) return { count: 'unknown', failing: [] };
  const kinds = { assertion: 0, service: 0, dependency: 0, permission: 0, other: 0 }, failing: string[] = [];
  let typed = 0;
  for (const file of Array.isArray(r.testResults) ? r.testResults : []) {
    const tests = Array.isArray(file?.assertionResults) ? file.assertionResults : [];
    for (const t of tests) if (t?.status === 'failed') {
      typed++; const message = Array.isArray(t.failureMessages) ? t.failureMessages[0] : ''; kinds[failureKind(message)]++;
      if (failing.length < 10) failing.push(`${String(t.fullName ?? '').slice(0, 200)}: ${String(message ?? '').split('\n')[0]!.slice(0, 300)}`);
    }
    if (file?.status === 'failed' && !tests.some(t => t?.status === 'failed')) kinds[failureKind(file.message)]++;
  }
  if (typed !== failed) return { count: 'unknown', failing: [] };
  return { count: { total, passed, failed, pending, todo, suites, failedSuites, kinds }, failing };
}

/**
 * Typed routing. An assertion needs every failure to be a machine-typed AssertionError in the test runner's own
 * report; a nonzero exit, a log line or an untyped error is never enough. Service, module and permission failures
 * route to the verifier or environment repair; anything ambiguous stays unknown.
 */
export function classify(contract: Check, ran: RunnerCheck, count: Count, failing: string[], log?: string | Buffer): Failure | null {
  if (ran.status === 'pass') return null;
  const where = `${ran.id}: \`${ran.argv.join(' ')}\` in ${ran.cwd} exit ${ran.exitCode ?? 'none'}${ran.log ? `, log ${ran.log.path} sha256 ${ran.log.sha256}` : ''}`;
  if (ran.status === 'incomplete') return failure('evidence', 'count-missing', `${where}; a required machine-reported test count is missing, zero, skipped or failing`, ran.id);
  if (ran.status === 'error') return failure('infrastructure', 'executable-unavailable', `${where}; the verifier could not start the check`, ran.id);
  if (ran.observed === 'signal') return failure('infrastructure', 'killed', `${where}; killed by ${ran.signal ?? 'a signal'} (resource limit or sandbox)`, ran.id);
  if (ran.status === 'timeout') return failure('unknown', 'timeout', `${where}; exceeded ${contract.timeoutSeconds}s (a hang or an overloaded verifier)`, ran.id);
  if (ran.observed === 'unlocked-source') return failure('dependency', 'unlocked-source', `${where}; ${ran.detail ?? 'lockfile has an unapproved source'}`, ran.id);
  if (contract.covers.includes('dependencies')) return failure('dependency', 'dependency-install', `${where}; dependency installation failed`, ran.id);
  if (count !== 'unknown' && (count.failed > 0 || count.failedSuites > 0)) {
    const k = count.kinds, summary = `${count.failed} of ${count.total} tests failed; typed ${JSON.stringify(k)}`;
    if (k.service) return failure('infrastructure', 'service-lost', `${where}; ${summary}: a service connection failed during the run`, ran.id);
    if (k.dependency) return failure('dependency', 'module-missing', `${where}; ${summary}: a module or package could not be loaded`, ran.id);
    if (k.permission) return failure('infrastructure', 'sandbox-denied', `${where}; ${summary}: the sandbox denied an operation`, ran.id);
    if (count.failed > 0 && k.assertion === count.failed && k.other === 0) {
      return failure('assertion', 'tests-failed', `${where}; ${summary} (machine-reported)\n${failing.join('\n')}\n${tail(log)}`, ran.id);
    }
    return failure('unknown', 'untyped-failure', `${where}; ${summary}: not every failure is a typed assertion, so the cause is not inferred\n${failing.join('\n')}`, ran.id);
  }
  return failure('unknown', 'unclassified', `${where}; no machine-reported assertion, so the cause is not inferred`, ran.id);
}

const normalize = (text: string) => text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&rsquo;/g, "'")
  .replace(/\s+/g, ' ').trim().toLowerCase();
export const docOrigin = (url: string) => { try { return new URL(url).origin; } catch { return null; } };

/**
 * External assumptions need independent support: a documentation quote the coordinator found itself on an
 * installation-approved origin, or a sanitized observation whose hash an integration validator recorded in policy.
 * Fixtures and builder-written text never suffice.
 */
export function integrations(contract: Contract, policy: VerificationPolicy, files: Record<string, string | null>, documents: Record<string, string | null>, passed: Set<string>): IntegrationStatus[] {
  const origins = policy.externalEvidence.documentationOrigins;
  return contract.externalIntegrations.map((i: Integration) => {
    const reasons: string[] = [];
    for (const a of i.assumptions) {
      const ok = a.evidence.some(e => e.kind === 'documentation' ? origins.includes(docOrigin(e.url) ?? '') && documents[e.url] != null && normalize(documents[e.url]!).includes(normalize(e.quote))
        : e.kind === 'observed-response' && files[e.path] != null && sha256(files[e.path]!) === e.sha256 && policy.externalEvidence.observed.includes(e.sha256));
      if (!ok) reasons.push(`${a.id}: ${a.evidence.length && a.evidence.every(e => e.kind === 'fixture') ? 'fixtures do not establish provider behaviour'
        : 'no quote found on an approved documentation origin and no validator-recorded observation'}`);
    }
    const experimental = reasons.length > 0, offStateCheckPassed = passed.has(i.offStateCheck);
    return { id: i.id, flag: i.flag, status: experimental ? 'experimental' : 'supported', offStateCheckPassed, mergeDisabled: experimental && policy.mergeDisabled && offStateCheckPassed, reasons };
  });
}

function isolationProblems(ev: z.infer<typeof RunnerEvidence>, declared: string[]): string[] {
  const iso = ev.isolation;
  if (!iso) return ['no isolation record'];
  const problems = [...iso.problems];
  if (iso.kind !== 'linux-user' || iso.user !== 'sbverify' || iso.egress !== 'loopback-only') problems.push(`isolation ${iso.kind}/${iso.user}/${iso.egress} is not the separate loopback-only user`);
  for (const name of DENIED_PROBES) if (!iso.probes?.[name]?.startsWith('denied')) problems.push(`probe ${name} was ${iso.probes?.[name] ?? 'missing'}, must be denied`);
  for (const cap of declared) { const name = ALLOWED_PROBES[cap as keyof typeof ALLOWED_PROBES]; if (name && iso.probes?.[name] !== 'allowed') problems.push(`probe ${name} for ${cap} was ${iso.probes?.[name] ?? 'missing'}`); }
  return problems;
}

export function evaluate(policy: VerificationPolicy, head: string, c: Collected): Decision {
  const failures: Failure[] = [], records: CheckRecord[] = [];
  let ints: IntegrationStatus[] = [], isolation: string | null = null;
  const admission = admit(c.files[policy.contractPath] ?? null, policy);
  const job = c.jobs.find(j => j.name === policy.workflow.job) ?? null;
  const out = (): Decision => {
    const record = { head, contractHash: admission.contractHash, workflow: policy.workflow.path, runId: c.run?.id ?? null, runAttempt: c.run?.run_attempt ?? null,
      runner: job ? `${job.runner_group_name ?? 'unknown'} [${job.labels.join(',')}]` : null, isolation, checks: records, failures, integrations: ints };
    return { status: failures.length ? 'fail' : 'pass', head, failures, integrations: ints, record };
  };
  if (!Sha.safeParse(head).success) { failures.push(failure('evidence', 'head-invalid', 'head must be a full commit id')); return out(); }
  // Installation pins: a PR cannot make its own workflow or runner trusted.
  for (const [path, allowed] of Object.entries(policy.trustedFiles)) {
    const text = c.files[path];
    if (text == null) failures.push(failure('verifier-trust', 'trusted-file-missing', `${path} is absent at ${head}`));
    else if (!allowed.includes(sha256(text))) failures.push(failure('verifier-trust', 'trusted-file-changed', `${path} at ${head} has sha256 ${sha256(text)}, not pinned by the installation; owner must review and pin it`));
  }
  failures.push(...admission.failures);
  const run = c.run;
  if (!run) { failures.push(failure('evidence', 'run-missing', `no ${policy.workflow.path} run found for ${head}`)); return out(); }
  if (run.head_sha !== head) failures.push(failure('evidence', 'stale-run', `run ${run.id} is for ${run.head_sha}, not ${head}`));
  if (run.path.replace(/@.*$/, '') !== policy.workflow.path || !(policy.workflow.events as string[]).includes(run.event)) failures.push(failure('evidence', 'untrusted-workflow', `run ${run.id} came from ${run.path} (${run.event})`));
  if (run.status !== 'completed') failures.push(failure('evidence', 'run-pending', `run ${run.id} is ${run.status}`));
  if (!job) failures.push(failure('evidence', 'job-missing', `run ${run.id} has no job "${policy.workflow.job}"`));
  else if (job.runner_group_name !== policy.runner.group || job.labels.includes('self-hosted') || !job.labels.some(l => policy.runner.labels.includes(l))) {
    failures.push(failure('infrastructure', 'untrusted-runner', `job ran on ${job.runner_group_name ?? 'unknown'} [${job.labels.join(',')}]; only disposable GitHub-hosted runners are accepted`));
  }
  if (failures.length) return out();
  const parsed = RunnerEvidence.safeParse(c.evidence);
  if (!parsed.success) { failures.push(failure('evidence', 'evidence-malformed', 'artifact evidence.json is missing or malformed')); return out(); }
  const ev = parsed.data, contract = admission.contract!;
  const prov = ev.backend.provenance;
  if (ev.source.sha !== head || !ev.source.clean) failures.push(failure('evidence', 'stale-evidence', `evidence is for ${ev.source.sha ?? 'unknown'} (clean ${ev.source.clean}), not ${head}`));
  if (ev.contract.path !== policy.contractPath || ev.contract.sha256 !== admission.contractHash) failures.push(failure('evidence', 'contract-mismatch', 'evidence was produced for a different contract'));
  if (prov.GITHUB_RUN_ID !== String(run.id) || run.run_attempt !== undefined && prov.GITHUB_RUN_ATTEMPT !== String(run.run_attempt)) failures.push(failure('evidence', 'run-mismatch', `evidence claims run ${prov.GITHUB_RUN_ID ?? 'none'}, artifact came from run ${run.id}`));
  if (ev.backend.kind !== 'github-hosted' || prov.RUNNER_ENVIRONMENT !== 'github-hosted') failures.push(failure('infrastructure', 'backend', `runner reported backend ${ev.backend.kind}`));
  if (failures.length) return out();
  if (ev.result === 'invalid') { failures.push(failure('evidence', 'runner-invalid', 'the runner refused the source or contract')); return out(); }
  if (ev.preflight?.status === 'unavailable') {
    for (const p of ev.preflight.problems) failures.push(failure('infrastructure', p.code, p.detail));
    if (!failures.length) failures.push(failure('infrastructure', 'unavailable', 'the runner reported no backend'));
    return out();
  }
  const iso = isolationProblems(ev, contract.capabilities);
  if (iso.length) { failures.push(failure('infrastructure', 'isolation-unproven', `repository code was not provably isolated: ${iso.slice(0, 5).join('; ')}`)); return out(); }
  isolation = `${ev.isolation!.kind}:${ev.isolation!.user} egress ${ev.isolation!.egress}; downloads ${ev.isolation!.downloads.join(',') || 'none'}`;
  // Exactly one record per contract check: duplicates and extras make the evidence ambiguous.
  const ids = ev.checks.map(x => x.id), known = new Set(contract.checks.map(x => x.id));
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i), extra = ids.filter(id => !known.has(id));
  if (dupes.length || extra.length) { failures.push(failure('evidence', dupes.length ? 'duplicate-record' : 'extra-record', `evidence records ${[...new Set([...dupes, ...extra])].join(', ')} ambiguously`)); return out(); }
  const passed = new Set<string>();
  for (const check of contract.checks) {
    const ran = ev.checks.find(x => x.id === check.id);
    if (!ran) { failures.push(failure('evidence', 'check-missing', `required check ${check.id} has no evidence`, check.id)); continue; }
    const expected = resolvedCheck(check);
    if (JSON.stringify(ran.argvTemplate) !== JSON.stringify(check.argv) || JSON.stringify(ran.argv) !== JSON.stringify(expected.argv)) { failures.push(failure('evidence', 'argv-mismatch', `${check.id} ran a different command`, check.id)); continue; }
    if (ran.cwd !== expected.cwd) { failures.push(failure('evidence', 'cwd-mismatch', `${check.id} ran in ${ran.cwd}, not ${expected.cwd}`, check.id)); continue; }
    let count: Count = 'unknown', failing: string[] = [];
    if (ran.report) {
      const bytes = c.artifact[ran.report.path];
      if (!check.report || ran.report.path !== `reports/${check.id}.json` || bytes === undefined || sha256(bytes) !== ran.report.sha256 || Buffer.byteLength(bytes) !== ran.report.bytes) {
        failures.push(failure('evidence', 'report-mismatch', `${check.id} report is missing or does not match its recorded hash`, check.id)); continue;
      }
      ({ count, failing } = summarize(bytes));
    }
    if (JSON.stringify(count) !== JSON.stringify(ran.count)) { failures.push(failure('evidence', 'count-mismatch', `${check.id} recorded count differs from the coordinator's reading of its report`, check.id)); continue; }
    records.push({ id: check.id, argv: ran.argv, cwd: ran.cwd, status: ran.status, exitCode: ran.exitCode, count, report: ran.report && { path: ran.report.path, sha256: ran.report.sha256 }, log: ran.log });
    if (ran.status === 'not-run') continue; // judged below: never a pass
    const log = ran.log ? c.artifact[ran.log.path] : undefined;
    if (ran.observed !== 'unlocked-source' && (!ran.log || log === undefined)) { failures.push(failure('evidence', 'log-missing', `${check.id} has no retained log`, check.id)); continue; }
    if (ran.log && (sha256(log!) !== ran.log.sha256 || Buffer.byteLength(log!) !== ran.log.bytes)) { failures.push(failure('evidence', 'log-mismatch', `${check.id} log does not match its recorded hash`, check.id)); continue; }
    if (ran.status === 'pass') {
      if (ran.exitCode !== 0 || ran.signal !== null || ran.observed !== 'exit') failures.push(failure('evidence', 'forged-pass', `${check.id} claims pass with exit ${ran.exitCode}, signal ${ran.signal}, observed ${ran.observed}`, check.id));
      else if (count !== 'unknown' && (count.failed > 0 || count.failedSuites > 0)) failures.push(failure('evidence', 'forged-pass', `${check.id} claims pass with failing tests in its report`, check.id));
      else if (check.count === 'required' && count !== 'unknown' && count.pending + count.todo > 0) failures.push(failure('evidence', 'tests-skipped', `${check.id} skipped ${count.pending + count.todo} tests; required checks run every test`, check.id));
      else if (check.count === 'required' && (count === 'unknown' || count.total === 0)) failures.push(failure('evidence', 'count-missing', `${check.id} lacks a machine-reported passing count`, check.id));
      else passed.add(check.id);
      continue;
    }
    failures.push(classify(check, ran, count, failing, log)!);
  }
  const skipped = contract.checks.filter(x => !passed.has(x.id) && !failures.some(f => f.check === x.id));
  if (skipped.length && !failures.length) failures.push(failure('evidence', 'check-not-run', `required checks did not run: ${skipped.map(x => x.id).join(', ')}`));
  if (!failures.length && (ev.result !== 'pass' || run.conclusion !== 'success')) failures.push(failure('unknown', 'conclusion-mismatch', `checks passed but runner result ${ev.result}, run conclusion ${run.conclusion}`));
  // Judged independently of check results, so an assertion and an external blocker are both retained.
  ints = integrations(contract, policy, c.files, c.documents ?? {}, passed);
  for (const i of ints) if (i.status === 'experimental' && !i.mergeDisabled) {
    failures.push(failure('external-contract', 'unverified-external-contract', `${i.id}: ${i.reasons.join('; ')}${policy.mergeDisabled ? '; its off-state check did not pass' : '; installation does not allow merge-disabled'}`));
  }
  return out();
}

export const ActivationReceipt = z.object({ integration: z.string(), revision: Sha, authorized: z.boolean(), observed: z.boolean(), evidenceSha256: Sha256 }).strict();
export const OffStateReceipt = z.object({ target: z.string(), flag: z.string(), enabled: z.boolean(), evidenceSha256: Sha256 }).strict();

/**
 * Before merging or deploying merge-disabled code: the deployment target itself must attest each flag is off.
 * A passing off-state test proves the code honours the flag, not that the target has it off.
 */
export function offStatePending(ints: IntegrationStatus[], target: string, receipts: Record<string, unknown>): string[] {
  const pending: string[] = [];
  for (const i of ints.filter(x => x.mergeDisabled)) {
    const r = OffStateReceipt.safeParse(receipts[i.id]);
    if (!r.success || r.data.target !== target || r.data.flag !== i.flag) pending.push(`off-state-unproven: ${i.id} has no receipt that ${i.flag} is off at ${target}`);
    else if (r.data.enabled) pending.push(`off-state-violated: ${i.flag} is already on at ${target}; merge-disabled code must not ship there`);
  }
  for (const i of ints.filter(x => x.status === 'experimental' && !x.mergeDisabled)) pending.push(`external-contract: ${i.id} is experimental and not merge-disabled`);
  return pending;
}

/**
 * Completion gate after deployment and exact-revision health. Health and merge never satisfy it.
 * Returns what is still pending; empty means the task may complete.
 */
export function activationPending(ints: IntegrationStatus[], revision: string, receipts: Record<string, unknown>): string[] {
  const pending: string[] = [];
  for (const i of ints) {
    if (i.status === 'experimental') { pending.push(`merge-disabled: ${i.id} stays off (${i.flag}); external contract unverified`); continue; }
    const r = ActivationReceipt.safeParse(receipts[i.id]);
    if (!r.success || r.data.integration !== i.id || r.data.revision !== revision) pending.push(`activation-pending: ${i.id} has no live receipt for ${revision}`);
    else if (!r.data.authorized) pending.push(`activation-pending: ${i.id} awaits owner authorization`);
    else if (!r.data.observed) pending.push(`activation-pending: ${i.id} awaits a successful live integration`);
  }
  return pending;
}
