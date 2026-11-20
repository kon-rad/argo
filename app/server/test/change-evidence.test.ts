import { describe, expect, it } from 'vitest';
import { capturedChange } from '../src/archive/changeEvidence.js';
import { archiveEvents, makeWindow, inspectChangeRequest, captureMetadataPresent, capturedRequestBinding, type ArchiveRow } from '../src/addons/observatory/adapters.js';
import { replay } from '@secondbrain/contracts/observatory';
const hash = 'a'.repeat(64);
const change = { version: 1, id: 'capture-a', repository: hash, worktree: 'b'.repeat(64), path: 'notes/demo.md', before: null, after: hash,
  diff: { format: 'replacement', before: '', after: 'PRIVATE CONTENT', truncated: false } };
const raw = (extra = {}) => ({ harness: 'zen-agent', type: 'message', message: { role: 'toolResult', toolCallId: 'a', toolName: 'write_file', isError: false, details: { change }, ...extra } });
const row = (id: number, raw: unknown, evidence?: unknown): ArchiveRow => ({ id, session_id: 1, seq: id, ts: new Date(id * 1000), role: 'assistant', kind: 'message', raw, text: '', host: 'fixture', source: 'zen-agent', harness: 'zen-agent', external_id: 's', observed_at: null, change_evidence: evidence });
describe('prospective change evidence', () => {
  it('accepts only explicit successful structured results; failed, shell and unknown results stay unknown', () => {
    expect(capturedChange(raw())).toMatchObject({ level: 'captured-diff', path: change.path });
    for (const value of [raw({ isError: true }), raw({ isError: undefined }), raw({ toolName: 'bash' }), { details: { change } }]) expect(capturedChange(value)).toBeNull();
    expect(capturedChange(raw({ details: { change: { ...change, before: hash } } }))).toBeNull();
    expect(capturedChange(raw({ details: { change: { ...change, path: '../secret' } } }))).toBeNull();
    expect(JSON.stringify(capturedChange(raw()))).not.toContain('PRIVATE CONTENT');
  });
  it('requires exact local commit attestation and never invents PR/review/merge or reasoning', () => {
    const c = { ...change, commit: { sha: 'c'.repeat(40), verification: 'local-object', authorship: 'unknown' } };
    expect(capturedChange(raw({ toolName: 'inspect_change_commit', details: { change: c } }))).toMatchObject({ level: 'commit', commit: c.commit });
    expect(capturedChange(raw({ details: { change: c } }))).toBeNull();
  });
  it('replays a successful change only after its paired result and retains shared-worktree uncertainty', () => {
    const call = { harness: 'zen-agent', type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: 'write_file', arguments: { path: 'notes/demo.md', content: 'PRIVATE CONTENT' } }] } };
    const events = archiveEvents([row(1, call), row(2, raw(), capturedChange(raw()))]);
    expect(events[0]?.change).toBeUndefined();
    expect(events[1]?.change?.level).toBe('captured-diff');
    expect(events[1]?.parent).toBe(events[0]?.id);
    expect(events[1]?.target).toEqual(events[0]?.target);
    expect(events.every(e => e.execution === null)).toBe(true);
    const window = makeWindow(0, 5000, events, []);
    expect(replay(window, 1000).tools[events[0]!.id]).toBe('pending');
    expect(replay(window, 2000).tools[events[0]!.id]).toBe('success');
    expect(replay(window, 1000)).toEqual(replay(window, 1000));
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE CONTENT|reasoning|merged/);
    const unpaired = archiveEvents([row(2, raw(), capturedChange(raw()))]);
    expect(unpaired[0]?.change).toBeUndefined();
  });
});

import { reviewEvents } from '../src/addons/observatory/reviews.js';
it('replays trusted PR, review and verified merge receipts without borrowing future job state', () => {
  const sha = 'c'.repeat(40), base = 'd'.repeat(40);
  const r = (id: number, patch: unknown) => ({ id, job: 1, card: 'fixture-ticket', reviewer: 'reviewer', at: new Date(id * 1000), patch });
  const events = reviewEvents([
    r(1, { snapshot: { repo: 'example/engine', pr: 4, head: sha, base } }),
    r(2, { verdict: { decision: 'accept', head: 'e'.repeat(40), base } }),
    r(3, { verdict: { decision: 'accept', head: sha, base } }),
    r(4, { merged: sha }), r(5, { mergeVerified: sha }),
    r(6, { snapshot: null }), r(7, { mergeVerified: sha }),
  ]);
  expect(events.map(e => e.artifact?.stage)).toEqual(['pr-observed', 'review-accepted', 'merge-recorded', 'merge-verified']);
  expect(events.map(e => e.at)).toEqual([1000, 3000, 4000, 5000]);
  expect(events.every(e => e.execution === null)).toBe(true);
  expect(events[0]?.artifact?.head).toBe(sha);
  expect(events[3]?.artifact?.merge).toBe(sha);
});

