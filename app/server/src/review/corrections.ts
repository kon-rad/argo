import type pg from 'pg';
import { z } from 'zod';
import { LaunchRegistration, type LaunchRegistration as Launch } from './launch.js';
import { childEnv, command, correctionLookupDisposition, retryCorrectionLookup, SafeProcessError, type CorrectionLookupRetryOptions } from './process.js';

const Correction=z.object({ id:z.coerce.number().int().positive(),feedbackId:z.string(),card:z.string(),builder:z.string(),persona:z.string(),runtime:z.string(),model:z.string(),host:z.string(),repo:z.string(),branch:z.string(),worktree:z.string(),commonDir:z.string(),originalRunId:z.string(),head:z.string(),base:z.string(),pr:z.coerce.number(),evidenceHash:z.string(),leaseToken:z.string(),fence:z.coerce.number(),transientAttempts:z.coerce.number() });
export type ClaimedCorrection=z.infer<typeof Correction>;

export interface CorrectionCompletionInput { git:string; worktree:string; commonDir:string; branch:string; rejectedHead:string; home:string; }
/** Derive completion identity from the registered checkout. Builder output is never an attestation. */
export async function attestCorrectionCompletion(input:CorrectionCompletionInput):Promise<string>{
 const git=(args:string[])=>command(input.git,args,input.worktree,childEnv(input.home),15_000,100_000);
 const [root,commonDir,branch,head,status]=await Promise.all([
  git(['rev-parse','--path-format=absolute','--show-toplevel']),git(['rev-parse','--path-format=absolute','--git-common-dir']),
  git(['symbolic-ref','--short','HEAD']),git(['rev-parse','--verify','HEAD^{commit}']),git(['status','--porcelain=v1','--untracked-files=all']),
 ]).then(values=>values.map(value=>value.trim()));
 if(root!==input.worktree || commonDir!==input.commonDir)throw new SafeProcessError('identity');
 if(branch!==input.branch || status || !/^[a-f0-9]{40}$/.test(head!) || head===input.rejectedHead)throw new SafeProcessError('confirmed-stale');
 if((await git(['merge-base',input.rejectedHead,head!])).trim()!==input.rejectedHead)throw new SafeProcessError('confirmed-stale');
 return head!;
}

export async function registerLaunch(client:pg.Client,input:Launch):Promise<void>{
 const value=LaunchRegistration.parse(input);
 await client.query('SELECT review_register_launch($1::jsonb)',[JSON.stringify(value)]);
}
function claimed(row:Record<string,unknown>|undefined):ClaimedCorrection|null {
 if(!row)return null;
 return Correction.parse({id:row.id,feedbackId:row.feedback_id,card:row.card,builder:row.builder,persona:row.persona,runtime:row.runtime,model:row.model,host:row.host,repo:row.repo,branch:row.branch,worktree:row.worktree,commonDir:row.common_dir,originalRunId:row.original_run_id,head:row.head,base:row.base,pr:row.pr,evidenceHash:row.evidence_hash,leaseToken:row.lease_token,fence:row.fence,transientAttempts:row.transient_attempts});
}
export async function claimCorrection(client:pg.Client,host:string,ttlSeconds=300):Promise<ClaimedCorrection|null>{
 const result=await client.query('SELECT * FROM review_correction_claim($1,$2)',[host,ttlSeconds]);return claimed(result.rows[0]);
}
export async function prepareCorrection(client:pg.Client,id:number,token:string,runId:string,head:string):Promise<{state:string}>{
 return (await client.query('SELECT * FROM review_correction_prepare($1,$2,$3,$4)',[id,token,runId,head])).rows[0];
}
export async function acknowledgeCorrection(client:pg.Client,id:number,token:string,runId:string,processId:string,head:string):Promise<{state:string}>{
 return (await client.query('SELECT * FROM review_correction_ack($1,$2,$3,$4,$5)',[id,token,runId,processId,head])).rows[0];
}
export async function acknowledgeCorrectionAfterLookup(client:pg.Client,input:{id:number;token:string;runId:string;processId:string;head:string},lookup:(timeoutMs:number)=>Promise<void>,options:CorrectionLookupRetryOptions={}):Promise<{state:string}>{
 await retryCorrectionLookup(lookup,options);
 return acknowledgeCorrection(client,input.id,input.token,input.runId,input.processId,input.head);
}
export async function retryCorrection(client:pg.Client,id:number,token:string,reason:string,delaySeconds=30):Promise<void>{
 await client.query('SELECT review_correction_retry($1,$2,$3,$4)',[id,token,reason,delaySeconds]);
}
export async function cancelCorrection(client:pg.Client,id:number,reason:string):Promise<void>{await client.query('SELECT review_correction_cancel($1,$2)',[id,reason]);}
export async function reconcileCorrection(client:pg.Client,id:number,reason:string):Promise<void>{await client.query('SELECT review_correction_reconcile($1,$2)',[id,reason]);}
export async function finishCorrection(client:pg.Client,id:number,runId:string,rejectedHead:string,completionHead:string):Promise<void>{await client.query('SELECT review_correction_finish($1,$2,$3,$4)',[id,runId,rejectedHead,completionHead]);}
export async function finishCorrectionAfterAttestation(client:pg.Client,input:{id:number;runId:string;rejectedHead:string;completionHead:string},validate:()=>Promise<void>):Promise<void>{
 await validate();
 await finishCorrection(client,input.id,input.runId,input.rejectedHead,input.completionHead);
}

export async function handleCorrectionLookupFailure(client:pg.Client,phase:'prepare'|'ack'|'finish',id:number,token:string,error:unknown):Promise<never>{
 const disposition=correctionLookupDisposition(phase,error);
 if(disposition.action==='cancel')await cancelCorrection(client,id,disposition.reason);
 else if(disposition.action==='retry')await retryCorrection(client,id,token,disposition.reason,30);
 else await reconcileCorrection(client,id,disposition.reason);
 throw new Error(disposition.reason);
}
