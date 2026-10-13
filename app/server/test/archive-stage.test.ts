import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import * as stage from '../src/archive/stage.js';
import type { FileRow } from '../src/archive/store.js';

const dir = () => mkdtempSync(join(tmpdir(), 'stage-'));
const row = (o: Partial<FileRow>): FileRow => ({ id: 1, source: 'claude-code', host: 'mac', localPath: '/x', sizeBytes: 5,
  mtimeMs: 1, sha256: 'h', fingerprint: null, b2Path: null, uploadedAt: new Date(), uploadedSize: 5,
  ingestedBytes: 0, ingestedLines: 0, ...o });

describe('stage', () => {
  it('computes state and skips re-hash when size+mtime match', () => {
    const p = join(dir(), 'a.jsonl'); writeFileSync(p, 'hello'); utimesSync(p, 1, 1);
    const st = stage.fileState(p, null);
    expect(st.sizeBytes).toBe(5);
    expect(st.sha256).toHaveLength(64);
    const reused = stage.fileState(p, row({ sizeBytes: 5, mtimeMs: st.mtimeMs, sha256: 'cached' }));
    expect(reused.sha256).toBe('cached');
  });

  it('keeps the fingerprint stable when a file is appended to', () => {
    const p = join(dir(), 'agent.log'); writeFileSync(p, 'first line\n');
    const before = stage.fileState(p, null).fingerprint;
    writeFileSync(p, 'first line\nsecond line\n');
    expect(stage.fileState(p, null).fingerprint).toBe(before);
    writeFileSync(p, 'rotated\n');
    expect(stage.fileState(p, null).fingerprint).not.toBe(before);
  });

  it('decides uploads', () => {
    const st = { sizeBytes: 5, mtimeMs: 1, sha256: 'h', fingerprint: 'f' };
    expect(stage.needsUpload(null, st)).toBe(true);
    expect(stage.needsUpload(row({}), st)).toBe(false);
    expect(stage.needsUpload(row({ sha256: 'old' }), st)).toBe(true);
    expect(stage.needsUpload(row({ uploadedAt: null }), st)).toBe(true);
  });

  it('builds Claude paths for sessions and subagents', () => {
    const ts = new Date('2026-09-28T23:59:00Z');
    expect(stage.claudeB2Path('-Users-k-secondbrain', 'abc.jsonl', ts, new Date()))
      .toBe('archives/claude-code/-Users-k-secondbrain/2026-09-28_abc.jsonl.gz');
    expect(stage.claudeB2Path('-Users-k-secondbrain', 'abc/subagents/agent-1.meta.json', ts, new Date()))
      .toBe('archives/claude-code/-Users-k-secondbrain/2026-09-28_abc/subagents/agent-1.meta.json.gz');
  });

  it('shrink guard: never replaces a bigger upload', () => {
    const st = { sizeBytes: 3, mtimeMs: 2, sha256: 'n', fingerprint: 'f' };
    const prev = row({ b2Path: 'archives/claude-code/p/2026-09-28_abc.jsonl.gz', uploadedSize: 5 });
    expect(stage.resolveB2Path(prev, st, 'ignored', '20260930T010203Z'))
      .toBe('archives/claude-code/p/2026-09-28_abc.truncated-20260930T010203Z.jsonl.gz');
    expect(stage.resolveB2Path(row({ b2Path: 'archives/k.jsonl.gz' }), { ...st, sizeBytes: 9 }, 'ignored', 's'))
      .toBe('archives/k.jsonl.gz');
    expect(stage.resolveB2Path(null, st, 'archives/new.gz', 's')).toBe('archives/new.gz');
  });

  it('finds the first timestamp and stages gzip to the outbox', () => {
    const d = dir(); const p = join(d, 's.jsonl');
    writeFileSync(p, '{"type":"mode"}\n{"type":"user","timestamp":"2026-09-27T10:00:00.000Z"}\n');
    expect(stage.firstTimestamp(p)?.toISOString()).toBe('2026-09-27T10:00:00.000Z');
    const out = join(d, 'outbox');
    stage.stageToOutbox(out, p, 'archives/claude-code/p/s.jsonl.gz');
    expect(gunzipSync(readFileSync(join(out, 'archives/claude-code/p/s.jsonl.gz'))).toString()).toContain('"mode"');
    expect(stage.utcStamp(new Date('2026-09-30T01:02:03Z'))).toBe('20260930T010203Z');
    expect(stage.utcDate(new Date('2026-09-30T01:02:03Z'))).toBe('2026-09-30');
  });

  it('restaging identical content leaves the outbox file untouched', () => {
    const d = dir(); const p = join(d, 's.jsonl'); writeFileSync(p, 'abc\n');
    utimesSync(p, 1_700_000_000, 1_700_000_000);
    const out = join(d, 'outbox'); const key = 'archives/x/s.jsonl.gz';
    stage.stageToOutbox(out, p, key);
    const dest = join(out, key);
    expect(Math.floor(statSync(dest).mtimeMs)).toBe(Math.floor(statSync(p).mtimeMs));
    utimesSync(dest, 1_700_000_000, 1_700_000_000); // already equal; a rewrite would bump it to now
    const before = statSync(dest).mtimeMs;
    stage.stageToOutbox(out, p, key);
    expect(statSync(dest).mtimeMs).toBe(before);
    writeFileSync(p, 'abcd\n'); utimesSync(p, 1_700_000_100, 1_700_000_100);
    stage.stageToOutbox(out, p, key);
    expect(gunzipSync(readFileSync(dest)).toString()).toBe('abcd\n');
  });
});
