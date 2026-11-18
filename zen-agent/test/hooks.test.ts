import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runHook, runHooks, writeClaudeTranscript } from '../src/hooks.js';

test('exit 2 blocks with stderr; a JSON block decision blocks; anything else allows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zen-hooks-'));
  assert.deepEqual(await runHook('cat >/dev/null; echo "guard: nope" >&2; exit 2', {}, dir), { block: true, reason: 'guard: nope' });
  assert.deepEqual(await runHook(`cat >/dev/null; echo '{"decision":"block","reason":"hermes says no"}'`, {}, dir), { block: true, reason: 'hermes says no' });
  assert.deepEqual(await runHook('cat >/dev/null; echo "{}"', {}, dir), { block: false });
  assert.deepEqual(await runHook('cat >/dev/null; exit 1', {}, dir), { block: false }); // a crash fails open
  assert.deepEqual(await runHook('/no/such/command', {}, dir), { block: false });
  assert.deepEqual(await runHook('sleep 5', {}, dir, 100), { block: false }); // a timeout fails open
  const payload = await runHook("payload=$(cat); [ \"$payload\" = '{\"a\":1}' ] && exit 0; echo bad >&2; exit 2", { a: 1 }, dir);
  assert.deepEqual(payload, { block: false });
  assert.deepEqual(await runHooks(['exit 0', 'echo first >&2; exit 2', 'echo second >&2; exit 2'], {}, dir), { block: true, reason: 'first' });
});

test('writeClaudeTranscript maps zen edits to Claude Code tool_use blocks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zen-hooks-'));
  const path = join(dir, 't.jsonl');
  writeClaudeTranscript(path, [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [{ type: 'text', text: 'editing' }, { type: 'toolCall', id: '1', name: 'edit_file', arguments: { path: '.agents/skills/x/SKILL.md', old: 'a', new: 'b' } }] },
    { role: 'assistant', content: [{ type: 'toolCall', id: '2', name: 'bash', arguments: { command: 'ls' } }] },
  ]);
  const recs = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { message: { content: { type: string; name?: string; input?: { file_path?: string } }[] } });
  assert.equal(recs.length, 2);
  const edit = recs[0]!.message.content[1]!;
  assert.deepEqual([edit.type, edit.name, edit.input?.file_path], ['tool_use', 'Edit', '.agents/skills/x/SKILL.md']);
  assert.equal(recs[1]!.message.content[0]!.name, 'Bash');
});