import { buildRedactor } from '../src/archive/redact.js';
it('keeps diff bodies behind source detail and applies the archive redactor', () => {
  const secret = 'synthetic-secret-value-123456';
  const input = raw({ details: { change: { ...change, diff: { ...change.diff, after: secret } } } });
  const redacted = buildRedactor({ env: { FIXTURE_API_KEY: secret } }).deep(input);
  expect(JSON.stringify(redacted)).not.toContain(secret);
  expect(capturedChange(redacted)?.level).toBe('captured-diff');
});

import { changeDetail } from '../src/addons/observatory/changeDetail.js';
import type { TxClient } from '../src/db.js';
it('authorizes and revalidates lazy diff detail, strips extra fields and rejects changed source metadata', async () => {
  const event = archiveEvents([row(1, { harness: 'zen-agent', type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: 'write_file', arguments: { path: change.path } }] } }), row(2, raw(), capturedChange(raw()))])[1]!;
  const db = { query: async () => ({ rows: [{ raw: raw() }] }) } as unknown as TxClient;
  await expect(changeDetail(db, event, new Set())).rejects.toHaveProperty('status', 403);
  for (const outcome of ['unknown', 'error', undefined] as const)
    await expect(changeDetail(db, { ...event, outcome }, new Set(['usage']))).rejects.toHaveProperty('status', 404);
  const detail = await changeDetail(db, event, new Set(['usage']));
  expect(detail).toMatchObject({ diff: { after: 'PRIVATE CONTENT' }, representation: 'redacted-source' });
  expect(JSON.stringify(detail)).not.toContain('toolCallId');
  const oversized = { query: async () => ({ rows: [{ raw: null }] }) } as unknown as TxClient;
  await expect(changeDetail(oversized, event, new Set(['usage']))).rejects.toHaveProperty('status', 413);
  await expect(changeDetail(db, { ...event, change: { ...event.change!, after: 'd'.repeat(64) } }, new Set(['usage']))).rejects.toHaveProperty('status', 409);
});

it('rejects a stale normalized projection and ambiguous same-session calls', () => {
  const call = { harness: 'zen-agent', type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: 'write_file', arguments: { path: change.path } }] } };
  const projected = capturedChange(raw())!;
  const stale = archiveEvents([row(1, call), row(2, raw(), { ...projected, after: 'd'.repeat(64) })]);
  expect(stale[1]?.change).toBeUndefined();
  const ambiguous = archiveEvents([row(1, call), row(2, call), row(3, raw(), projected)]);
  expect(ambiguous[2]?.parent).toBeUndefined();
  expect(ambiguous[2]?.change).toBeUndefined();
});

for (const mismatch of ['tool', 'path', 'missing-tool'] as const) it(`leaves a same-ID ${mismatch} mismatch unpaired`, () => {
  const call = { harness: 'zen-agent', type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: 'write_file', arguments: { path: change.path } }] } };
  const result = mismatch === 'missing-tool' ? raw({ toolName: undefined }) : mismatch === 'tool' ? raw({ toolName: 'edit_file' })
    : raw({ details: { change: { ...change, path: 'notes/other.md' } } });
  const events = archiveEvents([row(1, call), row(2, result, capturedChange(result))]);
  expect(events[1]?.parent).toBeUndefined();
  expect(events[1]?.target).toBeUndefined();
  expect(events[1]?.writeEvidence).toBeUndefined();
  expect(events[1]?.change).toBeUndefined();
  expect(replay(makeWindow(0, 5000, events, []), 2000).tools[events[0]!.id]).toBe('pending');
});

