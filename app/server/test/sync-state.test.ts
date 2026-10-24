import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSyncState, syncStateFile } from '../src/syncState.js';

describe('vault sync state', () => {
  it('finds the file under the state dir, defaulting to ~/.local/state/secondbrain', () => {
    expect(syncStateFile(undefined, '/home/u')).toBe('/home/u/.local/state/secondbrain/sync.json');
    expect(syncStateFile('/var/lib/sync', '/home/u')).toBe('/var/lib/sync/sync.json');
  });

  it('reads what the chip needs and nothing else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-sync-'));
    const file = join(dir, 'sync.json');
    writeFileSync(file, JSON.stringify({
      machine: 'laptop', role: 'owner', policy: 'stop', last_run: '2026-10-24T10:00:00+00:00',
      last_success: '2026-10-24T09:00:00+00:00', last_result: 'conflict', last_error: '1 file: note.md',
      ahead: 2, behind: 1, conflict_files: ['note.md', 7], push_failures: 0, alerted: { 'conflict:note.md': 'x' },
      vault: '/somewhere',
    }));
    const s = readSyncState(file);
    expect(s).toEqual({
      installed: true, machine: 'laptop', role: 'owner', policy: 'stop', last_run: '2026-10-24T10:00:00+00:00',
      last_success: '2026-10-24T09:00:00+00:00', last_result: 'conflict', last_error: '1 file: note.md',
      ahead: 2, behind: 1, conflict_files: ['note.md'], push_failures: 0,
    });
  });

  it('is null when the sync is not installed here or the file is broken', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-sync-'));
    expect(readSyncState(join(dir, 'sync.json'))).toBeNull();
    writeFileSync(join(dir, 'sync.json'), '{not json');
    expect(readSyncState(join(dir, 'sync.json'))).toBeNull();
    writeFileSync(join(dir, 'sync.json'), '[]');
    expect(readSyncState(join(dir, 'sync.json'))).toBeNull();
  });
});
