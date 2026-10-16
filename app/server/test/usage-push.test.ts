import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { query } from '../src/db.js';
import { importLines } from '../src/usage/importer.js';
import { buildPush, type PushCursor } from '../src/usage/push.js';
import { truncateAll } from './helpers.js';

const rec = (uuid: string, id: string, ts: string) => JSON.stringify({
  type: 'assistant', uuid, timestamp: ts, sessionId: 'm1', entrypoint: 'cli',
  message: { id, model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 9 } },
}) + '\n';

const failStore = vi.hoisted(() => ({ on: false }));
vi.mock('../src/usage/store.js', async (orig) => {
  const real = await orig<typeof import('../src/usage/store.js')>();
  return { ...real, insertPlanSnapshots: (...a: Parameters<typeof real.insertPlanSnapshots>) => {
    if (failStore.on) return Promise.reject(new Error('connection refused'));
    return real.insertPlanSnapshots(...a);
  } };
});

let dir: string;
let planLog: string;
beforeEach(async () => {
  await truncateAll();
  dir = mkdtempSync(join(tmpdir(), 'push-'));
  mkdirSync(join(dir, 'proj'));
  writeFileSync(join(dir, 'proj', 'm1.jsonl'), rec('a1', 'msg_a', '2026-10-14T01:00:00Z'));
  planLog = join(dir, 'plan.ndjson');
  writeFileSync(planLog, JSON.stringify({ at: '2026-10-14T01:00:00Z', rate_limits: { seven_day: { used_percentage: 40, resets_at: 1792339200 } } }) + '\n');
});

describe('push and import', () => {
  it('round-trips transcripts and plan readings, then sends only new bytes', async () => {
    const first = buildPush({ claudeProjectsDir: dir, planLog, maxBytes: 1_000_000 }, { files: {} });
    const counts = await importLines(first.lines, 'mac');
    expect(counts).toMatchObject({ calls: 1, plan: 1 });

    appendFileSync(join(dir, 'proj', 'm1.jsonl'), rec('a2', 'msg_b', '2026-10-14T01:05:00Z'));
    const second = buildPush({ claudeProjectsDir: dir, planLog, maxBytes: 1_000_000 }, first.next);
    expect(second.lines).toHaveLength(1);
    await importLines(second.lines, 'mac');
    expect((await query(`SELECT count(*)::int n FROM usage_calls WHERE host='mac'`)).rows[0]!.n).toBe(2);
  });

  it('resending a push whose cursor was never saved (SSH failed) does not double count', async () => {
    const cursor: PushCursor = { files: {} };
    const push = buildPush({ claudeProjectsDir: dir, planLog, maxBytes: 1_000_000 }, cursor);
    await importLines(push.lines.slice(0, 1), 'mac');          // the connection died after one line
    await importLines(buildPush({ claudeProjectsDir: dir, planLog, maxBytes: 1_000_000 }, cursor).lines, 'mac');
    expect((await query(`SELECT count(*)::int n FROM usage_calls`)).rows[0]!.n).toBe(1);
    expect((await query(`SELECT count(*)::int n FROM plan_usage_snapshots`)).rows[0]!.n).toBe(1);
  });

  it('does not throw on a plan reading whose resets_at is out of Date range', async () => {
    appendFileSync(planLog, JSON.stringify({ at: '2026-10-14T01:05:00Z', rate_limits: { five_hour: { used_percentage: 12, resets_at: 1e20 } } }) + '\n');
    const push = buildPush({ claudeProjectsDir: dir, planLog, maxBytes: 1_000_000 }, { files: {} });
    const counts = await importLines(push.lines, 'mac');
    expect(counts).toMatchObject({ plan: 2 });
    expect((await query(`SELECT resets_at FROM plan_usage_snapshots WHERE "window"='five_hour'`)).rows).toEqual([{ resets_at: null }]);
  });

  it('stops at maxBytes and leaves the rest for the next push', () => {
    writeFileSync(join(dir, 'proj', 'm2.jsonl'), rec('b1', 'msg_c', '2026-10-14T02:00:00Z'));
    const small = buildPush({ claudeProjectsDir: dir, planLog: null, maxBytes: 10 }, { files: {} });
    expect(small.lines).toHaveLength(1);
    expect(Object.keys(small.next.files)).toHaveLength(1);
  });

  it('rejects a malformed line without stopping the rest', async () => {
    const good = buildPush({ claudeProjectsDir: dir, planLog: null, maxBytes: 1_000_000 }, { files: {} }).lines;
    const counts = await importLines(['{"t":"nope"}', 'not json', ...good], 'mac');
    expect(counts.errors).toHaveLength(2);
    expect(counts.calls).toBe(1);
  });

  it('a database failure rejects instead of being counted as a bad line', async () => {
    const lines = buildPush({ claudeProjectsDir: dir, planLog, maxBytes: 1_000_000 }, { files: {} }).lines;
    failStore.on = true;
    try {
      await expect(importLines(lines, 'mac')).rejects.toThrow('connection refused');
    } finally {
      failStore.on = false;
    }
  });

  it('caps one big file at maxBytes on a line boundary and resumes mid-file', async () => {
    const big = join(dir, 'big');
    mkdirSync(big);
    const one = rec('c1', 'msg_1', '2026-10-14T03:00:00Z');
    const body = one + rec('c2', 'msg_2', '2026-10-14T03:01:00Z') + rec('c3', 'msg_3', '2026-10-14T03:02:00Z');
    writeFileSync(join(big, 'big.jsonl'), body);
    const input = { claudeProjectsDir: big, planLog: null, maxBytes: Buffer.byteLength(one) + 5 };
    const first = buildPush(input, { files: {} });
    const sent = first.lines.map((l) => JSON.parse(l).text as string).join('');
    expect(sent.endsWith('\n')).toBe(true);
    expect(sent.length).toBeLessThan(body.length);
    await importLines(first.lines, 'mac');
    let cursor = first.next;
    for (let i = 0; i < 5; i++) {
      const n = buildPush(input, cursor);
      if (!n.lines.length) break;
      await importLines(n.lines, 'mac');
      cursor = n.next;
    }
    expect((await query(`SELECT count(*)::int n FROM usage_calls WHERE call_id IN ('msg_1','msg_2','msg_3')`)).rows[0]!.n).toBe(3);
  });
});
