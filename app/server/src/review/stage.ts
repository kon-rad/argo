import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';
import { z } from 'zod';
import { source, } from './context.js';
import { digest } from './gate.js';
import { LaunchRegistration } from './launch.js';
import { registerLaunch } from './corrections.js';

export const Artifact = z.object({card:z.string().regex(/^t_[a-f0-9]{6,32}$/),head:z.string().regex(/^[a-f0-9]{40}$/),result:z.string().min(1).max(70000),log:z.string().min(1).max(70000),launch:LaunchRegistration.optional()}).strict();
/** Trusted host ingestion, sharing the same content lock as the shipping worker. */
export async function stage(client:pg.Client,root:string,input:unknown):Promise<{staged:boolean;reason?:string}> {
 const a=Artifact.parse(input),key=`review-content:${a.card}`;
 if(!(await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok',[key])).rows[0]?.ok)return {staged:false,reason:'Review is reading frozen evidence'};
 try{
  const job=(await client.query('SELECT * FROM review_jobs WHERE card=$1 ORDER BY id DESC LIMIT 1',[a.card])).rows[0];
  if(!job)return {staged:false,reason:'No submitted review'};
  await client.query('SELECT review_context($1)',[job.id]);
  if(job.state==='done')return {staged:false,reason:'Already completed'};
  if(a.launch){if(a.launch.card!==a.card)return {staged:false,reason:'Launch registration is for a different card'};await registerLaunch(client,a.launch);}
  const dir=join(root,a.card),files=[['RESULT.md',a.result],['run.log',a.log]] as const;
  const values=files.map(([name,text])=>[name,`Builder revision: ${a.head}\nSource SHA256: ${digest(text)}\n\n${source(name,text).text}`] as const);
  const same=await Promise.all(values.map(async([name,text])=>{try{return await readFile(join(dir,name),'utf8')===text;}catch{return false;}}));
  if(same.every(Boolean))return {staged:true};
  if(job.merged || job.snapshot && !['rejected','queued'].includes(job.state))return {staged:false,reason:'Evidence already frozen for a reviewed submission'};
  await mkdir(dir,{recursive:true,mode:0o700});
  for(const [name,text]of values){const file=join(dir,name),tmp=file+'.stage';await writeFile(tmp,text,{mode:0o600});await rename(tmp,file);}
  return {staged:true};
 }finally{await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);}
}
