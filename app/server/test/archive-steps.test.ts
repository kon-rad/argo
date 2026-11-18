import { describe, it, expect, beforeAll } from 'vitest';
import { query } from '../src/db.js';
import { expandSteps, stepFields, toolSummary } from '../src/archive/steps.js';
import { truncateAll } from './helpers.js';

const claude = (type: string, content: unknown, extra: Record<string, unknown> = {}) =>
  ({ type, uuid: 'u', message: { role: type, content }, ...extra });

const hermes = (role: string, extra: Record<string, unknown> = {}) =>
  ({ id: 7, session_id: 'h1', role, content: null, tool_calls: null, tool_name: null, tool_call_id: null, reasoning: null, ...extra });

const HERMES_CALLS = JSON.stringify([
  { id: 'call_a', call_id: 'call_a', type: 'function', function: { name: 'terminal', arguments: '{"command":"ls"}' } },
  { id: 'call_b', type: 'function', function: { name: 'read_file', arguments: '{"path":"x.md"}' } },
]);

describe('stepFields', () => {
  it('classifies Claude Code records', () => {
    expect(stepFields(claude('user', 'fix the page'))).toEqual({ step: 'prompt', toolNames: [], toolCallId: null, isError: null });
    expect(stepFields(claude('user', [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: 'boom' }])))
      .toEqual({ step: 'tool_result', toolNames: [], toolCallId: 'toolu_1', isError: true });
    expect(stepFields(claude('assistant', [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }])))
      .toEqual({ step: 'tool_call', toolNames: ['Bash'], toolCallId: 'toolu_1', isError: null });
    expect(stepFields(claude('assistant', [{ type: 'thinking', thinking: 'hmm' }])).step).toBe('thinking');
    expect(stepFields(claude('assistant', [{ type: 'text', text: 'done' }])).step).toBe('response');
    expect(stepFields(claude('assistant', [{ type: 'thinking', thinking: 'a' }, { type: 'text', text: 'b' }])).step).toBe('response');
    expect(stepFields(claude('user', [{ type: 'text', text: 'hi' }, { type: 'image', source: {} }])).step).toBe('prompt');
    expect(stepFields({ type: 'system', content: 'compacted' }).step).toBe('system');
    for (const type of ['attachment', 'mode', 'last-prompt', 'ai-title', 'queue-operation']) expect(stepFields({ type }).step).toBe('meta');
  });

  it('classifies Hermes rows', () => {
    expect(stepFields(hermes('user', { content: 'hi' })).step).toBe('prompt');
    expect(stepFields(hermes('assistant', { content: 'ok', reasoning: 'r', tool_calls: HERMES_CALLS })))
      .toEqual({ step: 'tool_call', toolNames: ['terminal', 'read_file'], toolCallId: null, isError: null });
    expect(stepFields(hermes('assistant', { content: 'ok' })).step).toBe('response');
    expect(stepFields(hermes('tool', { content: 'out', tool_name: 'terminal', tool_call_id: 'call_a' })))
      .toEqual({ step: 'tool_result', toolNames: ['terminal'], toolCallId: 'call_a', isError: null });
    expect(stepFields(hermes('system', { content: 'x' })).step).toBe('system');
  });

  it('never throws on a broken tool_calls string', () => {
    expect(stepFields(hermes('assistant', { content: 'ok', tool_calls: '[{not json' })).step).toBe('response');
    expect(stepFields(hermes('assistant', { content: 'ok', tool_calls: '' })).step).toBe('response');
    expect(stepFields(null).step).toBe('meta');
  });
});

describe('expandSteps', () => {
  it('splits a Hermes assistant row into thinking, response and one part per tool call', () => {
    const parts = expandSteps({ id: 9, role: 'assistant', kind: 'assistant', ts: null, text: '',
      raw: hermes('assistant', { content: 'on it', reasoning: 'plan', tool_calls: HERMES_CALLS }) });
    expect(parts.map((p) => [p.key, p.step, p.toolName, p.toolCallId])).toEqual([
      ['9:r', 'thinking', null, null], ['9', 'response', null, null],
      ['9:tc:0', 'tool_call', 'terminal', 'call_a'], ['9:tc:1', 'tool_call', 'read_file', 'call_b'],
    ]);
    expect(parts[0]!.text).toBe('plan');
    expect(JSON.parse(parts[2]!.text)).toEqual({ command: 'ls' });
  });

  it('keeps every block of a multi-block Claude record', () => {
    const parts = expandSteps({ id: 3, role: 'assistant', kind: 'assistant', ts: null, text: '',
      raw: claude('assistant', [{ type: 'thinking', thinking: 'a' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } }, { type: 'text', text: 'b' }]) });
    expect(parts.map((p) => p.step)).toEqual(['thinking', 'tool_call', 'response']);
    expect(parts[1]).toMatchObject({ toolName: 'Read', toolCallId: 't1' });
  });

  it('gives a tool result its text, id and error flag', () => {
    const [p] = expandSteps({ id: 4, role: 'user', kind: 'user', ts: null, text: '',
      raw: claude('user', [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: 'no such file' }] }]) });
    expect(p).toMatchObject({ step: 'tool_result', toolCallId: 't1', isError: true, text: 'no such file' });
  });

  it('falls back to the stored text for records it does not know', () => {
    const [p] = expandSteps({ id: 5, role: 'meta', kind: 'mystery', ts: null, text: 'stored', raw: {} });
    expect(p).toMatchObject({ key: '5', step: 'meta', text: 'stored' });
  });
});

describe('toolSummary', () => {
  it('picks the field that says what the call did', () => {
    expect(toolSummary('Bash', '{"command":"git status"}')).toBe('git status');
    expect(toolSummary('Edit', '{"file_path":"/a/b.ts","old_string":"x"}')).toBe('/a/b.ts');
    expect(toolSummary('Grep', '{"pattern":"TODO"}')).toBe('TODO');
    expect(toolSummary('Agent', '{"description":"Builder check"}')).toBe('Builder check');
    expect(toolSummary('terminal', '{"command":"ls"}')).toBe('ls');
    expect(toolSummary('other', 'not json')).toBe('not json');
    expect(toolSummary('other', `{"a":"${'x'.repeat(300)}"}`).length).toBeLessThanOrEqual(121);
  });
});

describe('agent-sessions migration', () => {
  beforeAll(truncateAll);

  it('derives harness, profile and provider for every source', async () => {
    await query(`INSERT INTO archive_sessions (source, host, external_id, meta) VALUES
      ('claude-code','mac','c1','{}'), ('hermes','mac','h1','{"billing_provider":"openrouter"}'),
      ('hermes:builder','droplet','h2','{"billing_provider":""}'), ('hermes:user','mac','h3','{}')`);
    const { rows } = await query(`SELECT external_id, harness, profile, provider FROM archive_sessions ORDER BY external_id`);
    expect(rows).toEqual([
      { external_id: 'c1', harness: 'claude-code', profile: null, provider: 'anthropic' },
      { external_id: 'h1', harness: 'hermes', profile: 'main', provider: 'openrouter' },
      { external_id: 'h2', harness: 'hermes', profile: 'builder', provider: null },
      { external_id: 'h3', harness: 'hermes', profile: 'user', provider: null },
    ]);
  });

  it('adds the step columns to archive_messages', async () => {
    const { rows } = await query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
      WHERE table_name='archive_messages' AND column_name IN ('step','tool_names','tool_call_id','is_error') ORDER BY 1`);
    expect(rows.map((r) => r.column_name)).toEqual(['is_error', 'step', 'tool_call_id', 'tool_names']);
  });
});
