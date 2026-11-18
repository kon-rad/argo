import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function attemptBudget(args: string[], fallback: number): number {
  const index = args.indexOf('--deadline-ms');
  const ms = index < 0 ? fallback : Number(args[index + 1]);
  if (!Number.isSafeInteger(ms) || ms < 1 || ms > 1_800_000) throw new Error('invalid --deadline-ms');
  return ms;
}

/** The parent stays responsive while a child does synchronous scanning/parsing/SQLite work.
 * A private temporary directory belongs to the parent, including after SIGKILL.
 */
export async function supervise(command: string, args: string[], ms: number,
  env: NodeJS.ProcessEnv = process.env): Promise<{ code: number; reason: 'exit' | 'deadline' | 'spawn' }> {
  const scratch = mkdtempSync(join(tmpdir(), 'sb-attempt-'));
  try {
    return await new Promise(resolve => {
      const child = spawn(command, args, { detached: process.platform !== 'win32', stdio: 'inherit',
        env: { ...env, TMPDIR: scratch, TMP: scratch, TEMP: scratch } });
      let reason: 'exit' | 'deadline' | 'spawn' = 'exit';
      const timer = setTimeout(() => {
        reason = 'deadline';
        console.error('stage=attempt-end reason=deadline cursor=retained-for-uncommitted-work');
        try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already exited */ }
      }, ms);
      child.once('error', () => { clearTimeout(timer); resolve({ code: 1, reason: 'spawn' }); });
      child.once('close', code => { clearTimeout(timer); resolve({ code: reason === 'exit' ? code ?? 1 : 1, reason }); });
    });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

export async function superviseSelf(entry: string, fallback: number, reportTimeout = false): Promise<number | null> {
  if (process.env.SB_ATTEMPT_CHILD === entry) return null;
  const result = await supervise(process.execPath, [...process.execArgv, entry, ...process.argv.slice(2)],
    attemptBudget(process.argv.slice(2), fallback), { ...process.env, SB_ATTEMPT_CHILD: entry });
  if (result.reason === 'deadline' && reportTimeout) {
    // A separate, short reporting attempt cannot extend the worker deadline indefinitely.
    await supervise(process.execPath, [...process.execArgv, entry, ...process.argv.slice(2), '--health-timeout'],
      10_000, { ...process.env, SB_ATTEMPT_CHILD: entry });
  }
  return result.code;
}
