import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCodex } from '../src/usage/codex.js';
import { buildPush } from '../src/usage/push.js';
import { buildRedactor } from '../src/archive/redact.js';
import { expandSteps, stepFields } from '../src/archive/steps.js';
import { buildLive } from '../src/usage/live.js';
import { runtimeOf } from '../src/usage/running.js';
const at = '2026-11-01T01:00:00Z';
const row = (type: string, payload: unknown, timestamp = at) => ({ timestamp, type, payload });
const meta = row('session_meta', { id: 'fake-session', source: 'exec', cwd: '/srv/example', model: 'example-model' });
const token = (n: number) => row('event_msg', { type: 'token_count', info: { total_token_usage: {
  input_tokens: n, cached_input_tokens: n / 2, output_tokens: n / 4, reasoning_output_tokens: n / 8,
}, last_token_usage: { input_tokens: n, output_tokens: n } } });
const jsonl = (r: unknown[]) => r.map(x => JSON.stringify(x)).join('\n') + '\n';
it('counts cumulative high-water deltas once, keeps cached input disjoint and reasoning within output', () => {
  const p = parseCodex([meta, token(80), token(80), token(160)], 'laptop-a');
  expect(p.calls).toHaveLength(2);
  expect(p.calls.map(c => [c.inputTokens, c.cacheReadTokens, c.outputTokens, c.thinkingTokens])).toEqual([[40,40,20,10],[40,40,20,10]]);
  expect(p.session).toMatchObject({ source: 'codex', host: 'laptop-a', inputTokens: 80, outputTokens: 40, costUsd: null });
});
it('handles metadata, model changes, nested source identity and absent usage without fabricated cost', () => {
  const p = parseCodex([row('session_meta', { id: 'child', source: { subagent: { thread_spawn: { parent_thread_id: 'parent', agent_nickname: 'helper' } } } }), row('turn_context', { model: 'toy' }),
    row('event_msg', { type: 'user_message', message: 'A title' })], 'laptop-b');
  expect(p.session).toMatchObject({ externalId: 'child', parentExternalId: 'parent', model: 'toy', title: 'A title', inputTokens: null });
  expect(p.calls).toEqual([]);
});
it('supports last-only events and repeated event snapshots', () => {
  const event = row('event_msg', { type: 'token_count', info: { last_token_usage: { input_tokens: 8, output_tokens: 2 } } });
  expect(parseCodex([meta, event, event], 'laptop-a').calls).toHaveLength(1);
});
it('classifies native tool calls, results, reasoning and message steps', () => {
  for (const [type, step] of [['function_call','tool_call'], ['function_call_output','tool_result'], ['reasoning','thinking']]) {
    const raw = { harness: 'codex', type: 'response_item', payload: { type, name: 'example', call_id: 'tool-a' } };
    expect(stepFields(raw).step).toBe(step);
    expect(expandSteps({ id: 1, role: 'assistant', kind: type!, ts: at, raw, text: 'example' })[0]?.step).toBe(step);
  }
});
it('replays only changed complete prefixes including same-size rewrites and truncation; no secret leaves the host', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-parser-'));
  mkdirSync(join(dir, 'dated', 'agents'), { recursive: true });
  const path = join(dir, 'dated', 'agents', 'rollout.jsonl');
  const secret = 'postgres://owner:syntheticpassword@example.invalid/db'; // public-ok: synthetic connection URI, no real account
  writeFileSync(path, jsonl([meta, row('response_item', { type: 'function_call_output', output: secret + '\npostgres://owner:cutpassword\nAPI_TOKEN=brokenvalue\n' + 'sk-' + 'proj-fragment' }), token(80)]));
  const input = { claudeProjectsDir: join(dir, 'absent'), codexSessionsDir: dir, planLog: null, maxBytes: 10 };
  const first = buildPush(input, { files: {} });
  expect(first.lines).toHaveLength(1);
  expect(first.lines.join('')).not.toMatch(/syntheticpassword|cutpassword|brokenvalue|proj-fragment/);
  appendFileSync(path, JSON.stringify(token(160)));
  expect(buildPush(input, first.next).lines).toHaveLength(0);
  appendFileSync(path, '\n');
  const grown = buildPush(input, first.next);
  expect(grown.lines).toHaveLength(1);
  writeFileSync(path, jsonl([meta, token(80)]));
  const shrunk = buildPush(input, grown.next);
  expect(shrunk.lines).toHaveLength(1);
  writeFileSync(path, jsonl([meta, token(88)]));
  expect(buildPush(input, shrunk.next).lines).toHaveLength(1);
});
it('redacts full and truncated tokens, assignments and connection credentials without opening env files', () => {
  const r = buildRedactor({ env: {} });
  for (const text of ['postgres://owner:short', 'postgres://owner:short@example.invalid/db', 'API_TOKEN=truncated', 'sk-' + 'proj-short', 'sk-' + 'proj-syntheticsecret01234567890123456789']) { // public-ok: synthetic connection URI, no real account
    expect(r.text(text)).toContain('[redacted:');
    expect(r.text(text).replace(/\[redacted:[^\]]+\]/g, '')).not.toMatch(/short|truncated|syntheticsecret/);
  }
});
it('shows Codex observations within the active window, expires stale ones and detects local CLI processes', () => {
  expect(runtimeOf('codex exec toy')).toBe('codex');
  const now = new Date('2026-11-01T01:02:00Z');
  const session = { host: 'laptop-a', source: 'codex', externalId: 'fake', title: null, model: null, startedAt: new Date(at), endedAt: new Date(at), updatedAt: new Date(at), messages: 1, input: 1, output: 1, project: null };
  expect(buildLive([], new Map(), [session], [], 'server', now).total).toBe(1);
  expect(buildLive([], new Map(), [session], [], 'server', new Date('2026-11-01T01:04:00Z')).total).toBe(0);
});

it('doctor handles a fresh user, custom Codex home, empty and missing directories without Codex installed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-doctor-'));
  const run = () => execFileSync(process.execPath, ['--import', 'tsx', 'server/src/cli-usage-push.ts', '--doctor'], {
    encoding: 'utf8', env: { ...process.env, CODEX_HOME: dir, USAGE_PUSH_STATE: join(dir, 'state'), USAGE_HOST: 'laptop-a', USAGE_PUSH_HOST: 'my-server' },
  });
  expect(run()).toContain('sessions directory missing');
  mkdirSync(join(dir, 'sessions'));
  expect(run()).toContain('sessions directory empty');
  writeFileSync(join(dir, 'sessions', 'rollout.jsonl'), jsonl([meta]));
  expect(run()).toContain('1 JSONL files found');
});

it('does not starve other native sessions when one active session exceeds the soft budget', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-fair-'));
  const a = join(dir, 'a.jsonl'), b = join(dir, 'b.jsonl');
  writeFileSync(a, jsonl([meta, token(80)]));
  writeFileSync(b, jsonl([{ ...meta, payload: { ...meta.payload, id: 'second-session' } }, token(80)]));
  const input = { claudeProjectsDir: join(dir, 'absent'), codexSessionsDir: dir, planLog: null, maxBytes: 1 };
  const first = buildPush(input, { files: {} });
  const firstIsA = JSON.parse(first.lines[0]!).text.includes('fake-session');
  appendFileSync(firstIsA ? a : b, jsonl([token(160)]));
  const next = buildPush(input, first.next);
  expect(JSON.parse(next.lines[0]!).text).toContain(firstIsA ? 'second-session' : 'fake-session');
});
