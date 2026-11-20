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

import type { ArchiveRow } from '../src/addons/observatory/adapters.js';
const codexRow = (tool: string, args: unknown): ArchiveRow => ({
  id: 10, session_id: 1, seq: 10, ts: new Date(10), role: 'assistant', kind: 'response_item',
  host: 'test-host', source: 'codex', harness: 'codex', external_id: 's', observed_at: null, text: '',
  raw: { harness: 'codex', type: 'response_item', payload: { type: 'function_call', name: tool, call_id: 'call', arguments: JSON.stringify(args) } },
});
it.each([['Read', 'read'], ['Write', 'write'], ['Edit', 'edit']] as const)('extracts Codex %s archive arguments without stored text', (tool, operation) => {
  const target = (path: string) => archiveEvents([codexRow(tool, { file_path: path, content: 'PRIVATE_BODY' })], '/srv/vault')[0]?.target;
  expect(target('/srv/vault/Projects/demo.md')).toEqual({ path: '/srv/vault/Projects/demo.md', operation, vaultPath: 'Projects/demo.md' });
  expect(target('/srv/vault/.secondbrain/README.md')).toEqual({ path: '/srv/vault/.secondbrain/README.md', operation });
  expect(JSON.stringify(archiveEvents([codexRow(tool, { file_path: '/srv/vault/Projects/demo.md', content: 'PRIVATE_BODY' })], '/srv/vault'))).not.toContain('PRIVATE_BODY');
});
it('retains structured input bounds for Codex calls', () => {
  for (const args of [null, [], { path: '' }, { path: 'x'.repeat(1025) }, { path: 'bad\u0000path' }, { path: '/srv/vault/Projects/demo.md', content: 'x'.repeat(1000001) }]) {
    expect(archiveEvents([codexRow('Read', args)], '/srv/vault')[0]?.target).toBeUndefined();
  }
  const malformed = codexRow('Read', {});
  (malformed.raw as { payload: { arguments: string } }).payload.arguments = '{bad json';
  expect(archiveEvents([malformed], '/srv/vault')[0]?.target).toBeUndefined();
});
const noteRow = (tool: string, path: string): ArchiveRow => ({
  ...codexRow(tool, {}), source: 'zen-agent', harness: 'zen-agent',
  raw: { harness: 'zen-agent', type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'note', name: tool, arguments: { path } }] } },
});
it('uses the verified zen read_note vault-relative contract, retaining out-of-contract paths unresolved', () => {
  const target = (path: string) => archiveEvents([noteRow('read_note', path)])[0]?.target;
  expect(target('Projects/demo.md')).toEqual({ path: 'Projects/demo.md', vaultPath: 'Projects/demo.md', operation: 'read' });
  for (const path of ['../outside.md', '/srv/other/demo.md', '.secondbrain/README.md', 'Projects/../demo.md', 'C:/demo.md', 'Projects\\demo.md']) {
    expect(target(path)).toEqual({ path, operation: 'read' });
  }
  // The name alone does not establish that another backend uses zen's contract.
  expect(archiveEvents([codexRow('read_note', { path: 'Projects/demo.md' })])[0]?.target).toEqual({ path: 'Projects/demo.md', operation: 'read' });
});
it('retains write_note attempts but requires an absolute root boundary without a verified relative backend contract', () => {
  const target = (path: string) => archiveEvents([noteRow('write_note', path)], '/srv/vault')[0]?.target;
  expect(target('/srv/vault/Projects/demo.md')).toEqual({ path: '/srv/vault/Projects/demo.md', vaultPath: 'Projects/demo.md', operation: 'write' });
  for (const path of ['Projects/demo.md', '../outside.md', '/srv/other/demo.md', '/srv/vault/.secondbrain/README.md']) expect(target(path)).toEqual({ path, operation: 'write' });
});
