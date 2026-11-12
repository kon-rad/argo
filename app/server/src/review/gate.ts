import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Failure } from '../verification/contract.js';

const Sha = z.string().regex(/^[a-f0-9]{40}$/);
export const Source = z.object({ ref: z.string(), revision: z.string(), text: z.string(), essential: z.boolean(), missing: z.boolean(), truncated: z.boolean(), redacted:z.boolean().optional() }).strict();
export type Source = z.infer<typeof Source>;
export const Snapshot = z.object({ repo: z.string(), pr: z.number().int().positive(), head: Sha, base: Sha, branch: z.string(), merged: Sha.nullable(),
  behind:z.boolean().optional(), conflicting:z.boolean().optional(),
  draft: z.boolean().optional(), unresolved: z.number().int().nonnegative().optional(), changesRequested: z.boolean().optional(),
  // Informative collector metadata only; runReview always uses its trusted configured checks argument.
  requiredChecks: z.array(z.string().min(1)).optional(),
  checks: z.array(z.object({ name: z.string(), state: z.string() }).strict()), sources: z.array(Source) }).strict();
export type Snapshot = z.infer<typeof Snapshot>;
const Checked = z.object({ status:z.enum(['checked','not-applicable']), evidence:z.array(z.string().min(1)).min(1), rationale:z.string().min(1) }).strict();
export const Verdict = z.object({
  decision: z.enum(['accept', 'reject']), reviewer: z.string(), repo: z.string(), pr: z.number().int(), head: Sha, base: Sha, evidence: z.string().regex(/^[a-f0-9]{64}$/),
  categories: z.object({ security: Checked, compatibility: Checked, migrations: Checked, regressions: Checked, scope: Checked, placeholders: Checked, tests: Checked.extend({status:z.literal('checked')}) }).strict(),
  findings: z.array(z.object({ severity: z.enum(['critical', 'high', 'medium', 'low']), location: z.string().min(1), evidence: z.string().min(1), impact: z.string().min(1), fix: z.string().min(1), verification: z.string().min(1) }).strict()).max(30),
}).strict();
export type Verdict = z.infer<typeof Verdict>;
export interface Job {
  id: number; card: string; builder: string; reviewer: string; target: string; round: number;
  state: 'queued' | 'reviewing' | 'approved' | 'merging' | 'merged' | 'deploying' | 'deployed' | 'blocked' | 'rejected' | 'done';
  snapshot: Snapshot | null; verdict: Verdict | null; merged: string | null; deployed: string | null; error?: string | null; health?: string | null;
}
export interface GateIO {
  gather(): Promise<Snapshot>;
  review(snapshot: Snapshot, evidence: string): Promise<unknown>;
  save(patch: Partial<Job>): Promise<void>;
  /** Idempotent delivery to PR and ticket, keyed by job id. */
  reject(findings: string): Promise<void>;
  /** Must reconcile a previously completed operation, then compare-and-swap the reviewed base and head. */
  merge(snapshot: Snapshot): Promise<string>;
  /** Owner-registered adapter, idempotency key job.id and exact revision only. */
  deploy(revision: string): Promise<string>;
  health(revision: string): Promise<boolean>;
  complete(): Promise<void>;
  verifyMerge(snapshot:Snapshot,revision:string):Promise<void>;
  beforeShip?():Promise<void>;
  /** Owner-controlled switch, checked again immediately before each external write. */
  mayShip?(): Promise<boolean>;
  /** Trusted exact-head verification (docs/verification.md). `checks` are the CI check names it classifies. */
  verify?(s: Snapshot): Promise<{ failures: Failure[]; checks: string[] }>;
  /** After exact-revision health: activation still pending. Empty means the task may complete. */
  activation?(revision: string): Promise<string[]>;
}
function verificationError(failures: Failure[]): string {
  return 'Verification ' + failures.slice(0, 5).map(f => `${f.type} -> ${f.route} [${f.code}]: ${f.detail.split('\n')[0]}`).join('; ');
}
function rejection(job: Job, s: Snapshot, findings: Verdict['findings'], rationale: string): Verdict {
  const checked={status:'not-applicable' as const,evidence:[s.sources.find(x=>!x.missing)?.ref ?? 'preflight'],rationale};
  return {decision:'reject',reviewer:job.reviewer,repo:s.repo,pr:s.pr,head:s.head,base:s.base,evidence:evidence(s),
    categories:{security:checked,compatibility:checked,migrations:checked,regressions:checked,scope:checked,placeholders:checked,tests:{...checked,status:'checked'}},findings:findings.slice(0,30)};
}
export function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function evidence(s: Snapshot): string {
  const normalized=Snapshot.parse({...s,behind:s.behind??false,conflicting:s.conflicting??false});
  normalized.sources=normalized.sources.map(item=>{
    if(item.redacted || !/^board:t_[a-f0-9]{6,32}:(?:project|feature)$/.test(item.ref))return item;
    try {
      const record:unknown=JSON.parse(item.text);
      if(!record || typeof record!=='object' || Array.isArray(record))return item;
      // Preserve raw source/provenance in the snapshot. Audit stamps do not change project requirements.
      const content={...record} as Record<string,unknown>;delete content.updated_at;delete content.updated_by;
      const text=JSON.stringify(content);
      return {...item,text,revision:digest(text)};
    } catch { return item; } // Malformed context remains fully significant; never discard it.
  });
  return digest({ ...normalized, merged: null });
}
function ready(s: Snapshot, checks: string[]): void {
  const unavailable=s.sources.filter(x=>x.essential && (x.missing || x.truncated || !x.text.trim()));
  if(!s.sources.length || unavailable.length)throw new Error('Essential context missing or truncated: '+unavailable.slice(0,5).map(x=>x.ref).join(', '));
  if (!checks.length || checks.some(name => !s.checks.some(c => c.name === name) || s.checks.some(c => c.name === name && c.state !== 'pass'))) throw new Error('Required CI missing, failed or pending');
}
function preflightFindings(s: Snapshot, checks: string[]): Verdict['findings'] {
  const failures: Verdict['findings'] = [];
  const add = (location: string, detail: string, fix: string, verification: string) => failures.push({ severity:'high',location,evidence:detail,impact:'This PR is not ready for acceptance and shipping',fix,verification });
  if (s.behind) add('PR base','PR branch is behind the protected base','Merge the current base into the same PR branch and address any resulting changes','Rerun required checks and resubmit the same card');
  if (s.conflicting) add('PR conflicts','PR conflicts with its protected base','Resolve the conflicts on the same PR branch without force-pushing','Rerun required checks and resubmit the same card');
  if (s.draft) add('PR readiness','PR is marked as draft','Complete the work and mark the PR ready for review','Confirm isDraft=false');
  if (s.unresolved) add('PR review threads',`${s.unresolved} unresolved review threads`,'Address and resolve the outstanding findings','Confirm no unresolved review threads remain');
  if (s.changesRequested) add('PR reviews','An active review requests changes','Address the requested changes and obtain an updated review','Confirm the changes-requested review has been resolved');
  for (const name of checks) if (s.checks.some(c=>c.name===name && c.state==='fail')) add(`CI: ${name}`,'Required check failed',`Fix the failure in ${name}`,`Rerun ${name} and record its passing output`);
  return failures;
}
export function findingsText(v: Verdict): string {
  return v.findings.map(f => `[${f.severity}] ${f.location}\nEvidence: ${f.evidence}\nImpact: ${f.impact}\nRequired fix: ${f.fix}\nVerification: ${f.verification}`).join('\n\n');
}
/** Trusted coordinator. A model's only capability is returning this strict data document. */
export async function runReview(job: Job, checks: string[], io: GateIO): Promise<void> {
  if (job.state === 'done' || job.state === 'rejected') return;
  const save = async (patch: Partial<Job>) => { await io.save(patch); Object.assign(job, patch); };
  let observedMerge:string|null=null;
  try {
    if (job.builder === job.reviewer || !job.target) throw new Error('Independent reviewer and registered target required');
    let s = Snapshot.parse(await io.gather());
    observedMerge=s.merged;
    if(!job.merged && job.snapshot && evidence(s)!==evidence(job.snapshot)){await save({snapshot:null,verdict:null});}
    if (job.merged) {
      if(!job.snapshot || !job.verdict || job.verdict.decision!=='accept')throw new Error('Merged revision has no accepted review; reconciliation required');
      await io.beforeShip?.();
      s=Snapshot.parse(await io.gather());
      if(evidence(s)!==evidence(job.snapshot))throw new Error('Approval evidence changed after merge; deployment blocked');
      ready(s,checks);
    }
    if (!job.merged) {
      // Verification precedes independent review. Only machine-reported assertions return to the builder;
      // every other typed failure blocks for its own route and never becomes a builder finding.
      if (!job.verdict && !s.merged && io.verify) {
        const v = await io.verify(s);
        if (v.failures.length && !v.failures.every(f => f.type === 'assertion')) throw new Error(verificationError(v.failures));
        if (v.failures.length) {
          const findings = [...v.failures.map(f => ({ severity:'high' as const, location:`verification: ${f.check ?? f.code}`, evidence:f.detail,
            impact:'Trusted verification failed on the exact submitted head', fix:'Fix the failing assertion on the same PR branch',
            verification:'Push the fix; the disposable verifier reruns the contract on the new head' })),
            ...preflightFindings(s,checks).filter(p => !v.checks.some(name => p.location === `CI: ${name}`))];
          await save({snapshot:s,verdict:rejection(job,s,findings,'Full review deferred because trusted verification reported failing assertions'),state:'reviewing'});
        }
      }
      const problems = !s.merged ? preflightFindings(s,checks) : [];
      if (problems.length && !job.verdict) {
        await save({snapshot:s,verdict:rejection(job,s,problems,'Full review deferred because the PR failed the recorded readiness checks'),state:'reviewing'});
      }
      if (!s.merged && job.verdict?.decision!=='reject') ready(s, checks);
      // An interrupted merge must use its recorded approved snapshot, never a fresh verdict on a merged PR.
      if (!job.verdict || !job.snapshot) {
        if (s.merged) throw new Error('Unknown prior merge, owner reconciliation required');
        await save({ state: 'reviewing', error: null });
        const v = Verdict.parse(await io.review(s, evidence(s)));
        if (v.reviewer !== job.reviewer || v.reviewer === job.builder || v.repo !== s.repo || v.pr !== s.pr || v.head !== s.head || v.base !== s.base || v.evidence !== evidence(s)) throw new Error('Unauthorized or stale review verdict');
        if (v.decision === 'accept' && Object.values(v.categories).some(c => c.evidence.some(ref => !s.sources.some(source => source.ref===ref && !source.missing && !source.truncated)))) throw new Error('Review category cites unavailable evidence');
        if ((v.decision === 'accept') !== (v.findings.length === 0)) throw new Error('Verdict contradicts blocking findings');
        await save({ snapshot: s, verdict: v, state: v.decision === 'accept' ? 'approved' : 'reviewing' });
      }
      if (job.verdict!.decision === 'reject') {
        await io.reject(findingsText(job.verdict!));
        await save({ state: 'rejected' }); return;
      }
      if (io.mayShip && !(await io.mayShip())) { await save({state:'approved',error:'Review accepted; owner has shipping disabled'}); return; }
      await io.beforeShip?.();
      const current = Snapshot.parse(await io.gather());
      if (!current.merged) {
        ready(current, checks);
        if (evidence(current) !== evidence(job.snapshot!)) {
          await save({ verdict: null, snapshot: null }); throw new Error('Revision or evidence changed; approval invalidated');
        }
        const v = await io.verify?.(current);
        if (v?.failures.length) { await save({ verdict: null, snapshot: null }); throw new Error(verificationError(v.failures)); }
      }
      await save({ state: 'merging' });
      const revision = Sha.parse(await io.merge(job.snapshot!));
      await save({ state: 'merged', merged: revision });
      s = current;
    }
    await io.verifyMerge(job.snapshot!,job.merged!);
    if (!job.deployed) {
      if (io.mayShip && !(await io.mayShip())) { await save({state:'merged',error:'Merge recorded; owner has deployment paused'}); return; }
      await save({ state: 'deploying' });
      const revision = Sha.parse(await io.deploy(job.merged!));
      if (revision !== job.merged) throw new Error('Deploy receipt is for a different revision');
      await save({ state: 'deployed', deployed: revision });
    }
    // A durable receipt attests this historical release even if a newer release now runs.
    const verifiedHealth=job.deployed===job.merged && job.health===job.merged;
    if (!verifiedHealth && !(await io.health(job.merged!))) throw new Error('Health does not attest merged revision');
    await save({ health:job.merged, ...(job.state==='deployed' ? {} : {state:'deployed' as const}) });
    // Merge and health never imply activation: merge-disabled and activation-pending stay open, not done.
    const pending = io.activation ? await io.activation(job.merged!) : [];
    if (pending.length) { await save({ state:'blocked', error:pending.join('; ').slice(0,1000) }); return; }
    await io.complete();
    await save({ state: 'done', error: null });
  } catch (error) {
    await save({ state: 'blocked', ...(job.merged || observedMerge ? {merged:job.merged ?? observedMerge}:{}), error: error instanceof Error ? error.message : 'Review failed' });
  }
}
