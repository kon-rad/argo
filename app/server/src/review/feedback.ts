import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CapacityError, type Reason } from './policy.js';

const Sha = z.string().regex(/^[a-f0-9]{40}$/);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const TrustedProducer = z.object({ kind:z.enum(['reviewer','coordinator']), id:z.string().min(1).max(120) }).strict();
export const Feedback = z.object({
  id: Hash, card:z.string().regex(/^t_[a-f0-9]{6,32}$/), repo:z.string().min(1), pr:z.number().int().positive(), base:Sha, head:Sha,
  evidenceHash:Hash, code:z.enum(['scope-changed-files','scope-reviewable-files','scope-sources','scope-source-chars','scope-diff-chars','scope-combined-chars','ci-failure','code-finding','stale-evidence']),
  severity:z.enum(['critical','high','medium','low']), reason:z.string().min(1).max(2000), evidence:z.string().min(1).max(8000),
  requiredFix:z.string().min(1).max(8000), verification:z.string().min(1).max(8000), producer:TrustedProducer,
}).strict();
export type Feedback = z.infer<typeof Feedback>;
export type FeedbackBinding = Pick<Feedback,'card'|'repo'|'pr'|'base'|'head'|'evidenceHash'|'producer'>;

function id(input: Omit<Feedback,'id'>): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}
function make(input: Omit<Feedback,'id'>): Feedback { return Feedback.parse({ ...input, id:id(input) }); }
const codeFor = (reason: Reason): Feedback['code'] => ({
  changedFiles:'scope-changed-files', reviewableFiles:'scope-reviewable-files', sources:'scope-sources', sourceChars:'scope-source-chars', diffChars:'scope-diff-chars', combinedChars:'scope-combined-chars',
}[reason.code] as Feedback['code']);

export function actionableCapacityFeedback(error: CapacityError, binding: FeedbackBinding): Feedback[] {
  return error.result.reasons.filter(reason => codeFor(reason)).map(reason => make({ ...binding, code:codeFor(reason), severity:'high',
    reason:`Review capacity exceeded: ${reason.code}`, evidence:`Observed ${reason.observed ?? 'invalid'}; allowed ${reason.allowed ?? 'a valid bounded value'}. Full independent model review did not run.`,
    requiredFix:reason.action, verification:'Run review scope actual against the complete clean revision and record a passing result before resubmission.',
  }));
}

export function ciFindings(checks:{name:string;state:string}[],required:string[],binding:FeedbackBinding):{status:'pass'|'wait'|'reject';feedback:Feedback[]} {
  const failed=required.filter(name=>checks.some(check=>check.name===name && check.state==='fail'));
  if(failed.length)return {status:'reject',feedback:failed.map(name=>make({...binding,code:'ci-failure',severity:'high',reason:`Required CI check failed: ${name}`,
    evidence:`The trusted provider reports ${name} in terminal failed state for ${binding.head}.`,requiredFix:`Fix the failure in ${name}.`,verification:`Rerun ${name} for ${binding.head} and record its passing result.`}))};
  if(required.some(name=>!checks.some(check=>check.name===name && check.state==='pass')))return {status:'wait',feedback:[]};
  return {status:'pass',feedback:[]};
}
