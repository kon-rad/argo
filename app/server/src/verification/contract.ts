import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Trusted coordinator view of the repository verification contract. Deliberately independent of
 * scripts/verify.mjs: that runner is repository-authored, so the coordinator never imports it.
 */
export const CAPABILITIES = ['postgres', 'loopback-listeners', 'dependency-download:npm', 'dependency-download:pypi'] as const;
export const Capability = z.enum(CAPABILITIES);
export const Cover = z.enum(['dependencies', 'build', 'unit', 'migrations', 'integration', 'regression']);
const Count = z.enum(['required', 'optional', 'none']);
const Id = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
export const Sha = z.string().regex(/^[a-f0-9]{40}$/);
export const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const RelPath = z.string().min(1).max(300).refine(p => !p.startsWith('/') && !p.split('/').some(s => !s || s === '..' || s === '.git'), 'repository-relative path');

export const Check = z.object({
  id: Id, covers: z.array(Cover).min(1), cwd: z.union([z.literal('.'), RelPath]).default('.'),
  argv: z.array(z.string().min(1).max(500)).min(1).max(40).refine(a => ['npm', 'npx', 'node', 'python3'].includes(a[0]!), 'executable must be npm, npx, node or python3'),
  requires: z.array(Capability), timeoutSeconds: z.number().int().min(1).max(1800), count: Count, report: z.literal('vitest-json').optional(),
}).strict();
export type Check = z.infer<typeof Check>;
const EvidenceRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('documentation'), url: z.string().url().startsWith('https://'), quote: z.string().min(10).max(2000) }).strict(),
  z.object({ kind: z.literal('observed-response'), path: RelPath.refine(p => p.startsWith('verification/observed/'), 'observed responses live under verification/observed/'), sha256: Sha256 }).strict(),
  z.object({ kind: z.literal('fixture'), path: RelPath }).strict(),
]);
export const Integration = z.object({
  id: Id, operation: z.string().min(1).max(300), flag: z.string().min(1).max(100), offStateCheck: Id,
  assumptions: z.array(z.object({ id: Id, statement: z.string().min(1).max(1000), evidence: z.array(EvidenceRef).max(10) }).strict()).min(1).max(30),
}).strict();
export type Integration = z.infer<typeof Integration>;
export const Contract = z.object({ version: z.literal(1), capabilities: z.array(Capability), checks: z.array(Check).min(1).max(20), externalIntegrations: z.array(Integration).max(20).default([]) }).strict()
  .superRefine((c, ctx) => {
    const ids = c.checks.map(x => x.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'duplicate check id' });
    if (new Set(c.capabilities).size !== c.capabilities.length) ctx.addIssue({ code: 'custom', message: 'duplicate capability' });
    for (const x of c.checks) {
      if (x.requires.some(r => !c.capabilities.includes(r))) ctx.addIssue({ code: 'custom', message: `${x.id} requires an undeclared capability` });
      if (x.argv.filter(a => a.includes('{report}')).length !== (x.report ? 1 : 0)) ctx.addIssue({ code: 'custom', message: `${x.id} report placeholder mismatch` });
      if (x.count === 'required' && !x.report) ctx.addIssue({ code: 'custom', message: `${x.id} requires a count without a report` });
    }
    if (c.checks.reduce((n, x) => n + x.timeoutSeconds, 0) > 3600) ctx.addIssue({ code: 'custom', message: 'total timeout above 3600s' });
    for (const i of c.externalIntegrations) if (!ids.includes(i.offStateCheck)) ctx.addIssue({ code: 'custom', message: `${i.id} off-state check is not a contract check` });
  });
export type Contract = z.infer<typeof Contract>;

