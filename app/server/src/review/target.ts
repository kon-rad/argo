#!/usr/bin/env node
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { command, childEnv } from './process.js';

const Config = z.object({ stateDir:z.string().startsWith('/'),cwd:z.string().startsWith('/'),home:z.string().startsWith('/'),
  deployArgv:z.array(z.string()).min(1),healthArgv:z.array(z.string()).min(1) }).strict();
const Health = z.object({ revision:z.string().regex(/^[a-f0-9]{40}$/),healthy:z.boolean() }).strict();
/** A single-host, durable allowlisted target bridge. Ambiguous effects are reconciled by health, never replayed. */
export async function targetMain(args: string[]): Promise<void> {
  const [file,action,revision,key] = args;
  if (!file || !['deploy','health'].includes(action ?? '') || !/^[a-f0-9]{40}$/.test(revision ?? '') || !/^\d+$/.test(key ?? '')) throw new Error('Usage: target owner-config.json deploy|health SHA numeric-key');
  const info = await stat(file);
  if ((info.mode&0o022) || (info.uid !== process.getuid?.() && info.uid !== 0)) throw new Error('Target config must be owner-owned and not group/world writable');
  const cfg = Config.parse(JSON.parse(await readFile(file,'utf8')));
  if (!cfg.deployArgv[0]!.startsWith('/') || !cfg.healthArgv[0]!.startsWith('/')) throw new Error('Target executables must be absolute');
  await mkdir(cfg.stateDir,{recursive:true,mode:0o700});
  const lock = join(cfg.stateDir,'lock');
  // Lock directory remains after an interrupted process. The owner reconciles it after checking no child is alive.
  try { await mkdir(lock,{mode:0o700}); } catch { throw new Error('Target locked; owner must reconcile interrupted target process'); }
  const run = async (argv:string[]) => command(argv[0]!,[...argv.slice(1),revision!,key!],cfg.cwd,childEnv(cfg.home),540_000);
  const health = async () => Health.parse(JSON.parse(await run(cfg.healthArgv)));
  const receiptFile = join(cfg.stateDir,`${key}.json`);
  const durable = async (path:string,data:unknown,exclusive=false) => {
    const temp=exclusive?path:`${path}.tmp`;
    const handle=await open(temp,exclusive?'wx':'w',0o600);
    try {await handle.writeFile(JSON.stringify(data));await handle.sync();}finally{await handle.close();}
    if(!exclusive) await rename(temp,path);
    const directory=await open(cfg.stateDir,'r');try{await directory.sync();}finally{await directory.close();}
  };
  const write = (data:unknown) => durable(receiptFile,data);
  try {
    let previous: {revision:string;state:string}|undefined;
    try { previous=JSON.parse(await readFile(receiptFile,'utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (previous && previous.revision !== revision) throw new Error('Idempotency key reused for another revision');
    // A different key with an unresolved effect prevents every subsequent deploy on this target.
    const barrier = join(cfg.stateDir,'inflight.json');
    let inflight: {key:string;revision:string}|undefined;
    try { inflight=JSON.parse(await readFile(barrier,'utf8')); } catch(e) { if ((e as NodeJS.ErrnoException).code!=='ENOENT') throw e; }
    if (inflight && (inflight.key!==key || inflight.revision!==revision)) throw new Error('Earlier target deployment requires reconciliation');
    if (action==='deploy' && !previous && !inflight) {
      await durable(barrier,{key,revision},true);
      await write({revision,state:'inflight'});
      await run(cfg.deployArgv);
    }
    const result = await health();
    if (result.revision!==revision || !result.healthy) throw new Error('Target health does not attest exact revision; effect remains unresolved');
    if (previous?.state==='inflight' || action==='deploy') {
      await write({revision,state:'healthy'});
      if (inflight || action==='deploy') await rm(barrier,{force:true});
    }
    console.log(JSON.stringify({revision,healthy:true,key}));
  } finally { await rm(lock,{recursive:true,force:true}); }
}
if (process.argv[1]?.endsWith('/review/target.js')) targetMain(process.argv.slice(2)).catch(error => {console.error((error as Error).message);process.exitCode=1;});
