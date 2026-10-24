import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The vault sync's state file, written by `secondbrain-vault sync` (tools/sbsync.py) on the
 * machine the app runs on. The app only reads it, for the header chip and GET /api/sync.
 * Absent file: the sync is not installed here, and the chip stays hidden.
 */
export interface SyncState {
  installed: true;
  machine: string;
  role: string;
  policy: string;
  last_run: string | null;
  last_success: string | null;
  last_result: string | null;
  last_error: string | null;
  ahead: number;
  behind: number;
  conflict_files: string[];
  push_failures: number;
}

export function syncStateFile(stateDir?: string, home = homedir()): string {
  return join(stateDir || join(home, '.local', 'state', 'secondbrain'), 'sync.json');
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The state as the chip needs it, or null when the file is missing or unreadable. */
export function readSyncState(file: string): SyncState | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  return {
    installed: true,
    machine: str(d.machine) ?? 'this machine',
    role: str(d.role) ?? 'owner',
    policy: str(d.policy) ?? 'stop',
    last_run: str(d.last_run),
    last_success: str(d.last_success),
    last_result: str(d.last_result),
    last_error: str(d.last_error),
    ahead: num(d.ahead),
    behind: num(d.behind),
    conflict_files: Array.isArray(d.conflict_files) ? d.conflict_files.filter((f): f is string => typeof f === 'string') : [],
    push_failures: num(d.push_failures),
  };
}
