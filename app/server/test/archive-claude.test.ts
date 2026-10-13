import { describe, it, expect } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { clean, gzipDeterministic, sha256 } from '../src/archive/clean.js';
import { parseClaudeJsonl } from '../src/archive/claude.js';

const L = (o: unknown) => JSON.stringify(o) + '\n';
const user = { type: 'user', uuid: 'u1', parentUuid: null, sessionId: 'S', timestamp: '2026-09-28T01:00:00.000Z',
  message: { role: 'user', content: 'hello archive' } };
const asst = { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: 'S', timestamp: '2026-09-28T01:00:05.000Z',
  message: { role: 'assistant', model: 'claude-opus-5-5', content: [
    { type: 'thinking', thinking: 'plan it' },
    { type: 'text', text: 'Sure.' },
    { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
  ] } };
const result = { type: 'user', uuid: 'r1', parentUuid: 'a1', timestamp: '2026-09-28T01:00:06.000Z',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'file.md' }] }] } };
const title = { type: 'ai-title', aiTitle: 'Archive agent logs' };

describe('clean', () => {
  it('cleans NUL and lone surrogates', () => {
    const out = clean({ a: 'x\u0000y', b: ['\ud800z'] });
    expect(out.a).toBe('x�y');
    expect(out.b[0]).toBe('�z');
  });
  it('gzips deterministically', () => {
    const a = gzipDeterministic(Buffer.from('same'));
    expect(a.equals(gzipDeterministic(Buffer.from('same')))).toBe(true);
    expect(gunzipSync(a).toString()).toBe('same');
    expect(sha256('abc')).toHaveLength(64);
  });
});

describe('parseClaudeJsonl', () => {
  it('parses every line and extracts text', () => {
    const buf = Buffer.from(L(user) + L(asst) + L(result) + L(title));
    const c = parseClaudeJsonl(buf, 0);
    expect(c.messages.map((m) => [m.seq, m.externalId, m.role, m.kind])).toEqual([
      [1, 'u1', 'user', 'user'], [2, 'a1', 'assistant', 'assistant'], [3, 'r1', 'user', 'user'], [4, 'line:4', 'meta', 'ai-title'],
    ]);
    expect(c.messages[1]!.contentText).toContain('[thinking] plan it');
    expect(c.messages[1]!.contentText).toContain('Sure.');
    expect(c.messages[1]!.contentText).toContain('[tool_use Bash] {"command":"ls"}');
    expect(c.messages[2]!.contentText).toContain('file.md');
    expect(c.messages[0]!.ts?.toISOString()).toBe('2026-09-28T01:00:00.000Z');
    expect(c.title).toBe('Archive agent logs');
    expect(c.model).toBe('claude-opus-5-5');
    expect(c.consumedBytes).toBe(buf.length);
    expect(c.linesConsumed).toBe(4);
  });

  it('stops at the last complete line', () => {
    const full = L(user);
    const buf = Buffer.from(full + '{"type":"assistant","uu');
    const c = parseClaudeJsonl(buf, 0);
    expect(c.messages).toHaveLength(1);
    expect(c.consumedBytes).toBe(Buffer.byteLength(full));
  });

  it('continues seq numbering from startLine', () => {
    const c = parseClaudeJsonl(Buffer.from(L(title)), 10);
    expect(c.messages[0]!.seq).toBe(11);
    expect(c.messages[0]!.externalId).toBe('line:11');
  });

  it('keeps malformed lines as unparseable', () => {
    const c = parseClaudeJsonl(Buffer.from('not json\n'), 0);
    expect(c.messages[0]!.kind).toBe('unparseable');
    expect(c.messages[0]!.raw).toEqual({ line: 'not json' });
  });

  it('marks sidechain records and cleans dirty strings', () => {
    const side = { ...user, uuid: 'u9', isSidechain: true, message: { role: 'user', content: 'a\u0000b' } };
    const m = parseClaudeJsonl(Buffer.from(L(side)), 0).messages[0]!;
    expect(m.isSidechain).toBe(true);
    expect(m.contentText).toBe('a�b');
  });
});