/** Private installation policy. Lives outside the repository; a PR cannot edit it. */
export const VerificationPolicy = z.object({
  version: z.literal(1),
  contractPath: RelPath.default('verification/contract.json'),
  runnerPath: RelPath.default('scripts/verify.mjs'),
  workflow: z.object({ path: z.string().regex(/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/), job: z.string().min(1), artifact: z.string().min(1).default('verification-evidence'),
    events: z.array(z.enum(['pull_request', 'push'])).min(1).default(['pull_request', 'push']) }).strict(),
  /** SHA-256 of approved workflow and runner contents. Changing either needs the owner to pin it. */
  trustedFiles: z.record(RelPath, z.array(Sha256).min(1)),
  /** GitHub-hosted only. There is deliberately no self-hosted switch in this version. */
  runner: z.object({ group: z.string().min(1).default('GitHub Actions'), labels: z.array(z.string().min(1)).min(1).default(['ubuntu-latest', 'ubuntu-24.04']) }).strict()
    .default({ group: 'GitHub Actions', labels: ['ubuntu-latest', 'ubuntu-24.04'] }),
  capabilities: z.array(Capability),
  requiredChecks: z.array(z.object({ id: Id, argv: z.array(z.string().min(1)).min(1), covers: z.array(Cover).min(1), count: Count }).strict()).min(1),
  maxArtifactBytes: z.number().int().positive().max(200_000_000).default(50_000_000),
  /** Allow merging an unverified external integration while its flag is provably off. Default off. */
  mergeDisabled: z.boolean().default(false),
  /** Owner program that attests live authorization and integration for one integration and revision. */
  activation: z.object({ argv: z.array(z.string().min(1)).min(1).refine(a => a[0]!.startsWith('/'), 'absolute executable'), cwd: z.string().startsWith('/') }).strict().optional(),
}).strict().superRefine((p, ctx) => {
  for (const path of [p.workflow.path, p.runnerPath]) if (!p.trustedFiles[path]) ctx.addIssue({ code: 'custom', message: `trustedFiles must pin ${path}` });
});
export type VerificationPolicy = z.infer<typeof VerificationPolicy>;

export const ROUTES = {
  assertion: 'builder', infrastructure: 'verifier', dependency: 'environment-repair', 'external-contract': 'integration-validation',
  authorization: 'activation-pending', unknown: 'verifier-triage', evidence: 'verifier', 'verifier-trust': 'owner', contract: 'builder',
} as const;
export type FailureType = keyof typeof ROUTES;
export type Failure = { type: FailureType; route: (typeof ROUTES)[FailureType]; code: string; detail: string; check?: string };
export const failure = (type: FailureType, code: string, detail: string, check?: string): Failure => ({ type, route: ROUTES[type], code, detail, ...(check ? { check } : {}) });
export const sha256 = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');

export type Admission = { status: 'admitted' | 'unavailable' | 'invalid'; contractHash: string | null; contract: Contract | null; failures: Failure[] };
const STRICTNESS = { none: 0, optional: 1, required: 2 } as const;

/** Before a builder launches: can this installation verify what the contract needs, and does it keep the minimum? */
export function admit(text: string | null, policy: VerificationPolicy): Admission {
  const failures: Failure[] = [];
  const done = (contract: Contract | null = null): Admission => ({
    status: failures.some(f => f.type === 'contract') ? 'invalid' : failures.length ? 'unavailable' : 'admitted',
    contractHash: text === null ? null : sha256(text), contract, failures });
  if (text === null) { failures.push(failure('contract', 'contract-missing', `${policy.contractPath} is absent at this revision`)); return done(); }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { failures.push(failure('contract', 'contract-malformed', 'contract is not JSON')); return done(); }
  const declared = (raw as { capabilities?: unknown })?.capabilities;
  if (Array.isArray(declared)) for (const c of declared) {
    if (typeof c === 'string' && !(CAPABILITIES as readonly string[]).includes(c)) failures.push(failure('infrastructure', 'unsupported-capability', `no verifier backend provides "${c}"`));
    else if (typeof c === 'string' && !policy.capabilities.includes(c as z.infer<typeof Capability>)) failures.push(failure('infrastructure', 'capability-not-offered', `this installation does not offer "${c}"`));
  }
  if (failures.length) return done(); // reject unsupported capabilities immediately
  const parsed = Contract.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 10)) failures.push(failure('contract', 'contract-invalid', `${issue.path.join('.') || '$'}: ${issue.message}`));
    return done();
  }
  for (const r of policy.requiredChecks) {
    const c = parsed.data.checks.find(x => x.id === r.id);
    if (!c) failures.push(failure('contract', 'required-check-missing', `installation requires check "${r.id}"`, r.id));
    else if (JSON.stringify(c.argv) !== JSON.stringify(r.argv)) failures.push(failure('contract', 'required-check-changed', `"${r.id}" argv differs from the installation minimum`, r.id));
    else if (r.covers.some(x => !c.covers.includes(x)) || STRICTNESS[c.count] < STRICTNESS[r.count]) failures.push(failure('contract', 'required-check-weakened', `"${r.id}" covers or count is weaker than the installation minimum`, r.id));
  }
  return done(parsed.data);
}
