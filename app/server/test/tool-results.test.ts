import { expect, it } from 'vitest';
import { normalizeResult, toolResult } from '../src/archive/toolResult.js';
import { expandSteps, stepFields } from '../src/archive/steps.js';
import { parseCodex } from '../src/usage/codex.js';

it.each(['codex', 'hermes'])('%s shares text and outcome between import and detail', (runtime) => {
  for (const [output, expected] of [
    [{ output: 'permission refused', exit_code: 255 }, true],
    [{ stdout: 'error exit_code: 255\n{"exit_code":255}', exit_code: 0 }, false],
    [[{ type: 'text', text: 'ok' }, { type: 'text', text: '{"exit_code":0}' }], false],
    [[{ type: 'text', text: '{"exit_code":0}' }, { type: 'text', text: 'ok' }], false],
    [[{ type: 'text', text: 'ok' }, { structuredContent: { exit_code: 0 } }], false],
    [[{ type: 'text', text: '{"exit_code":0}' }, { type: 'text', text: '{"exit_code":255}' }], true],
    [[{ type: 'text', text: 'ok' }, { type: 'text', text: 'done' }], null],
    [{ output: 'failed timeout cancelled' }, null],
    [{ status: 'cancelled', output: 'stopped' }, true],
    [{ timed_out: true, output: 'stopped' }, true],
    [{ exit_code: 'bad', output: 'partial' }, null],
  ] as const) {
    const raw = runtime === 'codex'
      ? { harness: 'codex', payload: { type: 'function_call_output', call_id: 'call-a', output: JSON.stringify(output) } }
      : { role: 'tool', session_id: 'fake-session', tool_call_id: 'call-a', content: JSON.stringify(output) };
    expect(stepFields(raw).isError).toBe(expected);
    const part = expandSteps({ id: 1, role: 'tool', kind: '', raw, text: 'old', ts: null })[0]!;
    expect(part.isError).toBe(expected);
    expect(part.text).toBe(toolResult(raw)!.text);
  }
});
it('decodes arrays, nested results and encoded text envelopes without object coercion', () => {
  expect(normalizeResult([{ type: 'text', text: JSON.stringify({ output: 'readable', exit_code: 255 }) },
    { type: 'text', text: 'more' }])).toEqual({ text: 'readable\nmore', isError: true });
  expect(normalizeResult({ result: { structuredContent: { exit_code: 0 }, content: [{ type: 'text', text: 'ok' }] } }))
    .toEqual({ text: 'ok', isError: false });
  expect(normalizeResult({ strange: { data: [1, 2] } }).text).toContain('"strange"');
  expect(normalizeResult({ strange: 'x'.repeat(100000) }).text.length).toBeLessThan(66000);
  expect(normalizeResult('{"exit_code":')).toEqual({ text: '{"exit_code":', isError: null });
  expect(normalizeResult(null)).toEqual({ text: '', isError: null });
});
it('trusts explicit zero over nested examples in stdout and recognises only structured cancellation', () => {
  expect(normalizeResult({ exit_code: 0, stdout: '{"exit_code":255}', content: 'error timeout' }).isError).toBe(false);
  expect(normalizeResult('Process exited with code 255\nerror timeout').isError).toBeNull();
  expect(normalizeResult({ example: { exit_code: 255 } }).isError).toBeNull();
});
it('keeps Codex identities and token accounting while decoding output', () => {
  const records = [ { type: 'session_meta', payload: { id: 'fake-session' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'one', output: [{ type: 'text', text: 'readable' }] } },
    { type: 'event_msg', timestamp: '2026-11-01T00:00:00Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 80, output_tokens: 20 } } } } ];
  const p = parseCodex(records, 'mac');
  expect(p.messages[0]!.contentText).toBe('readable');
  expect(parseCodex(records, 'mac')).toEqual(p);
  expect(p.calls.map(c => [c.inputTokens, c.outputTokens])).toEqual([[80, 20]]);
});

it('does not turn unknown or malformed scalar output into a recorded failure', () => {
  for (const value of [undefined, 7, true, [], { exit_code: '255' }, { example: { status: 'failed' } }, '{broken']) {
    expect(normalizeResult(value).isError).toBeNull();
    expect(normalizeResult(value).text).not.toContain('[object Object]');
  }
});
it('keeps the raw structured source unchanged', () => {
  const raw = { harness: 'codex', payload: { type: 'function_call_output', output: [{ type: 'text', text: '{"output":"denied","metadata":{"exit_code":255}}' }] } };
  const before = JSON.stringify(raw);
  expect(toolResult(raw)).toEqual({ text: 'denied', isError: true });
  expect(JSON.stringify(raw)).toBe(before);
});

it('rejects unbounded, invalid and ambiguous replay scopes before querying', async () => {
  const { replayResults } = await import('../src/archive/replayResults.js');
  await expect(replayResults({ runtime: 'codex', dryRun: true })).rejects.toThrow('bounded');
  await expect(replayResults({ runtime: 'hermes', sessionId: 1, seq: -1, dryRun: true })).rejects.toThrow('seq');
  await expect(replayResults({ runtime: 'codex', from: 'bad', to: 'bad', dryRun: true })).rejects.toThrow('date');
  await expect(replayResults({ runtime: 'codex', sessionId: 1, batch: 0, dryRun: true })).rejects.toThrow('batch');
});
it('does not equate lifecycle completion with a verified successful tool', () => {
  expect(normalizeResult({ status: 'completed', output: 'finished' }).isError).toBeNull();
  expect(normalizeResult({ status: 'completed', result: { exit_code: 255, output: 'denied' } }).isError).toBe(true);
});
