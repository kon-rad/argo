import { z } from 'zod';
import { admit, failure, Sha, Sha256, sha256, type Check, type Contract, type Failure, type Integration, type VerificationPolicy } from './contract.js';

/** What the trusted coordinator obtained itself: GitHub run metadata, the run's artifact and Git objects at the head. */
export type RunInfo = { id: number; head_sha: string; path: string; event: string; status: string; conclusion: string | null; run_attempt?: number };
export type JobInfo = { name: string; conclusion: string | null; runner_group_name: string | null; labels: string[] };
export type Collected = { run: RunInfo | null; jobs: JobInfo[]; evidence: unknown; logs: Record<string, string | Buffer>; files: Record<string, string | null> };

const Count = z.union([z.literal('unknown'), z.object({ total: z.number().int().min(0), passed: z.number().int().min(0), failed: z.number().int().min(0),
  skipped: z.number().int().min(0), suites: z.number().int().min(0), failedSuites: z.number().int().min(0) })]);
const RunnerCheck = z.object({ id: z.string(), covers: z.array(z.string()), argvTemplate: z.array(z.string()), status: z.enum(['pass', 'fail', 'error', 'timeout', 'incomplete', 'not-run']),
  observed: z.string().optional(), exitCode: z.number().int().nullable(), signal: z.string().nullable().optional(), count: Count,
  log: z.object({ path: z.string().regex(/^logs\/[a-z][a-z0-9-]{0,39}\.log$/), bytes: z.number().int().min(0), sha256: Sha256, truncated: z.boolean() }).nullable() });
export const RunnerEvidence = z.object({ version: z.literal(1), source: z.object({ sha: Sha.nullable(), clean: z.boolean() }),
  contract: z.object({ path: z.string(), sha256: Sha256.nullable() }), backend: z.object({ kind: z.string(), provenance: z.record(z.string(), z.string()) }),
  preflight: z.object({ status: z.string(), problems: z.array(z.object({ code: z.string(), detail: z.string(), capability: z.string().optional() })) }).nullable(),
  checks: z.array(RunnerCheck), result: z.enum(['pass', 'fail', 'invalid', 'unavailable']) });
type RunnerCheck = z.infer<typeof RunnerCheck>;

export type IntegrationStatus = { id: string; flag: string; status: 'supported' | 'experimental'; offStateProven: boolean; reasons: string[] };
export type CheckRecord = { id: string; argv: string[]; status: string; exitCode: number | null; count: z.infer<typeof Count>; log: { path: string; sha256: string; bytes: number; truncated: boolean } | null };
export type Decision = {
  status: 'pass' | 'fail'; head: string; failures: Failure[]; integrations: IntegrationStatus[];
  /** Deterministic for one run, so it can be review evidence without churning the approval fingerprint. */
  record: { head: string; contractHash: string | null; workflow: string; runId: number | null; runAttempt: number | null; runner: string | null; checks: CheckRecord[]; failures: Failure[]; integrations: IntegrationStatus[] };
};

const tail = (text: string | Buffer | undefined, n = 2000) => { const s = String(text ?? ''); return s.length > n ? '...' + s.slice(-n) : s; };

/**
 * Typed routing. An assertion needs a machine-reported failing test; a nonzero exit or a log line alone is never
 * enough. Anything ambiguous stays unknown and goes to verifier triage rather than back to the builder.
 */
export function classify(contract: Check, ran: RunnerCheck, log?: string | Buffer): Failure | null {
  if (ran.status === 'pass') return null;
  const where = `${ran.id}: \`${contract.argv.join(' ')}\` exit ${ran.exitCode ?? 'none'}${ran.log ? `, log ${ran.log.path} sha256 ${ran.log.sha256}` : ''}`;
  if (ran.status === 'incomplete') return failure('evidence', 'count-missing', `${where}; a required machine-reported test count is missing, zero or failing`, ran.id);
  if (ran.status === 'error') return failure('infrastructure', 'executable-unavailable', `${where}; the verifier could not start the check`, ran.id);
  if (ran.observed === 'signal') return failure('infrastructure', 'killed', `${where}; killed by ${ran.signal ?? 'a signal'} (resource limit or sandbox)`, ran.id);
  if (ran.status === 'timeout') return failure('unknown', 'timeout', `${where}; exceeded ${contract.timeoutSeconds}s (a hang or an overloaded verifier)`, ran.id);
  if (contract.covers.includes('dependencies')) return failure('dependency', 'dependency-install', `${where}; dependency installation failed`, ran.id);
  if (ran.count !== 'unknown' && ran.count.failed > 0) {
    return failure('assertion', 'tests-failed', `${where}; ${ran.count.failed} of ${ran.count.total} tests failed (machine-reported)\n${tail(log)}`, ran.id);
  }
  if (ran.count !== 'unknown' && ran.count.failedSuites > 0) return failure('unknown', 'suite-error', `${where}; ${ran.count.failedSuites} suites failed before any test assertion (setup or service)`, ran.id);
  return failure('unknown', 'unclassified', `${where}; no machine-reported assertion, so the cause is not inferred`, ran.id);
}