import { createHash } from 'node:crypto';
it('requires exact worktree identity for absolute captured paths', () => {
  const root = '/srv/fixture-repo';
  const worktree = createHash('sha256').update(root).digest('hex');
  const result = raw({ details: { change: { ...change, worktree } } });
  const call = (path: string) => ({ harness: 'zen-agent', type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: 'write_file', arguments: { path } }] } });
  const paired = archiveEvents([row(1, call(`${root}/${change.path}`)), row(2, result, capturedChange(result))]);
  expect(paired[1]?.change?.worktree).toBe(worktree);
  for (const path of [`/srv/other-repo/${change.path}`, `notes/../${change.path}`]) {
    const events = archiveEvents([row(1, call(path)), row(2, result, capturedChange(result))]);
    expect(events[1]?.parent).toBeUndefined();
    expect(events[1]?.writeEvidence).toBeUndefined();
    expect(events[1]?.change).toBeUndefined();
  }
});

it.each(['codex', 'claude-code'])('pairs explicit call IDs from the known nameless %s result protocol', harness => {
  const call = harness === 'codex'
    ? { harness, type: 'response_item', payload: { type: 'function_call', call_id: 'protocol-call', name: 'write_file', arguments: JSON.stringify({ path: 'notes/demo.md' }) } }
    : { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'protocol-call', name: 'write_file', input: { path: 'notes/demo.md' } }] } };
  const result = harness === 'codex'
    ? { harness, type: 'response_item', payload: { type: 'function_call_output', call_id: 'protocol-call', output: { isError: false, text: 'written' } } }
    : { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'protocol-call', content: 'written' }] } };
  const events = archiveEvents([{ ...row(1, call), harness, source: harness }, { ...row(2, result), harness, source: harness }]);
  expect(events[1]?.parent).toBe(events[0]?.id);
  expect(events[1]?.target).toEqual(events[0]?.target);
  expect(events[1]?.change).toBeUndefined();
  if (harness === 'codex') expect(events[1]?.writeEvidence).toBe('tool-reported-success');
  else expect(events[1]?.writeEvidence).toBeUndefined(); // Claude's missing is_error is unknown, not success.
  const unknown = archiveEvents([{ ...row(1, call), harness: 'unknown' }, { ...row(2, result), harness: 'unknown' }]);
  expect(unknown[1]?.parent).toBeUndefined();
});

it.each(['capture', 'commit', 'missing-request'] as const)('does not attach a local commit to a mismatched %s request', mismatch => {
  const commit = { sha: 'c'.repeat(40), verification: 'local-object', authorship: 'unknown' };
  const captured = { ...change, commit };
  const args = mismatch === 'capture' ? { capture: 'another-capture', commit: commit.sha }
    : mismatch === 'commit' ? { capture: change.id, commit: 'd'.repeat(40) } : {};
  const call = { harness: 'zen-agent', type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: 'inspect_change_commit', arguments: args }] } };
  const result = raw({ toolName: 'inspect_change_commit', details: { change: captured } });
  const events = archiveEvents([row(1, call), row(2, result, capturedChange(result))]);
  expect(events[1]?.parent).toBeUndefined();
  expect(events[1]?.target).toBeUndefined();
  expect(events[1]?.change).toBeUndefined();
  expect(events[1]?.writeEvidence).toBeUndefined();
});

it('attaches a local commit only to the exact requested capture ID and commit SHA', () => {
  const commit = { sha: 'c'.repeat(40), verification: 'local-object', authorship: 'unknown' };
  const call = { harness: 'zen-agent', type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: 'inspect_change_commit', arguments: { capture: change.id, commit: commit.sha } }] } };
  const result = raw({ toolName: 'inspect_change_commit', details: { change: { ...change, commit } } });
  const events = archiveEvents([row(1, call), row(2, result, capturedChange(result))]);
  expect(events[1]?.parent).toBe(events[0]?.id);
  expect(events[1]?.change?.commit?.sha).toBe(commit.sha);
});

it('projects only bounded commit request bindings and preserves invalid capture presence', () => {
  const commit = 'c'.repeat(40);
  expect(inspectChangeRequest('inspect_change_commit', JSON.stringify({ capture: 'capture-a', commit, content: 'do not retain' })))
    .toEqual({ capture: 'capture-a', commit });
  for (const args of [{ capture: 'x'.repeat(129), commit }, { capture: 'capture-a', commit: 'HEAD' }, {}])
    expect(inspectChangeRequest('inspect_change_commit', JSON.stringify(args))).toBeUndefined();
  expect(inspectChangeRequest('write_file', JSON.stringify({ capture: 'capture-a', commit }))).toBeUndefined();
  expect(captureMetadataPresent(raw({ details: { change: null } }))).toBe(true);
  expect(captureMetadataPresent(raw({ details: { change: { invalid: true } } }))).toBe(true);
  expect(captureMetadataPresent(raw({ details: {} }))).toBe(false);
  const call = { harness: 'zen-agent', type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: 'write_file', arguments: { path: change.path } }] } };
  const invalid = raw({ details: { change: null } });
  const events = archiveEvents([row(1, call), row(2, invalid)]);
  expect(events[1]?.parent).toBeUndefined();
  expect(events[1]?.writeEvidence).toBeUndefined();
});

