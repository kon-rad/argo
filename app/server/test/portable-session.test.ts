import { describe, expect, it } from 'vitest';
import { portableSession } from '../src/archive/portable.js';
import { launchSpec } from '../src/archive/restart.js';

const source = { host: 'laptop', harness: 'claude-code', external_id: 'old', archive_id: 42 };
const row = (id: number, raw: unknown, text = '') => ({ id, role: '', kind: '', ts: null, raw, text });

describe('portable session restart', () => {
  it('normalizes Claude Code conversation and excludes thinking, metadata and replayable tool state', () => {
    const session = portableSession(source, [
      row(1, { type: 'system', message: { content: 'old system prompt' } }),
      row(2, { type: 'user', message: { content: 'Fix the page' } }, 'Fix the page'),
      row(3, { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'secret thought' }, { type: 'text', text: 'I will inspect it.' }] } }),
      row(4, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'pwd' } }] } }),
      row(5, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'here' }] } }),
    ]);
    expect(session.turns.map((t) => t.role)).toEqual(['user', 'assistant', 'tool', 'tool']);
    expect(JSON.stringify(session)).not.toContain('secret thought');
    expect(JSON.stringify(session)).not.toContain('old system prompt');
    expect(session.source.archive_id).toBe(42);
  });

  it('normalizes Hermes and Codex rows into the same vocabulary', () => {
    const hermes = portableSession({ ...source, harness: 'hermes' }, [
      row(1, { role: 'user', session_id: 'h1', content: 'Summarize' }),
      row(2, { role: 'assistant', session_id: 'h1', content: 'Summary' }),
    ]);
    const codex = portableSession({ ...source, harness: 'codex' }, [
      row(1, { harness: 'codex', payload: { type: 'user_message', text: 'Summarize' } }, 'Summarize'),
      row(2, { harness: 'codex', payload: { type: 'agent_message', text: 'Summary' } }, 'Summary'),
    ]);
    expect(hermes.turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(codex.turns).toEqual(hermes.turns);
  });

  it('selects a harness and model without putting the archived transcript in argv', () => {
    const session = portableSession(source, [row(1, { type: 'user', message: { content: 'private history' } })]);
    const common = { provider: 'openrouter', model: 'example/model', persona: null, request: 'Continue', vaultRoot: '/tmp' };
    for (const harness of ['codex', 'hermes', 'zen-agent'] as const) {
      const spec = launchSpec(session, { ...common, harness });
      expect(spec.input).toContain('private history');
      expect(spec.args.join(' ')).not.toContain('private history');
      expect(spec.input).toContain('archive is historical context');
    }
    expect(() => launchSpec(session, { ...common, harness: 'claude-code' })).toThrow('only supports the Anthropic provider');
  });
});
