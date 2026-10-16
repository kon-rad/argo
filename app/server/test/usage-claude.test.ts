import { describe, expect, it } from 'vitest';
import { callsFromRecords } from '../src/usage/claudeCalls.js';
import { splitJsonLines } from '../src/usage/lines.js';

const usage = (out: number) => ({
  input_tokens: 2, cache_creation_input_tokens: 36927, cache_read_input_tokens: 23167, output_tokens: out,
  output_tokens_details: { thinking_tokens: 94 }, server_tool_use: { web_search_requests: 1 },
});
const block = (uuid: string, ts: string, out: number, extra: object = {}) => ({
  type: 'assistant', uuid, timestamp: ts, sessionId: 's1', cwd: '/vault', entrypoint: 'cli', requestId: 'req_1',
  message: { id: 'msg_1', model: 'claude-opus-5-5', usage: usage(out), content: [{ type: 'text', text: 'hi' }] },
  ...extra,
});

describe('callsFromRecords', () => {
  it('keeps one call per message id, the block with the most output, at the first timestamp', () => {
    const calls = callsFromRecords([
      { type: 'user', uuid: 'u0', message: { content: 'go' } },
      block('a1', '2026-10-13T09:58:06.292Z', 100),
      block('a2', '2026-10-13T09:58:07.563Z', 296),
    ], 'mac', 's1');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      callId: 'msg_1', requestId: 'req_1', messageExternalId: 'a2', model: 'claude-opus-5-5', entrypoint: 'cli',
      inputTokens: 2, cacheWriteTokens: 36927, cacheReadTokens: 23167, outputTokens: 296, thinkingTokens: 94,
      webSearchRequests: 1, isSidechain: false, sessionExternalId: 's1', host: 'mac',
    });
    expect(calls[0]!.ts.toISOString()).toBe('2026-10-13T09:58:06.292Z');
  });

  it('labels each call with the first tool it invoked and the action class', () => {
    const tool = (uuid: string, id: string, name: string, input: object) => ({
      ...block(uuid, '2026-10-13T10:00:00Z', 10), message: { id, model: 'm', usage: usage(10), content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'tu', name, input }] },
    });
    const calls = callsFromRecords([
      tool('c1', 'msg_dm', 'Bash', { command: 'cli-org dm rune "hi"' }),
      tool('c2', 'msg_post', 'Bash', { command: 'cd /home/agent/secondBrain && cli-org post platform "status" --kind status' }),
      tool('c3', 'msg_ticket', 'Bash', { command: 'ORG_AGENT=atlas cli-org task create rune "x" --project p' }),
      tool('c4', 'msg_card', 'Bash', { command: 'hermes kanban --board exo complete t_1' }),
      tool('c5', 'msg_tracker', 'Bash', { command: 'cli-projects verify agent-company/board --pass --kind test --check x' }),
      tool('c6', 'msg_read', 'Bash', { command: 'cli-projects list' }),
      tool('c7', 'msg_write', 'Edit', { file_path: '/x' }),
      tool('c8', 'msg_grep', 'Grep', { pattern: 'x' }),
      tool('c9', 'msg_shell', 'Bash', { command: 'git status' }),
      block('c10', '2026-10-13T10:00:01Z', 5),
    ], 'droplet', 's1');
    expect(Object.fromEntries(calls.map((c) => [c.callId, [c.tool, c.action]]))).toEqual({
      msg_dm: ['Bash', 'dm'], msg_post: ['Bash', 'post'], msg_ticket: ['Bash', 'ticket'], msg_card: ['Bash', 'card'], msg_tracker: ['Bash', 'tracker'],
      msg_read: ['Bash', 'read'], msg_write: ['Edit', 'write'], msg_grep: ['Grep', 'read'], msg_shell: ['Bash', 'shell'], msg_1: [null, 'reply'],
    });
  });

  it('skips synthetic error messages and records without usage or a valid time', () => {
    const calls = callsFromRecords([
      { type: 'assistant', uuid: 'x', timestamp: '2026-10-13T00:00:00Z',
        message: { id: 'msg_s', model: '<synthetic>', usage: usage(0) } },
      { type: 'assistant', uuid: 'y', timestamp: 'nope', message: { id: 'msg_t', model: 'm', usage: usage(1) } },
      { type: 'assistant', uuid: 'z', timestamp: '2026-10-13T00:00:00Z', message: { id: 'msg_u', model: 'm' } },
    ], 'mac', 's1');
    expect(calls).toEqual([]);
  });

  it('marks subagent work as sidechain', () => {
    const calls = callsFromRecords([block('a1', '2026-10-13T00:00:00Z', 5, { isSidechain: true })], 'droplet', 's1');
    expect(calls[0]!.isSidechain).toBe(true);
  });
});

describe('splitJsonLines', () => {
  it('parses complete lines only and reports the bytes it used', () => {
    const text = `{"a":1}\nnot json\n{"b":2}\n{"partial":`;
    const r = splitJsonLines(Buffer.from(text));
    expect(r.records).toEqual([{ a: 1 }, { b: 2 }]);
    expect(r.lines).toBe(3);
    expect(r.consumedBytes).toBe(Buffer.byteLength(`{"a":1}\nnot json\n{"b":2}\n`));
  });
});