it('preserves the Hermes protocol with explicit IDs and an omitted optional tool_name', () => {
  const call = { role: 'assistant', session_id: 's', tool_calls: JSON.stringify([{ id: 'hermes-call', function: { name: 'write_file', arguments: JSON.stringify({ path: 'notes/demo.md' }) } }]) };
  const result = { role: 'tool', session_id: 's', tool_call_id: 'hermes-call', content: 'written' };
  const rows = (output: unknown, harness = 'hermes') => [{ ...row(1, call), harness, source: harness }, { ...row(2, output), harness, source: harness }];
  const events = archiveEvents(rows(result));
  expect(events[1]?.parent).toBe(events[0]?.id);
  expect(events[1]?.target).toEqual(events[0]?.target);
  expect(events[1]?.change).toBeUndefined();
  expect(events[1]?.writeEvidence).toBeUndefined(); // Plain content does not prove success.
  expect(archiveEvents(rows({ ...result, tool_name: 'edit_file' }))[1]?.parent).toBeUndefined();
  expect(archiveEvents(rows(result, 'unknown'))[1]?.parent).toBeUndefined();
});

import { parseZenTrace } from '../src/usage/zenTrace.js';
it('collects bounded redacted changed-line observations but keeps hunk text out of all overview metadata', async () => {
  const diff = { format: 'changed-lines', context: 0, redacted: true, truncated: false,
    hunks: [{ oldStart: 2, newStart: 2, deleted: ['old public\n', '[redacted:sensitive-line]\n'], added: ['new public\n', '[redacted:sensitive-line]\n'] }] };
  const result = raw({ details: { change: { ...change, diff } } });
  const call = { harness: 'zen-agent', type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: 'write_file', arguments: { path: change.path, content: 'new public\npassword=private-argument-literal' } }] } };
  const records = [{ type: 'meta', version: 1, id: 'synthetic-hunks', at: '2026-01-01T00:00:00Z', parts: [] }, call, result];
  const collected = parseZenTrace(records, 'fixture', '/synthetic/hunks.jsonl', new Date(5000)).session!;
  expect(JSON.stringify(collected.messages)).toContain('new public');
  const projected = capturedChange(result)!;
  expect(projected).toMatchObject({ level: 'captured-diff', diff: { format: 'changed-lines', context: 0, redacted: true, truncated: false } });
  expect(JSON.stringify(projected)).not.toContain('public'); expect(JSON.stringify(projected)).not.toContain('hunks');
  const events = archiveEvents([row(1, call), row(2, result, projected)]);
  const event = events[1]!;
  expect(event.change).toEqual(projected); expect(JSON.stringify(events)).not.toContain('public');
  const db = { query: async () => ({ rows: [{ raw: result }] }) } as unknown as TxClient;
  await expect(changeDetail(db, event, new Set())).rejects.toHaveProperty('status', 403);
  expect(await changeDetail(db, event, new Set(['usage']))).toMatchObject({ diff, originalHashes: { before: null, after: hash } });
  const stale = { query: async () => ({ rows: [{ raw: raw({ details: { change: { ...change, diff: { ...diff, context: 1 } } } }) }] }) } as unknown as TxClient;
  await expect(changeDetail(stale, event, new Set(['usage']))).rejects.toHaveProperty('status', 409);
  for (const invalid of [
    { ...diff, context: 1 }, { ...diff, redacted: false }, { ...diff, hunks: [{ oldStart: 1, newStart: 1, deleted: [], added: [] }] },
    { ...diff, hunks: [{ oldStart: 1, newStart: 1, deleted: [], added: ['x'.repeat(4097)] }] },
    { ...diff, hunks: [{ oldStart: 1, newStart: 1, deleted: [], added: Array(5).fill('x'.repeat(4000)) }] },
    { ...diff, truncated: true },
  ]) expect(capturedChange(raw({ details: { change: { ...change, diff: invalid } } }))).toBeNull();
  const fallback = capturedChange(raw({ details: { change: { ...change, diff: { format: 'changed-lines', context: 0, redacted: true, truncated: true, reason: 'binary' } } } }));
  expect(fallback).toMatchObject({ level: 'captured-hashes', diff: { reason: 'binary' } });
});
it('keeps collected argument records content-bearing while the overview and capture projection omit text', () => {
  const before = 'synthetic-private-write-argument-123456', after = 'synthetic-private-edit-argument-654321';
  const args = [{ path: change.path, content: before }, { path: change.path, old: before, new: after }];
  const records: Record<string, unknown>[] = [{ type: 'meta', version: 1, id: 'synthetic-content-trace', at: '2026-01-01T00:00:00Z', model: 'faux/faux-1', parts: [] }];
  for (const [i, name] of ['write_file', 'edit_file'].entries()) {
    records.push({ type: 'message', at: new Date(1000 + i * 2000).toISOString(), message: { role: 'assistant', content: [{ type: 'toolCall', id: `content-${i}`, name, arguments: args[i] }] } });
    records.push({ type: 'tool', at: new Date(1500 + i * 2000).toISOString(), toolCallId: `content-${i}`, name, args: args[i], isError: false, durationMs: 1 });
    records.push({ type: 'message', at: new Date(2000 + i * 2000).toISOString(), message: { role: 'toolResult', toolCallId: `content-${i}`, toolName: name, isError: false, content: [{ type: 'text', text: 'changed' }], details: { change: { ...change, id: `capture-${i}`, diff: { format: 'replacement', truncated: true } } } } });
  }
  const collected = parseZenTrace(records, 'fixture', '/synthetic/session.jsonl', new Date(5000)).session!;
  const collectedRaw = JSON.stringify(collected.messages.map(m => m.raw));
  expect(collectedRaw).toContain(before); expect(collectedRaw).toContain(after);
  expect(collected.messages.filter(m => m.kind === 'tool')).toHaveLength(0); // Dedicated tool lines are skipped; assistant arguments remain.
  const rows = collected.messages.map((message, i) => row(i + 1, message.raw, capturedChange(message.raw)));
  const events = archiveEvents(rows);
  expect(events.filter(e => e.change?.level === 'captured-hashes')).toHaveLength(2);
  expect(JSON.stringify(events)).not.toContain(before); expect(JSON.stringify(events)).not.toContain(after);
  const protectedSource = buildRedactor({ env: { FIXTURE_WRITE_SECRET: before, FIXTURE_EDIT_SECRET: after } }).deep(collected.messages);
  expect(JSON.stringify(protectedSource)).not.toContain(before); expect(JSON.stringify(protectedSource)).not.toContain(after);
});

