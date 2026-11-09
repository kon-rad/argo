import { appendFileSync, chmodSync } from 'node:fs';
import { spawn } from 'node:child_process';

let privateLog:string|undefined;
export function setPrivateLog(path:string):void{privateLog=path;}
function logFailure(detail:string):void{if(privateLog){try{appendFileSync(privateLog,new Date().toISOString()+' '+detail+'\n',{mode:0o600});chmodSync(privateLog,0o600);}catch{/* Never disclose a sensitive child error to the board. */}}}

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
    const stop = (message: string) => {
      if (failed) return; failed = true;
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* process already exited */ }
      reject(new Error(message));
    };
    const timer = setTimeout(() => stop('Adapter timed out'), timeout);
    child.stdout!.on('data', (b: Buffer) => { bytes += b.length; if (bytes > maxBytes) stop('Adapter output truncated at byte limit'); else out += b.toString(); });
    child.stderr!.on('data', (b: Buffer) => { bytes += b.length; if (bytes > maxBytes) stop('Adapter output truncated at byte limit'); else err += b.toString(); });
    child.on('error', () => { clearTimeout(timer); stop('Adapter executable unavailable'); });
    child.on('close', code => {
      clearTimeout(timer); if (failed) return;
      // Child output can contain secrets; never persist raw stderr in a board error.
      if (code !== 0) { logFailure(`${exe} exit ${code}\n${err}\n${out}`); reject(new Error(`Adapter exited ${code}; inspect the protected host log`)); }
      else resolve(includeStderr ? out+err : out);
    });
  });
}
