import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { expandSteps, stepFields } from '../src/archive/steps.js';
import { query, withTransaction } from '../src/db.js';
import { classifyZenAction } from '../src/usage/actions.js';
import { splitJsonLines } from '../src/usage/lines.js';
import * as store from '../src/usage/store.js';
import { syncUsage } from '../src/usage/sync.js';
import { parseZenTrace } from '../src/usage/zenTrace.js';
import { ALL_MODULES, truncateAll } from './helpers.js';

// A zen-agent run's trace (docs/zen-runtime.md, section 7) into the ledger and the archive.
const FIXTURE = join(import.meta.dirname, 'fixtures', 'zen-trace.jsonl');
const MTIME = new Date('2026-10-24T09:15:15Z');
const records = () => splitJsonLines(readFileSync(FIXTURE)).records;

describe('parseZenTrace', () => {
  it('builds the run from the meta and end lines, with the dispatcher\'s labels', () => {
    const { run } = parseZenTrace(records(), 'droplet', '/srv/vault/.zen/sessions/bolt-20261024-091500-k3j2.jsonl', MTIME);
    expect(run).toMatchObject({
      host: 'droplet', runId: 'bolt-20261024-091500', sessionId: 'bolt-20261024-091500-k3j2', agentName: 'bolt', teamSlug: 'platform',
      workType: 'coding', reasons: [{ reason: 'task', ref: 't_3f9a12' }], wakeupIds: [41, 42], resumed: false,
      taskId: 't_3f9a12', board: 'exo', lane: null, model: 'openrouter/deepseek/deepseek-v4.1-flash',
      numTurns: 3, subtype: 'done', isError: false, totalCostUsd: 0.0002798, runtime: 'zen-agent', tier: 'flash-low',
      compactions: 1, blocked: 1, durationMs: 14500,
    });
    expect(run!.startedAt?.toISOString()).toBe('2026-10-24T09:15:00.000Z');
    expect(run!.endedAt?.toISOString()).toBe('2026-10-24T09:15:14.500Z');
    expect((run!.parts as { name: string }[]).map((p) => p.name)).toEqual(['identity', 'rules', 'task']);
  });

  it('makes one priced call per assistant message, classified by its first tool', () => {
    const { calls } = parseZenTrace(records(), 'droplet', '/x.jsonl', MTIME);
    expect(calls.map((c) => [c.callId, c.tool, c.action, c.inputTokens, c.cacheReadTokens, c.outputTokens, c.costUsd, c.provider, c.model])).toEqual([
      ['bolt-20261024-091500-k3j2:3', 'read_file', 'read', 3100, 0, 40, 0.0001115, 'openrouter', 'deepseek/deepseek-v4.1-flash'],
      ['bolt-20261024-091500-k3j2:6', 'bash', 'post', 3300, 3000, 60, 0.0001232, 'openrouter', 'deepseek/deepseek-v4.1-flash'],
      ['bolt-20261024-091500-k3j2:10', null, 'reply', 1200, 0, 30, 0.0000451, 'openrouter', 'deepseek/deepseek-v4.1-flash'],
    ]);
    expect(calls.every((c) => c.source === 'zen-agent' && c.sessionExternalId === 'bolt-20261024-091500-k3j2' && c.entrypoint === 'zen-agent')).toBe(true);
    expect(calls[0]!.ts.toISOString()).toBe('2026-10-24T09:15:04.000Z');
  });

  it('archives messages, blocks and compactions with steps the page understands, and skips tool lines', () => {
    const { session } = parseZenTrace(records(), 'droplet', '/x.jsonl', MTIME);
    expect(session!.input).toMatchObject({ source: 'zen-agent', externalId: 'bolt-20261024-091500-k3j2', title: 'You were woken for card t_3f9a12. One card, one run.',
      model: 'openrouter/deepseek/deepseek-v4.1-flash', inputTokens: 10600, outputTokens: 130, costUsd: 0.0002798 });
    expect((session!.input.meta as { dispatch: { tier: string } }).dispatch.tier).toBe('flash-low');
    const rows = session!.messages.map((m) => [m.kind, m.role, stepFields(m.raw).step]);
    expect(rows).toEqual([
      ['meta', 'meta', 'meta'], ['message', 'user', 'prompt'], ['message', 'assistant', 'tool_call'], ['message', 'tool', 'tool_result'],
      ['message', 'assistant', 'tool_call'], ['blocked', 'meta', 'system'], ['message', 'tool', 'tool_result'], ['compaction', 'meta', 'system'],
      ['message', 'assistant', 'response'], ['end', 'meta', 'meta'],
    ]);
    const first = session!.messages[2]!;
    expect(stepFields(first.raw)).toEqual({ step: 'tool_call', toolNames: ['read_file'], toolCallId: 'call_1', isError: null });
    expect(expandSteps({ id: 1, role: first.role, kind: first.kind, ts: null, raw: first.raw, text: first.contentText }).map((p) => [p.step, p.toolName])).toEqual([
      ['thinking', null], ['tool_call', 'read_file']]);
    const failed = session!.messages[6]!;
    expect(stepFields(failed.raw)).toEqual({ step: 'tool_result', toolNames: ['bash'], toolCallId: 'call_2', isError: true });
    expect(session!.messages[1]!.contentText).toBe('You were woken for card t_3f9a12. One card, one run.');
    expect(session!.messages[5]!.contentText).toMatch(/^bash blocked: guard/);
  });

  it('is not a trace without a meta line, uses the meta id without a dispatch run id, and refuses a newer version', () => {
    expect(parseZenTrace([{ type: 'message' }], 'mac', '/x.jsonl', MTIME)).toEqual({ run: null, calls: [], session: null });
    const bare = [{ type: 'meta', id: 'zen-1', at: '2026-10-24T09:00:00Z', model: 'ollama/qwen3:8b', parts: [] }];
    const { run } = parseZenTrace(bare, 'mac', '/x.jsonl', MTIME);
    expect(run).toMatchObject({ runId: 'zen-1', agentName: null, endedAt: null, numTurns: null, subtype: null, reasons: [], wakeupIds: [], runtime: 'zen-agent' });
    expect(() => parseZenTrace([{ type: 'meta', id: 'z', version: 9 }], 'mac', '/x.jsonl', MTIME)).toThrow(/version 9/);
  });

  it('maps zen tool names to the ledger\'s actions', () => {
    expect(classifyZenAction('org_dm', {})).toBe('dm');
    expect(classifyZenAction('org_handoff', {})).toBe('post');
    expect(classifyZenAction('org_task_create', {})).toBe('ticket');
    expect(classifyZenAction('card_complete', {})).toBe('card');
    expect(classifyZenAction('edit_file', {})).toBe('write');
    expect(classifyZenAction('search_notes', {})).toBe('read');
    expect(classifyZenAction('bash', { command: 'ORG_AGENT=bolt cli-org dm atlas "hi"' })).toBe('dm');
    expect(classifyZenAction('bash', { command: 'npm test' })).toBe('shell');
    expect(classifyZenAction('delegate', {})).toBe('shell');
    expect(classifyZenAction(null, undefined)).toBe('reply');
  });
});

