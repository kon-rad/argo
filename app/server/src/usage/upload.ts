import { spawn } from 'node:child_process';

/** Version 2 acknowledgement: nothing advances until every submitted item committed. */
export function acceptedUpload(code: number | null, stdout: string, count: number): boolean {
  if (code !== 0) return false;
  try {
    const ack = JSON.parse(stdout) as { v: number; lines: number; accepted: number[]; rejected: number[]; quarantined?: number[] };
    if (ack.v !== 2 || ack.lines !== count || !Array.isArray(ack.accepted) || !Array.isArray(ack.rejected)) return false;
    const quarantined = ack.quarantined ?? [];
    if (!Array.isArray(quarantined) || ack.rejected.some(n => !quarantined.includes(n)) || quarantined.some(n => !ack.rejected.includes(n))) return false;
    const covered = [...ack.accepted, ...quarantined].sort((a, b) => a - b);
    return covered.length === count && covered.every((n, i) => n === i + 1);
  } catch { return false; }
}

/** Includes connect, backpressure, upload, remote import and child shutdown in one deadline. */
export async function runUpload(command: string, args: string[], lines: string[], deadlineMs: number): Promise<{
  ok: boolean; reason: 'ok' | 'deadline' | 'stdin' | 'spawn' | 'ack'; code: number | null; stdout: string;
}> {
  return new Promise(resolve => {
    const child = spawn(command, args, { detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    let reason: 'deadline' | 'stdin' | 'spawn' | 'ack' | null = null;
    let settled = false;
    const kill = () => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already exited */ }
    };
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const ok = !reason && acceptedUpload(code, stdout, lines.length);
      resolve({ ok, reason: reason ?? (ok ? 'ok' : 'ack'), code, stdout });
    };
    const timer = setTimeout(() => { reason = 'deadline'; kill(); finish(null); }, deadlineMs);
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length + chunk.length > 32 * 1024 * 1024) { reason = 'ack'; kill(); }
      else stdout += chunk.toString();
    });
    child.on('error', () => { reason = 'spawn'; kill(); finish(null); });
    child.stdin.on('error', () => { reason = 'stdin'; kill(); });
    child.on('close', finish);
    // write callbacks provide backpressure without retaining another copy of the batch.
    let index = 0, offset = 0;
    const write = () => {
      if (settled || reason) return;
      if (index === lines.length) { child.stdin.end(); return; }
      const line = lines[index]!;
      let end = Math.min(line.length, offset + 64 * 1024);
      // Avoid splitting a surrogate pair between UTF-8 writes.
      if (end < line.length && /[\uD800-\uDBFF]/.test(line[end - 1]!)) end--;
      const chunk = line.slice(offset, end);
      offset = end;
      const complete = offset === line.length;
      if (complete) { index++; offset = 0; }
      child.stdin.write(chunk + (complete ? '\n' : ''), err => { if (!err) write(); });
    };
    write();
  });
}
