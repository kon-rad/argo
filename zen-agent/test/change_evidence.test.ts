import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import { fsTools } from '../src/tools/fs.js';
import type { ToolContext } from '../src/tools/index.js';

test('captures only this operation, rejects failed edits, and verifies exact commit bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zen-change-'));
  try {
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.com'); // public-ok: synthetic git identity
    writeFileSync(join(root, 'note.md'), 'before\n'); git('add', '.'); git('commit', '-qm', 'fixture');
    const tools = Object.fromEntries(fsTools({ cfg: { ...DEFAULTS, workdir: root, fs: { ...DEFAULTS.fs, roots: [root] } } } as ToolContext).map(t => [t.name, t]));
    const run = async (name: string, args: object) => (await tools[name]!.execute('call', args)).details;
    await assert.rejects(run('edit_file', { path: 'note.md', old: 'absent', new: 'oops' }));
    assert.equal(readFileSync(join(root, 'note.md'), 'utf8'), 'before\n');
    writeFileSync(join(root, 'other.md'), 'another agent\n');
    const result = await run('edit_file', { path: 'note.md', old: 'before', new: 'after' });
    assert.equal(result.change.path, 'note.md');
    assert.notEqual(result.change.before, result.change.after);
    assert.deepEqual(result.change.diff, { format: 'replacement', before: 'before\n', after: 'after\n', truncated: false });
    assert.equal(JSON.stringify(result).includes('another agent'), false);
    await assert.rejects(run('inspect_change_commit', { capture: result.change.id, commit: git('rev-parse', 'HEAD') }));
    git('add', 'note.md'); git('commit', '-qm', 'change');
    const commit = await run('inspect_change_commit', { capture: result.change.id, commit: git('rev-parse', 'HEAD') });
    assert.equal(commit.change.commit.verification, 'local-object');
    assert.equal(commit.change.id, result.change.id);
    assert.equal(commit.change.commit.sha, git('rev-parse', 'HEAD'));
    assert.equal(commit.change.commit.authorship, 'unknown');
    git('tag', '-a', 'fixture-tag', '-m', 'fixture tag');
    await assert.rejects(run('inspect_change_commit', { capture: result.change.id, commit: git('rev-parse', 'fixture-tag') }), /commit object/);
    const peerTools = Object.fromEntries(fsTools({ cfg: { ...DEFAULTS, workdir: root, fs: { ...DEFAULTS.fs, roots: [root] } } } as ToolContext).map(t => [t.name, t]));
    await assert.rejects(peerTools.inspect_change_commit!.execute('peer', { capture: result.change.id, commit: git('rev-parse', 'HEAD') }), /capture unavailable/);
    const linked = join(root, 'linked');
    git('worktree', 'add', '-qb', 'fixture-linked', linked);
    const linkedTools = Object.fromEntries(fsTools({ cfg: { ...DEFAULTS, workdir: linked, fs: { ...DEFAULTS.fs, roots: [linked] } } } as ToolContext).map(t => [t.name, t]));
    const linkedChange = (await linkedTools.edit_file!.execute('linked', { path: 'note.md', old: 'after', new: 'linked' })).details.change;
    assert.equal(linkedChange.repository, result.change.repository);
    assert.notEqual(linkedChange.worktree, result.change.worktree);
    const noop = await run('write_file', { path: 'note.md', content: 'after\n' });
    assert.equal(noop.change, undefined);
    const large = await run('write_file', { path: 'big.md', content: 'x'.repeat(20000) });
    assert.equal(large.change.diff.truncated, true);
    assert.equal(large.change.diff.after, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { ZenAgent } from '../src/agent.js';
import { loadConfig } from '../src/config.js';
test('real runtime traces retain successful capture details and no capture on a failed edit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zen-change-trace-'));
  try {
    execFileSync('git', ['-C', root, 'init', '-q']);
    writeFileSync(join(root, 'note.md'), 'before');
    const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('edit_file', { path: 'note.md', old: 'missing', new: 'bad' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('edit_file', { path: 'note.md', old: 'before', new: 'after' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxText('fixture completed')]),
    ]);
    const config = loadConfig({ workdir: root, env: {}, overrides: { model: 'faux/faux-1', tools: ['fs'] } });
    const agent = new ZenAgent({ config, models, env: {}, dispatch: { task_id: 'fixture-ticket' } });
    const result = await agent.run('synthetic instruction');
    const records = readFileSync(result.sessionPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const results = records.filter(r => r.type === 'message' && r.message.role === 'toolResult').map(r => r.message);
    assert.equal(results.length, 2);
    assert.equal(results[0].isError, true); assert.equal(results[0].details?.change, undefined);
    assert.equal(results[1].isError, false); assert.equal(results[1].details.change.path, 'note.md');
    assert.equal(records[0].dispatch.task_id, 'fixture-ticket');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
