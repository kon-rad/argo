import { describe, expect, it } from 'vitest';
import { hermesCallFromLine, hermesMatchKey, parseHermesCalls } from '../src/usage/hermesCalls.js';

const row = (extra: Record<string, unknown> = {}) => JSON.stringify({ v: 1, kind: 'main', ts: '2026-10-20T01:02:03+00:00',
  session_id: 's1', api_request_id: 'req-1', api_call_count: 3, platform: 'cli', provider: 'openrouter', model: 'qwen3',
  response_model: 'qwen/qwen3-235b', input: 120, output: 30, cache_read: 900, cache_write: 10, reasoning: 8,
  tools: ['terminal', 'read_file'], match: 't:call_1', ...extra });

describe('Hermes plugin calls', () => {
  it('maps a line to a usage_calls row with the served model, tokens and match key', () => {
    expect(hermesCallFromLine(row(), 'hermes:builder', 'droplet')).toMatchObject({
      source: 'hermes:builder', host: 'droplet', callId: 'req-1', sessionExternalId: 's1', model: 'qwen/qwen3-235b',
      entrypoint: 'cli', inputTokens: 120, outputTokens: 30, cacheReadTokens: 900, cacheWriteTokens: 10, thinkingTokens: 8,
      tool: 'terminal', provider: 'openrouter', matchKey: 't:call_1', messageExternalId: null,
    });
  });

  it('labels side calls and never matches them to a response', () => {
    const c = hermesCallFromLine(row({ kind: 'aux', aux_task: 'title_generation', match: 't:x' }), 'hermes', 'mac')!;
    expect([c.entrypoint, c.matchKey]).toEqual(['aux:title_generation', null]);
  });

  it('gives a call without a request id the same id every time', () => {
    const a = hermesCallFromLine(row({ api_request_id: null }), 'hermes', 'mac')!;
    const b = hermesCallFromLine(row({ api_request_id: null }), 'hermes', 'mac')!;
    expect(a.callId).toMatch(/^h:[0-9a-f]{32}$/);
    expect(a.callId).toBe(b.callId);
  });

  it('skips cut-off lines, other versions and lines without a session', () => {
    const text = [row(), '{"v":1,"kind":"main"', row({ v: 2 }), row({ session_id: '' }), '', row({ api_request_id: 'req-2' })].join('\n');
    expect(parseHermesCalls(text, 'hermes', 'mac').map((c) => c.callId)).toEqual(['req-1', 'req-2']);
  });

  it('computes the plugin\'s match key from a stored message (same hash as the Python side)', () => {
    expect(hermesMatchKey(['call_a', 'call_b'], 'ignored')).toBe('t:call_a,call_b');
    // Python: hashlib.sha256(b"Done.").hexdigest()[:32]
    expect(hermesMatchKey([], '  Done.\n')).toBe('c:ed251864987c367e9641fbdc89c1d83e');
    expect(hermesMatchKey([], '   ')).toBeNull();
  });
});