it.each([['./notes/demo.md', 'notes/demo.md'], ['note.md', 'sub/note.md']])('pairs only explicit runtime-owned request binding for %s', (requested, observed) => {
  const root = '/srv/fixture-repo';
  const c = { ...change, path: observed!, worktree: createHash('sha256').update(root).digest('hex') };
  const call = { harness: 'zen-agent', type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: 'write_file', arguments: { path: requested } }] } };
  const binding = { path: requested, resolvedPath: `${root}/${observed}` };
  const result = raw({ details: { change: c, captureRequest: binding } });
  const events = archiveEvents([row(1, call), row(2, result, capturedChange(result))]);
  expect(events[1]?.parent).toBe(events[0]?.id); expect(events[1]?.change?.path).toBe(observed);
  expect(capturedRequestBinding(result)).toEqual({ present: true, request: binding });
  const legacy = raw({ details: { change: c, path: binding.resolvedPath } });
  expect(archiveEvents([row(1, call), row(2, legacy, capturedChange(legacy))])[1]?.parent).toBeUndefined(); // details.path alone is not a request binding.
  expect(JSON.stringify(events)).not.toContain('captureRequest'); expect(JSON.stringify(capturedChange(result))).not.toContain('resolvedPath');
  for (const captureRequest of [null, {}, { path: 'other.md', resolvedPath: binding.resolvedPath }, { ...binding, resolvedPath: `/srv/other/${observed}` }, { ...binding, resolvedPath: `${root}/other.md` }, { ...binding, resolvedPath: `${root}/sub/../${observed}` }]) {
    const bad = raw({ details: { change: c, captureRequest } });
    const rejected = archiveEvents([row(1, call), row(2, bad, capturedChange(bad))])[1]!;
    expect(rejected.parent).toBeUndefined(); expect(rejected.change).toBeUndefined(); expect(rejected.writeEvidence).toBeUndefined();
  }
});
it('does not fall back to legacy path matching for present-invalid capture request metadata', () => {
  const call = { harness: 'zen-agent', type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: 'write_file', arguments: { path: change.path } }] } };
  for (const captureRequest of [null, {}, { path: 'other.md', resolvedPath: '/srv/fixture-repo/notes/demo.md' }, { path: change.path, resolvedPath: 'relative.md' }]) {
    const result = raw({ details: { change, captureRequest } });
    expect(capturedRequestBinding(result).present).toBe(true);
    const event = archiveEvents([row(1, call), row(2, result, capturedChange(result))])[1]!;
    expect(event.parent).toBeUndefined(); expect(event.change).toBeUndefined(); expect(event.writeEvidence).toBeUndefined();
  }
  expect(capturedRequestBinding(raw())).toEqual({ present: false });
  expect(archiveEvents([row(1, call), row(2, raw(), capturedChange(raw()))])[1]?.change).toBeTruthy();
  const privateExtra = raw({ details: { change, captureRequest: { path: change.path, resolvedPath: '/srv/fixture-repo/notes/demo.md', body: 'PRIVATE EXTRA' } } });
  expect(JSON.stringify(capturedRequestBinding(privateExtra))).not.toContain('PRIVATE EXTRA');
});