describe('syncUsage over a zen sessions dir', () => {
  let root: string;
  beforeEach(async () => {
    await truncateAll();
    root = mkdtempSync(join(tmpdir(), 'zen-usage-'));
    mkdirSync(join(root, 'sessions'));
  });
  const paths = () => ({ claudeProjectsDir: join(root, 'none'), runsDir: null, statuslineLog: null, zenSessionsDir: join(root, 'sessions') });

  it('loads a live trace twice: the run row first without an end, then finished, with its calls attached and archived', async () => {
    const lines = readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean);
    const file = join(root, 'sessions', 'bolt-20261024-091500-k3j2.jsonl');
    writeFileSync(file, lines.slice(0, 4).join('\n') + '\n');
    let c = await syncUsage(paths(), 'droplet');
    expect(c).toMatchObject({ files: 1, runs: 1, calls: 1, sessions: 1, errors: [] });
    let run = await query(`SELECT run_id, runtime, ended_at, num_turns, total_cost_usd, tier FROM usage_runs`);
    expect(run.rows).toEqual([{ run_id: 'bolt-20261024-091500', runtime: 'zen-agent', ended_at: null, num_turns: null, total_cost_usd: null, tier: 'flash-low' }]);

    writeFileSync(file, lines.join('\n') + '\n');
    c = await syncUsage(paths(), 'droplet');
    expect(c).toMatchObject({ files: 1, runs: 1, calls: 2, errors: [] });
    run = await query(`SELECT ended_at, num_turns, total_cost_usd, compactions, blocked FROM usage_runs`);
    expect(run.rows[0]).toMatchObject({ num_turns: 3, total_cost_usd: 0.0002798, compactions: 1, blocked: 1 });
    expect((run.rows[0] as { ended_at: Date }).ended_at.toISOString()).toBe('2026-10-24T09:15:14.500Z');
    const calls = await query(`SELECT call_id, run_id, cost_usd, action FROM usage_calls ORDER BY ts`);
    expect(calls.rows.map((r) => [r.call_id, r.run_id, r.cost_usd, r.action])).toEqual([
      ['bolt-20261024-091500-k3j2:3', 'bolt-20261024-091500', 0.0001115, 'read'],
      ['bolt-20261024-091500-k3j2:6', 'bolt-20261024-091500', 0.0001232, 'post'],
      ['bolt-20261024-091500-k3j2:10', 'bolt-20261024-091500', 0.0000451, 'reply']]);
    const s = await query(`SELECT source, harness, model, message_count, cost_usd FROM archive_sessions`);
    expect(s.rows).toEqual([{ source: 'zen-agent', harness: 'zen-agent', model: 'openrouter/deepseek/deepseek-v4.1-flash', message_count: 10, cost_usd: 0.0002798 }]);
    const steps = await query(`SELECT step, count(*)::int n FROM archive_messages GROUP BY step ORDER BY step`);
    expect(steps.rows).toEqual([{ step: 'meta', n: 2 }, { step: 'prompt', n: 1 }, { step: 'response', n: 1 }, { step: 'system', n: 2 }, { step: 'tool_call', n: 2 }, { step: 'tool_result', n: 2 }]);
    // The view carries the runtime, the tier and the price.
    const facts = await query(`SELECT runtime, tier, surface, agent_name, sum(cost_usd) cost FROM usage_facts GROUP BY 1,2,3,4`);
    expect(facts.rows).toEqual([{ runtime: 'zen-agent', tier: 'flash-low', surface: 'bot', agent_name: 'bolt', cost: 0.0002798 }]);
    // Unchanged file: nothing re-read.
    expect(await syncUsage(paths(), 'droplet')).toMatchObject({ files: 0, runs: 0, calls: 0 });
  });
});

