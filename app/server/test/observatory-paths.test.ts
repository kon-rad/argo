import { expect, it } from 'vitest';
import { vaultPath } from '../src/addons/observatory/paths.js';
it('requires an absolute vault boundary and keeps repository and unknown cwd targets separate', () => {
  expect(vaultPath('/srv/vault/Projects/demo.md', '/srv/vault')).toBe('Projects/demo.md');
  expect(vaultPath('/srv/vault/Projects/../Areas/demo.md', '/srv/vault/')).toBe('Areas/demo.md');
  for (const path of ['Projects/demo.md', '/srv/vault-other/Projects/demo.md', '/srv/vault/../demo.md', '/srv/vault/.secondbrain/README.md']) expect(vaultPath(path, '/srv/vault')).toBeUndefined();
  expect(vaultPath('/srv/vault/Projects/demo.md')).toBeUndefined();
});

import { archiveEvents } from '../src/addons/observatory/adapters.js';
it('adds scope only from configured roots, retains raw evidence and ignores tool-supplied scope claims', () => {
  const row = (id: number, path: string) => ({ id, session_id: 1, seq: id, ts: new Date(id), role: 'assistant', kind: 'message', host: 'test-host', source: 'hermes', harness: 'hermes', external_id: 's', observed_at: null, text: '', raw: { role: 'assistant', session_id: 's', tool_calls: [{ id: String(id), function: { name: 'read', arguments: JSON.stringify({ path, vaultPath: 'Projects/demo.md' }) } }] } });
  const rows = [row(1, '/srv/vault/Projects/demo.md'), row(2, 'Projects/demo.md'), row(3, '/srv/vault/.secondbrain/README.md')];
  expect(archiveEvents(rows, '/srv/vault').map(e => e.target)).toEqual([
    { path: '/srv/vault/Projects/demo.md', vaultPath: 'Projects/demo.md', operation: 'read' },
    { path: 'Projects/demo.md', operation: 'read' },
    { path: '/srv/vault/.secondbrain/README.md', operation: 'read' },
  ]);
  expect(archiveEvents(rows)[0]?.target?.vaultPath).toBeUndefined();
});
