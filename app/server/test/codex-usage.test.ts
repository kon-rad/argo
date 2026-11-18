import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { ALL_MODULES } from './helpers.js';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { parseCodex } from '../src/usage/codex.js';
import { buildPush } from '../src/usage/push.js';
import { importLines } from '../src/usage/importer.js';
import { query } from '../src/db.js';
import { truncateAll } from './helpers.js';
const at = '2026-11-01T01:00:00Z';
const row = (type: string, payload: unknown) => ({ timestamp: at, type, payload });
const tokens = (input: number, output: number) => row('event_msg', { type: 'token_count', info: {
  total_token_usage: { input_tokens: input, cached_input_tokens: input / 2, output_tokens: output, reasoning_output_tokens: output / 2 },
  last_token_usage: { input_tokens: input, output_tokens: output },
} });
const fixture = (source: unknown = 'cli') => [
  row('session_meta', { id: 'synthetic-session', cwd: '/srv/example', source, model: 'example-model', parent_thread_id: 'synthetic-parent' }),
  row('turn_context', { model: 'example-model' }),
  row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Build a toy' }] }),
  row('response_item', { type: 'function_call', call_id: 'tool-1', name: 'exec_command', arguments: '{"cmd":"example"}' }),
  row('response_item', { type: 'function_call_output', call_id: 'tool-1', output: 'postgres://owner:syntheticpassword@example.invalid/db sk-' + 'proj-syntheticsecret01234567890123456789' }), // public-ok: synthetic connection URI, no real account
  tokens(100, 20), tokens(100, 20), tokens(180, 40),
];
const jsonl = (records: unknown[]) => records.map(x => JSON.stringify(x)).join('\n') + '\n';
beforeEach(truncateAll);
afterAll(async () => { await truncateAll(); await query("DELETE FROM usage_hosts WHERE slug IN ('laptop-a','laptop-b')"); });
it('parses Desktop, CLI and nested headless identities and cumulative snapshots', () => {
  for (const source of ['cli', 'vscode', 'exec', { subagent: { thread_spawn: { parent_thread_id: 'synthetic-parent', agent_nickname: 'helper' } } }]) {
    const p = parseCodex(fixture(source), 'laptop-a');
    expect(p.session?.externalId).toBe('synthetic-session');
    expect(p.session?.parentExternalId).toBe('synthetic-parent');
    expect(p.calls).toHaveLength(2);
    expect(p.calls.reduce((s, c) => s + c.inputTokens + c.cacheReadTokens, 0)).toBe(180);
    expect(p.calls.reduce((s, c) => s + c.outputTokens, 0)).toBe(40);
    expect(p.calls.every(c => c.costUsd == null)).toBe(true);
  }
});
it('redacts wire and storage; replays growing, partial, rewritten and truncated files on two hosts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-usage-'));
  mkdirSync(join(dir, 'dated', 'agents'), { recursive: true });
  const path = join(dir, 'dated', 'agents', 'rollout.jsonl');
  writeFileSync(path, jsonl(fixture()));
  const input = { claudeProjectsDir: join(dir, 'absent'), codexSessionsDir: dir, planLog: null, maxBytes: 1000000 };
  const first = buildPush(input, { files: {} });
  expect(first.lines.join('')).not.toMatch(/syntheticpassword|syntheticsecret/);
  for (const host of ['laptop-a', 'laptop-b']) {
    await importLines(first.lines, host);
    await importLines(first.lines, host);
  }
  expect((await query('SELECT count(*)::int n FROM archive_sessions')).rows[0].n).toBe(2);
  expect((await query('SELECT count(*)::int n FROM usage_calls')).rows[0].n).toBe(4);
  appendFileSync(path, JSON.stringify(tokens(220, 60)));
  const partial = buildPush(input, first.next);
  expect(partial.lines).toHaveLength(0);
  appendFileSync(path, '\n');
  const grown = buildPush(input, partial.next);
  await importLines(grown.lines, 'laptop-a');
  writeFileSync(path, jsonl(fixture()));
  await importLines(buildPush(input, grown.next).lines, 'laptop-a');
  writeFileSync(path, jsonl(fixture()).replace('Build a toy', 'Build a car'));
  const rewritten = buildPush(input, first.next);
  expect(rewritten.lines.length).toBeGreaterThan(0);
  await importLines(rewritten.lines, 'laptop-a');
  expect(JSON.stringify((await query('SELECT content_text, raw FROM archive_messages')).rows)).not.toMatch(/syntheticpassword|syntheticsecret/);
  expect((await query("SELECT sum(input+cache_read)::int input, sum(output)::int output FROM usage_facts WHERE source='codex' AND host='laptop-a'")).rows[0]).toEqual({ input: 180, output: 40 });
});

it('exposes native sessions, source filters, facets and drilldown through usage APIs', async () => {
  const wire = JSON.stringify({ t: 'codex', text: jsonl(fixture()) });
  await importLines([wire, wire], 'laptop-a');
  const app = createApp({ modules: ALL_MODULES });
  const range = { from: '2026-11-01T00:00:00Z', to: '2026-11-02T00:00:00Z', source: 'codex' };
  const sessions = await request(app).get('/api/usage/sessions').query(range).expect(200);
  expect(sessions.body.sessions).toHaveLength(1);
  expect(sessions.body.sessions[0].source).toBe('codex');
  const detail = await request(app).get('/api/usage/sessions/laptop-a/synthetic-session').query({ source: 'codex' }).expect(200);
  expect(detail.body.messages.length).toBeGreaterThan(0);
  expect(JSON.stringify(detail.body)).not.toMatch(/syntheticpassword|syntheticsecret/);
  const native = await request(app).get('/api/usage/agent-sessions').query({ ...range, harness: 'codex' }).expect(200);
  expect(native.body.sessions).toHaveLength(1);
  const facets = await request(app).get('/api/usage/facets').query(range).expect(200);
  expect(facets.body.facets.source.some((f: { value: string }) => f.value === 'codex')).toBe(true);
});

it('keeps usage routes absent when the caller disables the feature', async () => {
  const app = createApp({ modules: new Set() });
  await request(app).get('/api/usage/sessions').expect(404);
});

it('reconciles counter rewrites rather than adding a second cumulative history', async () => {
  const native = (n: number) => JSON.stringify({ t: 'codex', text: jsonl([
    row('session_meta', { id: 'rewritten', cwd: '/srv/example', source: 'cli' }), tokens(n, 20), tokens(100, 40),
  ]) });
  await importLines([native(80), native(88), native(88)], 'laptop-a');
  expect((await query("SELECT sum(input_tokens+cache_read_tokens)::int n FROM usage_calls WHERE source='codex'")).rows[0].n).toBe(100);
  expect((await query("SELECT sum(output_tokens)::int n FROM usage_calls WHERE source='codex'")).rows[0].n).toBe(40);
  await importLines([JSON.stringify({ t: 'codex', text: jsonl([
    row('session_meta', { id: 'rewritten', source: 'cli' }), tokens(88, 20),
  ]) })], 'laptop-a');
  expect((await query("SELECT sum(input_tokens+cache_read_tokens)::int n FROM usage_calls WHERE source='codex'")).rows[0].n).toBe(88);
  expect((await query("SELECT input_tokens::int n FROM archive_sessions WHERE source='codex'")).rows[0].n).toBe(44);
});
