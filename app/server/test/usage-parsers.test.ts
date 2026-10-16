import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { readHermesCounters } from '../src/usage/hermesCounters.js';
import { parseRunLog } from '../src/usage/runLog.js';
import { parseStatuslineLog } from '../src/usage/statusline.js';

const MTIME = new Date('2026-10-13T10:05:00Z');
const rateLimit = {
  type: 'rate_limit_event',
  rate_limit_info: { status: 'allowed', unifiedWindows: {
    five_hour: { utilization: 0.14, resetsAt: 1791879600 }, seven_day: { utilization: 0.07, resetsAt: 1792339200 } } },
};
const result = (sid: string, ms: number) => ({
  type: 'result', subtype: 'success', is_error: false, session_id: sid, duration_ms: ms, duration_api_ms: ms - 1000,
  num_turns: 34, total_cost_usd: 0.9368654, usage: { input_tokens: 28, output_tokens: 14598 },
  modelUsage: { 'claude-opus-5-5': { inputTokens: 28 } }, result: 'done',
});

describe('parseRunLog', () => {
  it('reads a dispatched run with its verify outcome and plan readings', () => {
    const { runs, plan } = parseRunLog([
      { type: 'cc_dispatch', task_id: 't_0da7a198', board: 'exo', lane: 'cc-research', model: 'opus', at: '2026-10-13T10:00:00Z' },
      { type: 'system', subtype: 'init', session_id: 'ab56', model: 'claude-opus-5-5' },
      rateLimit,
      result('ab56', 183000),
      { type: 'cc_verify', task_id: 't_0da7a198', lane: 'cc-research', name: 'note-lint', passed: false, exit_code: 1,
        metric: 3, output: '3 problems', at: '2026-10-13T10:03:10Z' },
    ], 'droplet', '/home/agent/cc-runs/t_0da7a198.jsonl', MTIME);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      sessionId: 'ab56', taskId: 't_0da7a198', board: 'exo', lane: 'cc-research', model: 'claude-opus-5-5',
      durationMs: 183000, numTurns: 34, subtype: 'success', isError: false, totalCostUsd: 0.9368654,
      verify: { name: 'note-lint', passed: false, exitCode: 1, metric: 3, output: '3 problems' },
    });
    expect(runs[0]!.startedAt!.toISOString()).toBe('2026-10-13T10:00:00.000Z');
    expect(runs[0]!.endedAt!.toISOString()).toBe('2026-10-13T10:03:03.000Z');
    expect(plan.map((p) => [p.window, p.usedPct, p.origin])).toEqual([
      ['five_hour', 14, 'stream-json'], ['seven_day', 7, 'stream-json']]);
    expect(plan[0]!.observedAt.toISOString()).toBe('2026-10-13T10:00:00.000Z');
    expect(plan[0]!.resetsAt!.getTime()).toBe(1791879600 * 1000);
  });

  it('handles a log without dispatcher lines (older runs) and a retried task with two runs', () => {
    const { runs } = parseRunLog([result('s1', 60000), result('s2', 30000)], 'droplet', '/runs/t_1.jsonl', MTIME);
    expect(runs.map((r) => [r.sessionId, r.taskId, r.runId])).toEqual([['s1', 't_1', 't_1#1'], ['s2', 't_1', 't_1#2']]);
    expect(runs[1]!.endedAt!.toISOString()).toBe(MTIME.toISOString());
    expect(runs[1]!.startedAt!.toISOString()).toBe('2026-10-13T10:04:30.000Z');
  });

  it('reads a bot\'s wake from its header: run id, agent, team, reasons, wakeup ids, card, resumed', () => {
    const { runs } = parseRunLog([
      { type: 'cc_dispatch', run_id: 'org-atlas-20261016-054937', agent: 'atlas', team: 'platform', work: 'coding',
        reasons: [{ reason: 'mention', ref: '62' }, { reason: 'task', ref: 't_bae7a68a' }], wakeup_ids: [311, 314],
        task_id: 't_bae7a68a', board: 'exo', model: 'opus', resumed: true, at: '2026-10-16T05:49:37Z' },
      { type: 'system', subtype: 'init', session_id: 'sess-atlas', model: 'claude-opus-5-5' },
      result('sess-atlas', 90000),
    ], 'droplet', '/home/agent/cc-runs/org-atlas-20261016-054937.jsonl', MTIME);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      runId: 'org-atlas-20261016-054937', agentName: 'atlas', teamSlug: 'platform', workType: 'coding', taskId: 't_bae7a68a', board: 'exo',
      lane: null, resumed: true, wakeupIds: [311, 314], reasons: [{ reason: 'mention', ref: '62' }, { reason: 'task', ref: 't_bae7a68a' }],
      sessionId: 'sess-atlas', model: 'claude-opus-5-5',
    });
    expect(runs[0]!.startedAt!.toISOString()).toBe('2026-10-16T05:49:37.000Z');
    expect(runs[0]!.endedAt!.toISOString()).toBe('2026-10-16T05:51:07.000Z');
  });

  it('names an older headerless bot log from its file name, with no card and the mtime for its end', () => {
    const { runs } = parseRunLog([result('sess-vega', 60000)], 'droplet', '/home/agent/cc-runs/org-vega-20261015-180945.jsonl', MTIME);
    expect(runs[0]).toMatchObject({ runId: 'org-vega-20261015-180945', agentName: 'vega', taskId: null, reasons: [], wakeupIds: [], resumed: null });
    expect(runs[0]!.endedAt!.toISOString()).toBe(MTIME.toISOString());
  });

  it('never emits an Invalid Date: an out-of-range resetsAt becomes null, an invalid observedAt skips the reading', () => {
    const huge = { type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.2, resetsAt: 1e20 } } } };
    const { plan } = parseRunLog([
      { type: 'cc_dispatch', task_id: 't_2', at: '2026-10-13T10:00:00Z' }, huge,
    ], 'droplet', '/runs/t_2.jsonl', MTIME);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.resetsAt).toBeNull();
    expect(plan[0]!.observedAt.toISOString()).toBe('2026-10-13T10:00:00.000Z');

    const bad = parseRunLog([rateLimit, result('s3', 1e20)], 'droplet', '/runs/t_3.jsonl', new Date(NaN));
    expect(bad.plan).toEqual([]);
    expect(bad.runs).toHaveLength(1);
    expect(bad.runs[0]!.startedAt).toBeNull();
    expect(bad.runs[0]!.endedAt).toBeNull();

    const long = parseRunLog([{ type: 'cc_dispatch', task_id: 't_4', at: '2026-10-13T10:00:00Z' }, result('s4', 1e20)],
      'droplet', '/runs/t_4.jsonl', MTIME);
    expect(long.runs[0]!.endedAt).toBeNull();
    expect(long.runs[0]!.startedAt!.toISOString()).toBe('2026-10-13T10:00:00.000Z');
  });
});

