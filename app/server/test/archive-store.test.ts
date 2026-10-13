import { describe, it, expect, beforeEach } from 'vitest';
import { query, withTransaction } from '../src/db.js';
import { sha256 } from '../src/archive/clean.js';
import * as store from '../src/archive/store.js';
import type { ParsedMessage, SessionInput } from '../src/archive/types.js';
import { truncateAll } from './helpers.js';

const session = (over: Partial<SessionInput> = {}): SessionInput => ({
  source: 'claude-code', host: 'mac', externalId: 'S1', parentExternalId: null, project: 'p', title: null, model: null,
  startedAt: null, endedAt: null, messageCount: null, inputTokens: null, outputTokens: null, costUsd: null,
  meta: {}, b2Path: 'archives/x', ...over,
});
const msg = (seq: number, text: string, ts = `2026-09-28T01:00:0${seq}.000Z`): ParsedMessage => ({
  seq, externalId: `u${seq}`, parentExternalId: null, role: 'user', kind: 'user', ts: new Date(ts),
  contentText: text, raw: { text }, rawSha: sha256(text), isSidechain: false,
});

describe('archive store', () => {
  beforeEach(truncateAll);

  it('upserts sessions and messages idempotently and computes stats', async () => {
    const first = await withTransaction(async (tx) => {
      const s = await store.upsertSession(tx, session());
      const n = await store.upsertMessages(tx, s.id, [msg(1, 'a'), msg(2, 'b')]);
      await store.refreshSessionStats(tx, s.id);
      return { s, n };
    });
    expect(first.n).toBe(2);
    const again = await withTransaction(async (tx) => {
      const s = await store.upsertSession(tx, session());
      return { s, n: await store.upsertMessages(tx, s.id, [msg(1, 'a'), msg(2, 'b')]) };
    });
    expect(again.s).toEqual({ id: first.s.id, changed: false });
    expect(again.n).toBe(0);
    const { rows } = await query(`SELECT message_count, started_at, ended_at FROM archive_sessions`);
    expect(rows[0]).toMatchObject({ message_count: 2 });
    expect((rows[0]!.ended_at as Date).toISOString()).toBe('2026-09-28T01:00:02.000Z');
  });

  it('updates a message whose raw changed', async () => {
    await withTransaction(async (tx) => {
      const s = await store.upsertSession(tx, session({ source: 'hermes', externalId: 'h' }));
      await store.upsertMessages(tx, s.id, [msg(1, 'a')]);
      expect(await store.upsertMessages(tx, s.id, [msg(1, 'a2')])).toBe(1);
    });
    const { rows } = await query(`SELECT content_text FROM archive_messages`);
    expect(rows[0]!.content_text).toBe('a2');
  });

  it('keeps title when a later chunk has none', async () => {
    await withTransaction(async (tx) => {
      await store.upsertSession(tx, session({ title: 'T', model: 'm' }));
      await store.upsertSession(tx, session());
    });
    const { rows } = await query(`SELECT title, model FROM archive_sessions`);
    expect(rows[0]).toMatchObject({ title: 'T', model: 'm' });
  });

  it('stores dirty strings', async () => {
    const { clean } = await import('../src/archive/clean.js');
    const dirty = clean('x\u0000\ud800');
    await withTransaction(async (tx) => {
      const s = await store.upsertSession(tx, session());
      await store.upsertMessages(tx, s.id, [{ ...msg(1, dirty), raw: clean({ t: 'x\u0000\ud800' }) }]);
    });
    const { rows } = await query(`SELECT count(*)::int n FROM archive_messages`);
    expect(rows[0]!.n).toBe(1);
  });

  it('inserts log lines once and memory versions per content', async () => {
    const lines = [{ byteOffset: 0, ts: null, level: 'INFO', message: 'a' }];
    const n1 = await withTransaction((tx) => store.insertLogLines(tx, 'mac', 'agent.log', 'fp', lines));
    const n2 = await withTransaction((tx) => store.insertLogLines(tx, 'mac', 'agent.log', 'fp', lines));
    expect([n1, n2]).toEqual([1, 0]);
    expect(await store.recordMemoryVersion(null, 'hermes-memory', 'mac', 'MEMORY.md', 'v1')).toBe(true);
    expect(await store.recordMemoryVersion(null, 'hermes-memory', 'mac', 'MEMORY.md', 'v1')).toBe(false);
    expect(await store.recordMemoryVersion(null, 'hermes-memory', 'mac', 'MEMORY.md', 'v2')).toBe(true);
  });

  it('tracks file state, uploads and ingest offsets', async () => {
    const f = { source: 'claude-code', host: 'mac' as const, localPath: '/a.jsonl', sizeBytes: 10, mtimeMs: 1,
      sha256: 'h', fingerprint: 'fp', b2Path: 'archives/a.jsonl.gz', staged: true };
    await store.saveFileState(null, f);
    const pending = await store.pendingUploads();
    expect(pending.map((p) => p.localPath)).toEqual(['/a.jsonl']);
    await store.markUploaded(pending.map((p) => p.id));
    expect(await store.pendingUploads()).toEqual([]);
    await withTransaction((tx) => store.markIngested(tx, pending[0]!.id, 10, 3, 'fp'));
    const row = await store.getFile('claude-code', 'mac', '/a.jsonl');
    expect(row).toMatchObject({ uploadedSize: 10, ingestedBytes: 10, ingestedLines: 3, b2Path: 'archives/a.jsonl.gz' });
  });

  it('dedupes duplicate external ids within one batch (last wins)', async () => {
    const n = await withTransaction(async (tx) => {
      const s = await store.upsertSession(tx, session());
      return store.upsertMessages(tx, s.id, [msg(1, 'a'), { ...msg(2, 'b'), externalId: 'u1' }]);
    });
    expect(n).toBe(1);
    const r = await query(`SELECT content_text FROM archive_messages WHERE external_id='u1'`);
    expect(r.rows[0]!.content_text).toBe('b');
  });
});
