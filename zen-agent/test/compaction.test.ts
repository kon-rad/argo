import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compact, cutIndex, renderForSummary } from '../src/compaction.js';

const u = (t: string) => ({ role: 'user', content: t, timestamp: 1 });
const a = (t: string) => ({ role: 'assistant', content: [{ type: 'text', text: t }], timestamp: 1 });
const sys = { role: 'system', content: 'sys', timestamp: 0 };

test('cutIndex keeps the last N user turns and never cuts at the head', () => {
  const msgs = [sys, u('1'), a('r1'), u('2'), a('r2'), u('3'), a('r3')];
  assert.equal(cutIndex(msgs, 1), 5);
  assert.equal(cutIndex(msgs, 2), 3);
  assert.equal(cutIndex(msgs, 3), -1);
  assert.equal(cutIndex([sys, u('1'), a('r')], 0), -1);
});

test('compact summarises the middle, keeps head and tail, reports sizes', async () => {
  const msgs = [sys, u('first task'), a('did x'), u('second'), a('did y'), u('third'), a('did z')];
  const seen: string[] = [];
  const r = await compact(msgs, { models: null as never, model: null as never, capTokens: 1, keepTurns: 1, summarize: async (t) => (seen.push(t), 'SUMMARY') });
  assert.ok(r.compacted);
  assert.equal(r.dropped, 4);
  assert.deepEqual(r.messages.map((m) => (m as { role: string }).role), ['system', 'user', 'user', 'assistant']);
  assert.match((r.messages[1] as { content: string }).content, /compacted\]\nSUMMARY/);
  assert.match(seen[0]!, /user: first task\n\nassistant: did x/);
  assert.ok(r.after < r.before);
  const none = await compact(msgs, { models: null as never, model: null as never, capTokens: 10_000, keepTurns: 1 });
  assert.equal(none.compacted, false);
  const failed = await compact(msgs, { models: null as never, model: null as never, capTokens: 1, keepTurns: 1, summarize: async () => { throw new Error('down'); } });
  assert.equal(failed.compacted, false);
});

test('renderForSummary shows tool calls compactly', () => {
  const text = renderForSummary([{ role: 'assistant', content: [{ type: 'toolCall', name: 'bash', arguments: { command: 'ls' } }] }, { role: 'toolResult', toolName: 'bash', content: [{ type: 'text', text: 'a\nb' }] }]);
  assert.match(text, /\[call bash {"command":"ls"}\]/);
  assert.match(text, /toolResult \(bash\): a\nb/);
});
