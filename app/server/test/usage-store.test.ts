import { beforeEach, describe, expect, it } from 'vitest';
import { query, withTransaction } from '../src/db.js';
import * as store from '../src/usage/store.js';
import type { HermesCounters, UsageCall } from '../src/usage/types.js';
import { truncateAll } from './helpers.js';

const call = (over: Partial<UsageCall> = {}): UsageCall => ({
  source: 'claude-code', host: 'mac', callId: 'msg_1', requestId: 'req_1', sessionExternalId: 's1',
  messageExternalId: 'a1', ts: new Date('2026-10-13T09:58:06Z'), model: 'claude-opus-5-5', entrypoint: 'cli',
  cwd: '/vault', isSidechain: false, inputTokens: 2, cacheWriteTokens: 10, cacheReadTokens: 20, outputTokens: 100,
  thinkingTokens: 0, webSearchRequests: 0, ...over,
});
const hermes = (input: number, ended: Date | null = null): HermesCounters => ({
  host: 'droplet', profile: 'main', sessionId: 'h1', model: 'gpt-x', billingProvider: 'openrouter',
  startedAt: new Date('2026-10-12T00:00:00Z'), endedAt: ended, inputTokens: input, outputTokens: 1, cacheReadTokens: 0,
  cacheWriteTokens: 0, reasoningTokens: 0, apiCalls: 1, costUsd: null,
});

beforeEach(truncateAll);

describe('usage store', () => {
  it('counts a call copied into a second transcript once, and grows output when a later pass sees more', async () => {
    await withTransaction((tx) => store.upsertCalls(tx, [call()]));
    await withTransaction((tx) => store.upsertCalls(tx, [call({ sessionExternalId: 'forked', messageExternalId: 'b9' })]));
    await withTransaction((tx) => store.upsertCalls(tx, [call({ outputTokens: 296, messageExternalId: 'a2' })]));
    const { rows } = await query(`SELECT session_external_id, message_external_id, output_tokens FROM usage_calls`);
    expect(rows).toEqual([{ session_external_id: 's1', message_external_id: 'a2', output_tokens: 296 }]);
  });

  it('writes a Hermes snapshot only when the totals change, timed at the end of an already-finished session', async () => {
    const t1 = new Date('2026-10-14T00:00:00Z');
    const ended = new Date('2026-10-12T05:00:00Z');
    expect(await withTransaction((tx) => store.recordHermesCounters(tx, [hermes(100, ended)], t1))).toBe(1);
    expect(await withTransaction((tx) => store.recordHermesCounters(tx, [hermes(100, ended)], new Date('2026-10-14T00:10:00Z')))).toBe(0);
    expect(await withTransaction((tx) => store.recordHermesCounters(tx, [hermes(150, ended)], new Date('2026-10-14T00:20:00Z')))).toBe(1);
    const { rows } = await query<{ observed_at: Date; input_tokens: number }>(
      `SELECT observed_at, input_tokens FROM hermes_usage_snapshots ORDER BY observed_at`);
    expect(rows.map((r) => [r.observed_at.toISOString(), r.input_tokens])).toEqual([
      ['2026-10-12T05:00:00.000Z', 100], ['2026-10-14T00:20:00.000Z', 150]]);
  });

  it('keeps plan readings idempotent and saves cursors', async () => {
    const snap = { host: 'mac' as const, origin: 'statusline' as const, window: 'five_hour' as const, usedPct: 23.5,
      resetsAt: null, observedAt: new Date('2026-10-14T01:00:00Z') };
    await withTransaction((tx) => store.insertPlanSnapshots(tx, [snap, snap]));
    expect((await query(`SELECT 1 FROM plan_usage_snapshots`)).rowCount).toBe(1);
    await withTransaction((tx) => store.saveCursor(tx, 'droplet', '/p.jsonl', { fingerprint: 'f', offsetBytes: 10, lines: 2, sizeBytes: 10 }));
    expect(await store.getCursor('droplet', '/p.jsonl')).toEqual({ fingerprint: 'f', offsetBytes: 10, lines: 2, sizeBytes: 10 });
  });

  it('in one batch, keeps the higher outputTokens and first sessionExternalId when same callId appears twice', async () => {
    const longer = call({ outputTokens: 296, ts: new Date('2026-10-13T09:58:00Z') });
    const shorter = call({ outputTokens: 100, sessionExternalId: 'other', ts: new Date('2026-10-13T09:59:00Z') });
    await withTransaction((tx) => store.upsertCalls(tx, [longer, shorter]));
    const { rows } = await query(`SELECT session_external_id, output_tokens, ts FROM usage_calls`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      session_external_id: 's1',
      output_tokens: 296,
      ts: new Date('2026-10-13T09:58:00Z'),
    });
  });
});