describe('parseStatuslineLog', () => {
  it('turns status-line readings into plan snapshots and skips lines without rate limits', () => {
    const snaps = parseStatuslineLog([
      { at: '2026-10-14T01:00:00Z', rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1791900000 },
        seven_day: { used_percentage: 41.2, resets_at: 1792339200 } } },
      { at: '2026-10-14T01:01:00Z' },
    ], 'mac');
    expect(snaps.map((p) => [p.window, p.usedPct, p.origin, p.host])).toEqual([
      ['five_hour', 23.5, 'statusline', 'mac'], ['seven_day', 41.2, 'statusline', 'mac']]);
  });

  it('treats an out-of-range or non-finite resets_at as unknown instead of an Invalid Date', () => {
    const snaps = parseStatuslineLog([
      { at: '2026-10-14T01:00:00Z', rate_limits: { five_hour: { used_percentage: 10, resets_at: 1e20 },
        seven_day: { used_percentage: 20, resets_at: Number.NaN } } },
      { at: '+999999-01-01T00:00:00Z', rate_limits: { five_hour: { used_percentage: 30, resets_at: 1791900000 } } },
    ], 'mac');
    expect(snaps.map((p) => [p.window, p.usedPct, p.resetsAt])).toEqual([['five_hour', 10, null], ['seven_day', 20, null]]);
  });
});

describe('readHermesCounters', () => {
  it('reads running totals and tolerates missing columns', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'hc-')), 'state.db');
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, model TEXT, started_at REAL, ended_at REAL,
               input_tokens INTEGER, output_tokens INTEGER, api_call_count INTEGER, estimated_cost_usd REAL)`);
    db.prepare(`INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?)`).run('h1', 'gpt-x', 1791700000, null, 1200, 300, 4, 0.02);
    db.close();
    expect(readHermesCounters(path, 'droplet', 'main')).toEqual([{
      host: 'droplet', profile: 'main', sessionId: 'h1', model: 'gpt-x', billingProvider: null,
      startedAt: new Date(1791700000 * 1000), endedAt: null, inputTokens: 1200, outputTokens: 300,
      cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, apiCalls: 4, costUsd: 0.02,
    }]);
  });
});
