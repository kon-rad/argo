import { appendFileSync, chmodSync } from 'node:fs';
import { spawn } from 'node:child_process';

let privateLog:string|undefined;
export function setPrivateLog(path:string):void{privateLog=path;}
function logFailure(detail:string):void{if(privateLog){try{appendFileSync(privateLog,new Date().toISOString()+' '+detail+'\n',{mode:0o600});chmodSync(privateLog,0o600);}catch{/* Never disclose a sensitive child error to the board. */}}}

export type SafeFailureKind='temporary'|'authentication'|'identity'|'confirmed-stale';
export class SafeProcessError extends Error {
  constructor(readonly kind:SafeFailureKind, _discardedDetail?:string, safeMessage=`Adapter ${kind} failure`){super(safeMessage);this.name='SafeProcessError';}
}
function failureKind(stderr:string):SafeFailureKind {
  const text=stderr.toLowerCase();
  if(/authentication|not logged|bad credentials|gh auth login|http 401|status 401/.test(text))return 'authentication';
  if(/timed? out|timeout|network|connection|temporar|rate.?limit|http 429|status 429|http 5\d\d|status 5\d\d/.test(text))return 'temporary';
  return 'identity';
}
export function correctionLookupDisposition(phase:'prepare'|'ack'|'finish',error:unknown):{action:'retry'|'reconcile'|'cancel';reason:string}{
  const kind=error instanceof SafeProcessError ? error.kind : 'identity';
  if(kind==='confirmed-stale')return {action:'cancel',reason:`Correction PR binding changed or closed before ${phase==='ack'?'acknowledgement':phase==='finish'?'completion':'launch preparation'}`};
  if(kind==='temporary' && phase==='prepare')return {action:'retry',reason:'Correction PR lookup temporarily unavailable before launch preparation'};
  if(kind==='temporary')return {action:'reconcile',reason:'Correction PR lookup unavailable after run reservation; owner reconciliation required'};
  return {action:'reconcile',reason:'Correction PR authentication or identity uncertain; owner reconciliation required'};
}

export interface CorrectionLookupRetryOptions {
  attempts?:number;
  delayMs?:number;
  deadlineMs?:number;
  deadlineAt?:number;
  perAttemptTimeoutMs?:number;
  now?:()=>number;
  sleep?:(delayMs:number)=>Promise<void>;
}

/** Retry only an acknowledgement's read-only binding lookup; the reserved run and process stay untouched. */
export async function retryCorrectionLookup(lookup:(timeoutMs:number)=>Promise<void>,options:CorrectionLookupRetryOptions={}):Promise<void>{
  const attempts=options.attempts ?? 3;
  const delayMs=options.delayMs ?? 250;
  const deadlineMs=options.deadlineMs ?? 20_000;
  const perAttemptTimeoutMs=options.perAttemptTimeoutMs ?? 5_000;
  if(!Number.isInteger(attempts) || attempts<1 || attempts>5 || delayMs<0 || deadlineMs<1 || perAttemptTimeoutMs<1)throw new Error('Invalid correction lookup retry bounds');
  const now=options.now ?? Date.now;
  const sleep=options.sleep ?? (delay=>new Promise<void>(resolve=>setTimeout(resolve,delay)));
  const deadlineAt=options.deadlineAt ?? now()+deadlineMs;
  for(let attempt=1;attempt<=attempts;attempt+=1){
    try{
      const remaining=deadlineAt-now();
      if(remaining<=0)throw new SafeProcessError('temporary');
      await lookup(Math.max(1,Math.min(perAttemptTimeoutMs,remaining)));
      if(now()>=deadlineAt)throw new SafeProcessError('temporary');
      return;
    }
    catch(error){
      if(!(error instanceof SafeProcessError) || error.kind!=='temporary' || attempt===attempts)throw error;
      if(delayMs>=deadlineAt-now())throw error;
      await sleep(delayMs);
    }
  }
}

/** No shell, inherited loader options, API keys, DB credentials or ambient Git config. */
export function childEnv(home: string, github = false): NodeJS.ProcessEnv {
  return { PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8',
    GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    ...(github && process.env.GH_TOKEN ? { GH_TOKEN: process.env.GH_TOKEN, GIT_CONFIG_COUNT:'1', GIT_CONFIG_KEY_0:'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0:'AUTHORIZATION: basic '+Buffer.from('x-access-token:'+process.env.GH_TOKEN).toString('base64') } : {}) };
}
export async function command(exe: string, argv: string[], cwd: string, env: NodeJS.ProcessEnv, timeout = 120_000, maxBytes = 1_000_000, includeStderr = false, input?:string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, argv, { cwd, env, stdio: [input===undefined?'ignore':'pipe', 'pipe', 'pipe'], detached: true });
    child.stdin?.on('error',()=>{});
    if(input!==undefined) child.stdin?.end(input);
    let out = '', err = '', bytes = 0, failed = false;
    const stop = (message: string,kind:SafeFailureKind='identity') => {
      if (failed) return; failed = true;
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* process already exited */ }
      reject(new SafeProcessError(kind,undefined,message));
    };
    const timer = setTimeout(() => stop('Adapter timed out','temporary'), timeout);
    child.stdout!.on('data', (b: Buffer) => { bytes += b.length; if (bytes > maxBytes) stop('Adapter output truncated at byte limit'); else out += b.toString(); });
    child.stderr!.on('data', (b: Buffer) => { bytes += b.length; if (bytes > maxBytes) stop('Adapter output truncated at byte limit'); else err += b.toString(); });
    child.on('error', () => { clearTimeout(timer); stop('Adapter executable unavailable','identity'); });
    child.on('close', code => {
      clearTimeout(timer); if (failed) return;
      // Child output can contain secrets; never persist raw stderr in a board error.
      if (code !== 0) { logFailure(`${exe} exit ${code}\n${err}\n${out}`); reject(new SafeProcessError(failureKind(err),`Adapter exited ${code}`)); }
      else resolve(includeStderr ? out+err : out);
    });
  });
}

/** Binary-safe stdout for verification artifacts. It keeps the same bounded, detached execution policy as command(). */
export async function commandBytes(exe: string, argv: string[], cwd: string, env: NodeJS.ProcessEnv, timeout = 120_000, maxBytes = 1_000_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const out: Buffer[] = [], err: Buffer[] = []; let bytes = 0, failed = false;
    const stop = (message: string, kind: SafeFailureKind = 'identity') => {
      if (failed) return; failed = true;
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* process already exited */ }
      reject(new SafeProcessError(kind, undefined, message));
    };
    const timer = setTimeout(() => stop('Adapter timed out', 'temporary'), timeout);
    const collect = (part: Buffer, target: Buffer[]) => { bytes += part.length; if (bytes > maxBytes) stop('Adapter output truncated at byte limit'); else target.push(part); };
    child.stdout!.on('data', (part: Buffer) => collect(part, out));
    child.stderr!.on('data', (part: Buffer) => collect(part, err));
    child.on('error', () => { clearTimeout(timer); stop('Adapter executable unavailable', 'identity'); });
    child.on('close', code => {
      clearTimeout(timer); if (failed) return;
      if (code !== 0) { logFailure(`${exe} exit ${code}\n${Buffer.concat(err).toString()}\n${Buffer.concat(out).toString()}`); reject(new SafeProcessError(failureKind(Buffer.concat(err).toString()), `Adapter exited ${code}`)); }
      else resolve(Buffer.concat(out));
    });
  });
}