describe('usage api with a zen-agent run', () => {
  const app = createApp({ modules: ALL_MODULES });
  beforeEach(async () => {
    await truncateAll();
    const t = parseZenTrace(records(), 'droplet', '/srv/vault/.zen/sessions/bolt.jsonl', MTIME);
    await withTransaction(async (tx) => {
      await store.upsertRuns(tx, [t.run!, { ...t.run!, runId: 'cc-1', sessionId: 'cc-1', runtime: 'claude-code', agentName: 'atlas', totalCostUsd: 1.5, tier: null }]);
      await store.upsertCalls(tx, t.calls);
      await store.attachCallsToRuns(tx, 'droplet');
    });
  });

  it('shows real cost for the zen-agent run and none for the Claude one, and the runtime as the source', async () => {
    const r = await request(app).get('/api/usage/runs').query({ from: '2026-10-24T00:00:00Z', to: '2026-10-25T00:00:00Z' });
    expect(r.status).toBe(200);
    const byId = Object.fromEntries(r.body.runs.map((x: { run_id: string }) => [x.run_id, x]));
    expect(byId['bolt-20261024-091500']).toMatchObject({ source: 'zen-agent', runtime: 'zen-agent', tier: 'flash-low', cost_usd: 0.0002798, agent_name: 'bolt', surface: 'bot', calls: 3 });
    expect(byId['cc-1']).toMatchObject({ source: 'claude-code', runtime: 'claude-code', cost_usd: null });
    const f = await request(app).get('/api/usage/facets').query({ from: '2026-10-24T00:00:00Z', to: '2026-10-25T00:00:00Z' });
    expect(f.body.facets.source).toEqual([{ value: 'zen-agent', calls: 3, tokens: 10730, output: 130 }]);
    const s = await request(app).get('/api/usage/sessions').query({ from: '2026-10-24T00:00:00Z', to: '2026-10-25T00:00:00Z' });
    expect(s.body.sessions[0]).toMatchObject({ source: 'zen-agent', external_id: 'bolt-20261024-091500-k3j2', cost_usd: 0.0002798, runs: 1 });
  });
});