it('revalidates current source request binding for lazy detail even when capture hashes and diff metadata match', async () => {
  const root = '/srv/fixture-repo';
  const c = { ...change, worktree: createHash('sha256').update(root).digest('hex') };
  const request = { path: './notes/demo.md', resolvedPath: `${root}/notes/demo.md` };
  const call = { harness: 'zen-agent', type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: 'write_file', arguments: { path: request.path } }] } };
  const result = raw({ details: { change: c, captureRequest: request } });
  const events = archiveEvents([row(1, call), row(2, result, capturedChange(result))], root);
  const event = events[1]!;
  expect(events[0]?.target).toEqual({ path: request.path, operation: 'write' });
  expect(event.target).toEqual({ path: request.path, operation: 'write', vaultPath: 'notes/demo.md' });
  expect(event.target).not.toBe(events[0]?.target); // The earlier call never gains future scope.
  const db = (source: unknown) => ({ query: async () => ({ rows: [{ raw: source }] }) }) as unknown as TxClient;
  expect(await changeDetail(db(result), event, new Set(['usage']))).toMatchObject({ diff: { after: 'PRIVATE CONTENT' } });
  for (const captureRequest of [null, {}, { ...request, path: 'other.md' }, { ...request, resolvedPath: '/srv/other/notes/demo.md' }, { ...request, resolvedPath: `${root}/other.md` }]) {
    const changed = raw({ details: { change: c, captureRequest } });
    expect(capturedChange(changed)).toEqual(event.change);
    await expect(changeDetail(db(changed), event, new Set(['usage']))).rejects.toHaveProperty('status', 409);
  }
  await expect(changeDetail(db(raw({ details: { change: c } })), event, new Set(['usage']))).rejects.toHaveProperty('status', 409);
  await expect(changeDetail(db({ ...result, message: { ...result.message, toolName: 'edit_file' } }), event, new Set(['usage']))).rejects.toHaveProperty('status', 409);
});
it('never uses request-only metadata without a valid capture to establish successful pairing', () => {
  const call = { harness: 'zen-agent', type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: 'write_file', arguments: { path: change.path } }] } };
  const result = raw({ details: { captureRequest: { path: change.path, resolvedPath: '/srv/fixture-repo/notes/demo.md' } } });
  const event = archiveEvents([row(1, call), row(2, result)])[1]!;
  expect(event.parent).toBeUndefined(); expect(event.writeEvidence).toBeUndefined(); expect(event.change).toBeUndefined();
});

it('retains legacy lazy detail for an exact target when the optional runtime request binding is absent', async () => {
  const root = '/srv/fixture-repo';
  const c = { ...change, worktree: createHash('sha256').update(root).digest('hex') };
  const call = { harness: 'zen-agent', type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: 'write_file', arguments: { path: c.path } }] } };
  const source = raw({ details: { change: c, captureRequest: { path: c.path, resolvedPath: `${root}/${c.path}` } } });
  const event = archiveEvents([row(1, call), row(2, source, capturedChange(source))])[1]!;
  const absent = raw({ details: { change: c } });
  const db = { query: async () => ({ rows: [{ raw: absent }] }) } as unknown as TxClient;
  expect(await changeDetail(db, event, new Set(['usage']))).toMatchObject({ diff: { after: 'PRIVATE CONTENT' } });
});
