#!/usr/bin/env node
// Standalone host service: does not import app config or load a vault .env.
import { readFile, stat } from 'node:fs/promises';
import pg from 'pg';
import { HostConfig } from './review/adapters.js';
import { tick } from './review/worker.js';
import { join } from 'node:path';
import { setPrivateLog } from './review/process.js';
import { stage } from './review/stage.js';
import { runFixture } from './review/fixture.js';
import { scopeMain } from './review/preflight.js';
import { acknowledgeCorrectionAfterLookup, cancelCorrection, claimCorrection, finishCorrection, handleCorrectionLookupFailure, prepareCorrection, registerLaunch, retryCorrection } from './review/corrections.js';
import { SafeProcessError } from './review/process.js';
import { GitHub } from './review/adapters.js';

async function stdin():Promise<unknown>{let raw='';for await(const part of process.stdin){raw+=String(part);if(Buffer.byteLength(raw)>600000)throw new Error('Input too large');}return JSON.parse(raw);}

async function main(): Promise<void> {
  const [action,path] = process.argv.slice(2);
  if (action === 'scope') { process.exitCode = await scopeMain(process.argv.slice(3)); return; }
  if (action === 'fixture') { console.log(JSON.stringify(await runFixture(),null,2)); return; }
  if (!['tick','stage','retries','register','claim','prepare','ack','retry','cancel','finish','status'].includes(action ?? '') || !path) throw new Error('Usage: cli-review fixture | scope ... | tick|stage|retries|register|claim|prepare|ack|retry|cancel|finish|status /absolute/owner-policy.json [argument]');
  const info = await stat(path);
  if (!path.startsWith('/') || (info.mode & 0o022) || (info.uid !== process.getuid?.() && info.uid !== 0)) throw new Error('Host policy must be owner-owned and not group/world writable');
  const host = HostConfig.parse(JSON.parse(await readFile(path,'utf8')));
  setPrivateLog(join(host.home,'review-adapters.log'));
  if (!process.env.REVIEW_DB_URL) throw new Error('REVIEW_DB_URL: dedicated worker login required');
  const client = new pg.Client({connectionString:process.env.REVIEW_DB_URL,statement_timeout:15_000});
  await client.connect();
  // Losing the lock connection stops this worker. Durable adapter receipts reconcile uncertain effects.
  client.on('error',() => process.exit(1));
  try {
    if(action==='retries'){console.log(JSON.stringify((await client.query('SELECT review_builder_retries() AS cards')).rows[0].cards));return;}
    if(action==='stage'){console.log(JSON.stringify(await stage(client,host.evidenceRoot,await stdin())));return;}
    if(action==='register'){await registerLaunch(client,await stdin() as never);console.log(JSON.stringify({registered:true}));return;}
    if(action==='claim'){const workerHost=process.argv[4];if(!workerHost)throw new Error('claim requires a registered host name');console.log(JSON.stringify(await claimCorrection(client,workerHost)));return;}
    if(action==='prepare'){
      const body=await stdin() as {id:number;leaseToken:string;runId:string;head:string};
      const row=(await client.query('SELECT q.*,l.repo FROM review_corrections q JOIN review_launches l ON l.card=q.launch_card WHERE q.id=$1',[body.id])).rows[0];if(!row)throw new Error('Unknown correction');
      const repo=host.repositories[row.repo];if(!repo)return handleCorrectionLookupFailure(client,'prepare',body.id,body.leaseToken,new SafeProcessError('identity'));
      try{await new GitHub(host,repo).correction(row.card,row.pr,row.head,row.base);}
      catch(error){return handleCorrectionLookupFailure(client,'prepare',body.id,body.leaseToken,error);}
      console.log(JSON.stringify(await prepareCorrection(client,body.id,body.leaseToken,body.runId,body.head)));return;
    }
    if(action==='ack'){
      const body=await stdin() as {id:number;leaseToken:string;runId:string;processId:string;head:string};
      const row=(await client.query('SELECT q.*,l.repo FROM review_corrections q JOIN review_launches l ON l.card=q.launch_card WHERE q.id=$1',[body.id])).rows[0];if(!row)throw new Error('Unknown correction');
      const repo=host.repositories[row.repo];if(!repo)return handleCorrectionLookupFailure(client,'ack',body.id,body.leaseToken,new SafeProcessError('identity'));
      const github=new GitHub(host,repo);
      let acknowledged;
      const leaseDeadline=new Date(row.lease_until).getTime();
      if(!Number.isFinite(leaseDeadline))return handleCorrectionLookupFailure(client,'ack',body.id,body.leaseToken,new SafeProcessError('identity'));
      const deadlineAt=Math.min(leaseDeadline-1_000,Date.now()+20_000);
      try{acknowledged=await acknowledgeCorrectionAfterLookup(client,{id:body.id,token:body.leaseToken,runId:body.runId,processId:body.processId,head:body.head},timeout=>github.correction(row.card,row.pr,row.head,row.base,timeout),{deadlineAt});}
      catch(error){return handleCorrectionLookupFailure(client,'ack',body.id,body.leaseToken,error);}
      console.log(JSON.stringify(acknowledged));return;
    }
    if(action==='retry'){const body=await stdin() as {id:number;leaseToken:string;reason:string;delaySeconds?:number};await retryCorrection(client,body.id,body.leaseToken,body.reason,body.delaySeconds);console.log(JSON.stringify({retried:true}));return;}
    if(action==='cancel'){const body=await stdin() as {id:number;reason:string};await cancelCorrection(client,body.id,body.reason);console.log(JSON.stringify({cancelled:true}));return;}
    if(action==='finish'){const body=await stdin() as {id:number;runId:string;head:string};await finishCorrection(client,body.id,body.runId,body.head);console.log(JSON.stringify({submitted:true}));return;}
    if(action==='status'){console.log(JSON.stringify((await client.query('SELECT q.*,f.code,f.reason,f.required_fix,f.verification FROM review_corrections q JOIN review_feedback f ON f.id=q.feedback_id ORDER BY q.id DESC LIMIT 100')).rows));return;}
    const result=await tick(client,host); const job=result.job; console.log(JSON.stringify({claimed:result.claimed,id:job?.id,state:job?.state,merged:job?.merged,deployed:job?.deployed,error:job?.error})); } finally { await client.end(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Review worker failed'); process.exitCode=1; });
