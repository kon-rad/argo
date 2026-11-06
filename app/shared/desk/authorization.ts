import { CONTRACT_VERSION, type Approval, type Mutation, type ReleaseBinding, type ReleaseRequest, type WorkerSpec } from './types.js';
import { canonicalJson, isHash, sameRelease } from './validation.js';
const token = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 4096 && x.trim() === x;
const integer = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
const amount = (x: unknown): x is string => typeof x === 'string' && /^(0|[1-9][0-9]*)$/.test(x) && x.length <= 78;
export function checkMutation(request: Mutation, revision: number): boolean {
  return !!request && token(request.idempotencyKey) && integer(request.expectedRevision) && integer(revision) && request.expectedRevision === revision;
}
/** A gateway still authenticates the capability, independently enforces its limits and revokes it on cancellation. */
export function checkWorkerSpec(spec: WorkerSpec, approval: Approval, expected: {jobId:string; attemptId:string; audience:string; now:number; maxLifetimeSeconds:number}): boolean {
  if (!spec || !approval || !spec.limits || !approval.limits || spec.version !== CONTRACT_VERSION || !token(spec.jobId) || !token(spec.attemptId) || spec.jobId !== expected.jobId || spec.attemptId !== expected.attemptId || !token(spec.audience) || spec.audience !== expected.audience || !integer(expected.now) || !integer(expected.maxLifetimeSeconds) || expected.maxLifetimeSeconds === 0 || !integer(approval.expiresAt) || !integer(spec.expiresAt) || spec.expiresAt <= expected.now || spec.expiresAt - expected.now > expected.maxLifetimeSeconds || spec.expiresAt > approval.expiresAt || spec.audience !== approval.audience) return false;
  if (!isHash(spec.acceptanceDigest) || !isHash(spec.corpusDigest) || !isHash(spec.planDigest) || spec.acceptanceDigest !== approval.acceptanceDigest || spec.skillVersion !== approval.skillVersion || spec.corpusDigest !== approval.corpusDigest || spec.planDigest !== approval.planDigest || !token(spec.skillVersion)) return false;
  const limits = spec.limits;
  if (!Array.isArray(spec.inputRefs) || spec.inputRefs.length === 0 || !spec.inputRefs.every(token) || !Array.isArray(limits.tools) || !limits.tools.every(token) || !token(limits.model) || !token(limits.costAsset) || !amount(limits.maxCostAtomic) || !integer(limits.maxRuntimeSeconds) || limits.maxRuntimeSeconds === 0 || !integer(limits.maxOutputTokens) || limits.maxOutputTokens === 0) return false;
  try { return canonicalJson(limits) === canonicalJson(approval.limits) && canonicalJson(spec.inputRefs) === canonicalJson(approval.inputRefs); } catch { return false; }
}
export function checkRelease(approved: ReleaseBinding, request: ReleaseRequest, revision: number): boolean {
  return !!approved && !!request && checkMutation(request, revision) && isHash(approved.artifactHash) && token(approved.mediaType) && token(approved.publicDestination) && sameRelease(approved, request);
}
