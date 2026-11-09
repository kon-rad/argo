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

async function main(): Promise<void> {
  const [action,path] = process.argv.slice(2);
  if (action === 'fixture') { console.log(JSON.stringify(await runFixture(),null,2)); return; }
  if (!['tick','stage','retries'].includes(action ?? '') || !path) throw new Error('Usage: cli-review fixture | tick|stage|retries /absolute/owner-policy.json');
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
    if(action==='stage'){let raw='';for await(const part of process.stdin){raw+=String(part);if(Buffer.byteLength(raw)>160000)throw new Error('Evidence upload too large');}console.log(JSON.stringify(await stage(client,host.evidenceRoot,JSON.parse(raw))));return;}
    const result=await tick(client,host); const job=result.job; console.log(JSON.stringify({claimed:result.claimed,id:job?.id,state:job?.state,merged:job?.merged,deployed:job?.deployed,error:job?.error})); } finally { await client.end(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Review worker failed'); process.exitCode=1; });
