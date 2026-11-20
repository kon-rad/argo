import { describe, expect, it } from 'vitest';
import { capturedChange } from '../src/archive/changeEvidence.js';
import { archiveEvents, makeWindow, type ArchiveRow } from '../src/addons/observatory/adapters.js';
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