/** External assumptions need authoritative documentation or a sanitized observation. Fixtures never suffice. */
export function integrations(contract: Contract, files: Record<string, string | null>, passed: Set<string>): IntegrationStatus[] {
  return contract.externalIntegrations.map((i: Integration) => {
    const reasons: string[] = [];
    for (const a of i.assumptions) {
      const ok = a.evidence.some(e => e.kind === 'documentation' || e.kind === 'observed-response' && files[e.path] != null && sha256(files[e.path]!) === e.sha256);
      if (!ok) reasons.push(`${a.id}: ${a.evidence.some(e => e.kind === 'fixture') ? 'fixtures do not establish provider behaviour' : 'no authoritative documentation or matching sanitized observation'}`);
    }
    return { id: i.id, flag: i.flag, status: reasons.length ? 'experimental' : 'supported', offStateProven: passed.has(i.offStateCheck), reasons };
  });
}

export function evaluate(policy: VerificationPolicy, head: string, c: Collected): Decision {
  const failures: Failure[] = [], records: CheckRecord[] = [];
  let ints: IntegrationStatus[] = [];
  const admission = admit(c.files[policy.contractPath] ?? null, policy);
  const job = c.jobs.find(j => j.name === policy.workflow.job) ?? null;
  const out = (): Decision => {
    const record = { head, contractHash: admission.contractHash, workflow: policy.workflow.path, runId: c.run?.id ?? null, runAttempt: c.run?.run_attempt ?? null,
      runner: job ? `${job.runner_group_name ?? 'unknown'} [${job.labels.join(',')}]` : null, checks: records, failures, integrations: ints };
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
  for (const p of ev.preflight?.status === 'unavailable' ? ev.preflight.problems : []) failures.push(failure('infrastructure', p.code, p.detail));
  const passed = new Set<string>();
  for (const check of contract.checks) {
    const ran = ev.checks.find(x => x.id === check.id);
    if (!ran) { failures.push(failure('evidence', 'check-missing', `required check ${check.id} has no evidence`, check.id)); continue; }
    if (JSON.stringify(ran.argvTemplate) !== JSON.stringify(check.argv)) { failures.push(failure('evidence', 'argv-mismatch', `${check.id} ran a different command`, check.id)); continue; }
    records.push({ id: check.id, argv: check.argv, status: ran.status, exitCode: ran.exitCode, count: ran.count, log: ran.log });
    if (ran.status === 'not-run') continue; // judged below: never a pass
    const log = ran.log ? c.logs[ran.log.path] : undefined;
    if (!ran.log || log === undefined) { failures.push(failure('evidence', 'log-missing', `${check.id} has no retained log`, check.id)); continue; }
    if (sha256(log) !== ran.log.sha256 || Buffer.byteLength(log) !== ran.log.bytes) { failures.push(failure('evidence', 'log-mismatch', `${check.id} log does not match its recorded hash`, check.id)); continue; }
    if (ran.status === 'pass') {
      const counted = ran.count !== 'unknown' && ran.count.total > 0 && ran.count.failed === 0 && ran.count.failedSuites === 0;
      if (ran.exitCode !== 0) failures.push(failure('evidence', 'forged-pass', `${check.id} claims pass with exit ${ran.exitCode}`, check.id));
      else if (check.count === 'required' && !counted) failures.push(failure('evidence', 'count-missing', `${check.id} lacks a machine-reported passing count`, check.id));
      else passed.add(check.id);
      continue;
    }
    failures.push(classify(check, ran, log)!);
  }
  const skipped = contract.checks.filter(x => !passed.has(x.id) && !failures.some(f => f.check === x.id));
  if (skipped.length && !failures.length) failures.push(failure('evidence', 'check-not-run', `required checks did not run: ${skipped.map(x => x.id).join(', ')}`));
  if (!failures.length && (ev.result !== 'pass' || run.conclusion !== 'success')) failures.push(failure('unknown', 'conclusion-mismatch', `checks passed but runner result ${ev.result}, run conclusion ${run.conclusion}`));
  ints = integrations(contract, c.files, passed);
  // Judged once checks pass, so a real assertion still reaches the builder first.
  if (!failures.length) for (const i of ints) if (i.status === 'experimental' && !(policy.mergeDisabled && i.offStateProven)) {
    failures.push(failure('external-contract', 'unverified-external-contract', `${i.id}: ${i.reasons.join('; ')}${policy.mergeDisabled ? '; off state not proven' : '; installation does not allow merge-disabled'}`));
  }
  return out();
}

export const ActivationReceipt = z.object({ integration: z.string(), revision: Sha, authorized: z.boolean(), observed: z.boolean(), evidenceSha256: Sha256 }).strict();

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
