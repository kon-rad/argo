/**
 * The server-only half of `secondbrain doctor`: the checks that read systemd
 * (failed timers, the last backup). Kept apart from doctor.ts so a laptop never
 * loads child_process, and imported only when `deep` is asked for.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Check } from './doctor.js';

const exec = promisify(execFile);

async function systemctl(args: string[]): Promise<string> {
  const { stdout } = await exec('systemctl', args, { timeout: 5000 });
  return stdout;
}

export async function runServerChecks(_connected: boolean): Promise<Check[]> {
  const checks: Check[] = [];

  // Any failed secondbrain-* service: the ones a broken deploy or a crashed run leaves behind.
  try {
    const out = await systemctl(['list-units', '--type=service', '--state=failed', '--no-legend', '--plain']);
    const failed = out.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((u) => u && u.includes('secondbrain'));
    checks.push(
      failed.length
        ? { name: 'timers', ok: false, critical: false, detail: `failed units: ${failed.join(', ')}`, hint: 'journalctl -u <unit>' }
        : { name: 'timers', ok: true, critical: false, detail: 'no failed secondbrain units' },
    );
  } catch (err) {
    checks.push({ name: 'timers', ok: true, critical: false, skipped: true, detail: `skipped: systemctl unavailable (${err instanceof Error ? err.message.split('\n')[0]! : String(err)})` });
  }

  // The last successful backup: the db-backup timer stamps its unit's last run.
  try {
    const out = await systemctl(['show', 'secondbrain-db-backup.service', '-p', 'ExecMainStartTimestamp', '-p', 'ActiveState']);
    const stamp = /ExecMainStartTimestamp=(.*)/.exec(out)?.[1]?.trim();
    const active = /ActiveState=(.*)/.exec(out)?.[1]?.trim();
    checks.push(
      stamp
        ? { name: 'backup', ok: true, critical: false, detail: `last backup ${stamp}${active ? ` (${active})` : ''}` }
        : { name: 'backup', ok: true, critical: false, skipped: true, detail: 'no db-backup unit on this machine' },
    );
  } catch {
    checks.push({ name: 'backup', ok: true, critical: false, skipped: true, detail: 'skipped: no db-backup unit on this machine' });
  }

  return checks;
}
