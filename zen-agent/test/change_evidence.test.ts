import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync, unlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import nodeFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { DEFAULTS } from '../src/config.js';
import { fsTools } from '../src/tools/fs.js';
import type { ToolContext } from '../src/tools/index.js';

test('observes this path without claiming ownership of the operation, rejects failed edits, and verifies exact commit bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zen-change-'));
  try {
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.com'); // public-ok: synthetic git identity
    writeFileSync(join(root, 'note.md'), 'before\n'); git('add', '.'); git('commit', '-qm', 'fixture');
    const tools = Object.fromEntries(fsTools({ cfg: { ...DEFAULTS, workdir: root, fs: { ...DEFAULTS.fs, roots: [root] } } } as ToolContext).map(t => [t.name, t]));
    const run = async (name: string, args: object) => {
      const details = (await tools[name]!.execute('call', args)).details;
      assert.equal(details.change, undefined);
      if (details.fileObservation) assert.equal(details.fileObservation.ownership, 'unknown');
      return details;
    };
    await assert.rejects(run('edit_file', { path: 'note.md', old: 'absent', new: 'oops' }));
    assert.equal(readFileSync(join(root, 'note.md'), 'utf8'), 'before\n');
    writeFileSync(join(root, 'other.md'), 'another agent\n');
    const result = await run('edit_file', { path: 'note.md', old: 'before', new: 'after' });
    assert.equal(result.fileObservation.path, 'note.md');
    assert.notEqual(result.fileObservation.observedBefore, result.fileObservation.observedAfter);
    assert.deepEqual(result.fileObservation.diff, { format: 'changed-lines', context: 0, redacted: true, truncated: false, hunks: [{ oldStart: 1, newStart: 1, deleted: ['before\n'], added: ['after\n'] }] });
    assert.equal(JSON.stringify(result).includes('another agent'), false);
    await assert.rejects(run('inspect_change_commit', { capture: result.fileObservation.id, commit: git('rev-parse', 'HEAD') }));
    git('add', 'note.md'); git('commit', '-qm', 'change');
    const commit = await run('inspect_change_commit', { capture: result.fileObservation.id, commit: git('rev-parse', 'HEAD') });
    assert.equal(commit.fileObservation.commitMatch.verification, 'local-object');
    assert.equal(commit.fileObservation.id, result.fileObservation.id);
    assert.equal(commit.fileObservation.commitMatch.sha, git('rev-parse', 'HEAD'));
    assert.equal(commit.fileObservation.commitMatch.authorship, 'unknown');
    git('tag', '-a', 'fixture-tag', '-m', 'fixture tag');
    await assert.rejects(run('inspect_change_commit', { capture: result.fileObservation.id, commit: git('rev-parse', 'fixture-tag') }), /commit object/);
    const peerTools = Object.fromEntries(fsTools({ cfg: { ...DEFAULTS, workdir: root, fs: { ...DEFAULTS.fs, roots: [root] } } } as ToolContext).map(t => [t.name, t]));
    await assert.rejects(peerTools.inspect_change_commit!.execute('peer', { capture: result.fileObservation.id, commit: git('rev-parse', 'HEAD') }), /observation unavailable/);
    const linked = join(root, 'linked');
    git('worktree', 'add', '-qb', 'fixture-linked', linked);
    const linkedTools = Object.fromEntries(fsTools({ cfg: { ...DEFAULTS, workdir: linked, fs: { ...DEFAULTS.fs, roots: [linked] } } } as ToolContext).map(t => [t.name, t]));
    const linkedChange = (await linkedTools.edit_file!.execute('linked', { path: 'note.md', old: 'after', new: 'linked' })).details.fileObservation;
    assert.equal(linkedChange.repository, result.fileObservation.repository);
    assert.notEqual(linkedChange.worktree, result.fileObservation.worktree);
    const noop = await run('write_file', { path: 'note.md', content: 'after\n' });
    assert.equal(noop.fileObservation, undefined);
    const empty = await run('write_file', { path: 'empty.md', content: '' });
    assert.equal(empty.fileObservation.observedBefore, null); assert.equal(empty.fileObservation.observedAfter, hash(''));
    assert.deepEqual(empty.fileObservation.diff, { format: 'changed-lines', context: 0, redacted: true, truncated: true, reason: 'empty-change' });
    const large = await run('write_file', { path: 'big.md', content: 'x'.repeat(20000) });
    assert.equal(large.fileObservation.diff.truncated, true);
    assert.equal(large.fileObservation.diff.after, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { ZenAgent } from '../src/agent.js';
import { loadConfig } from '../src/config.js';
import { finishObservation as finishChange, prepareChange, hash } from '../src/tools/change.js';
test('changed-line hunks omit context and redact sensitive deleted and same-line text before persistence', () => {
  const root = mkdtempSync(join(tmpdir(), 'zen-safe-hunks-'));
  try {
    execFileSync('git', ['-C', root, 'init', '-q']);
    const path = join(root, 'note.md');
    const before = 'credential=fixture-untouched-secret\nold public\npassword="fixture-deleted-secret"; const oldFlag = true;\nstable\n';
    const after = 'credential=fixture-untouched-secret\nnew public\npassword="fixture-added-secret"; const newFlag = true;\nstable\n';
    writeFileSync(path, before); const prepared = prepareChange(path);
    writeFileSync(path, after); const capture = finishChange(path, prepared, after)!;
    assert.equal(capture.observedBefore, hash(before)); assert.equal(capture.observedAfter, hash(after));
    assert.deepEqual(capture.diff, { format: 'changed-lines', context: 0, redacted: true, truncated: false,
      hunks: [{ oldStart: 2, newStart: 2, deleted: ['old public\n', '[redacted:sensitive-line]\n'], added: ['new public\n', '[redacted:sensitive-line]\n'] }] });
    for (const literal of ['fixture-untouched-secret', 'fixture-deleted-secret', 'fixture-added-secret', 'stable', 'oldFlag', 'newFlag']) assert.equal(JSON.stringify(capture).includes(literal), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('real runtime traces retain successful capture details and no capture on a failed edit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zen-change-trace-'));
  try {
    execFileSync('git', ['-C', root, 'init', '-q']);
    const credential = 'synthetic-credential-untouched-123456';
    writeFileSync(join(root, 'note.md'), `credential=${credential}\nbefore`);
    const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('edit_file', { path: 'note.md', old: 'missing', new: 'bad' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('edit_file', { path: 'note.md', old: 'before', new: 'after' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxText('fixture completed')]),
    ]);
    const config = loadConfig({ workdir: root, env: {}, overrides: { model: 'faux/faux-1', tools: ['fs'] } });
    const agent = new ZenAgent({ config, models, env: {}, dispatch: { task_id: 'fixture-ticket' } });
    const result = await agent.run('synthetic instruction');
    const jsonl = readFileSync(result.sessionPath, 'utf8');
    assert.equal(jsonl.includes(credential), false);
    const records = jsonl.trim().split('\n').map(line => JSON.parse(line));
    const results = records.filter(r => r.type === 'message' && r.message.role === 'toolResult').map(r => r.message);
    assert.equal(results.length, 2);
    assert.equal(results[0].isError, true); assert.equal(results[0].details?.change, undefined);
    assert.equal(results[1].isError, false); assert.equal(results[1].details.fileObservation.path, 'note.md');
    assert.equal(JSON.stringify(results[1].details).includes(credential), false);
    assert.match(results[1].details.fileObservation.observedBefore, /^[a-f0-9]{64}$/);
    assert.match(results[1].details.fileObservation.observedAfter, /^[a-f0-9]{64}$/);
    assert.notEqual(results[1].details.fileObservation.observedBefore, results[1].details.fileObservation.observedAfter);
    assert.ok(results[1].details.fileObservation.id);
    assert.equal(records[0].dispatch.task_id, 'fixture-ticket');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('content-bearing write/edit arguments persist for resume while sensitive changed lines are redacted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zen-change-content-'));
  try {
    execFileSync('git', ['-C', root, 'init', '-q']);
    const before = 'synthetic-private-write-argument-123456';
    const after = 'synthetic-private-edit-argument-654321';
    const writeArgs = { path: 'note.md', content: `credential=${before}\n` };
    const editArgs = { path: 'note.md', old: before, new: after };
    const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('write_file', writeArgs)], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('edit_file', editArgs)], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxText('fixture completed')]),
    ]);
    const config = loadConfig({ workdir: root, env: {}, overrides: { model: 'faux/faux-1', tools: ['fs'] } });
    const first = new ZenAgent({ config, models, env: {} });
    const result = await first.run('synthetic content-bearing instruction');
    const records = readFileSync(result.sessionPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const calls = records.filter(r => r.type === 'message' && r.message.role === 'assistant')
      .flatMap(r => r.message.content.filter((b: { type: string }) => b.type === 'toolCall'));
    assert.deepEqual(calls.map(c => c.arguments), [writeArgs, editArgs]);
    const traces = records.filter(r => r.type === 'tool');
    assert.deepEqual(traces.map(r => r.args), [writeArgs, editArgs]);
    const results = records.filter(r => r.type === 'message' && r.message.role === 'toolResult');
    assert.equal(results.length, 2);
    for (const record of records) {
      const serialized = JSON.stringify(record);
      if (serialized.includes(before) || serialized.includes(after)) {
        assert.ok(record.type === 'tool' || (record.type === 'message' && record.message.role === 'assistant'));
      }
    }
    for (const record of results) {
      assert.equal(record.message.details.fileObservation.diff.format, 'changed-lines');
      assert.equal(record.message.details.fileObservation.diff.truncated, false);
      assert.match(JSON.stringify(record.message.details.fileObservation.diff.hunks), /redacted:sensitive-line/);
      assert.equal(JSON.stringify(record.message.details.fileObservation).includes(before), false);
      assert.equal(JSON.stringify(record.message.details.fileObservation).includes(after), false);
    }
    const resumed = new ZenAgent({ config, models, env: {}, resume: result.sessionId });
    const resumedCalls = resumed.agent.state.messages.filter(m => m.role === 'assistant')
      .flatMap(m => m.content.filter(b => b.type === 'toolCall'));
    assert.deepEqual(resumedCalls.map(c => c.arguments), [writeArgs, editArgs]);
    faux.setResponses([fauxAssistantMessage([fauxText('resumed with original arguments')])]);
    const continued = await resumed.run('continue synthetic session');
    assert.equal(continued.sessionId, result.sessionId);
    assert.equal(continued.text, 'resumed with original arguments');
    assert.equal(readFileSync(join(root, 'note.md'), 'utf8'), `credential=${after}\n`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import { changedLines } from '../src/tools/changeDiff.js';
test('safe diff bounds fall back without partially retained hunk text', () => {
  const cases = [
    ['x'.repeat(70000), 'input-limit'], ['x\n'.repeat(513), 'line-limit'], ['binary\0bytes', 'binary'],
    ['-----BEGIN PRIVATE KEY-----\nsecret', 'unsafe-text'], ['x'.repeat(5000), 'line-limit'],
    [Array.from({ length: 6 }, (_, i) => String(i).repeat(3000)).join('\n'), 'output-limit'],
  ];
  for (const [content, reason] of cases) assert.deepEqual(changedLines(Buffer.from('before\n'), Buffer.from(content!)), { format: 'changed-lines', context: 0, redacted: true, truncated: true, reason });
  assert.equal(changedLines(null, Buffer.from([0xff])).truncated, true);
  const diff = changedLines(Buffer.from('a\nsame\nb\n'), Buffer.from('A\nsame\nB\n'));
  assert.equal(diff.truncated, false);
  if (!diff.truncated) {
    assert.deepEqual(diff.hunks.map(h => [h.oldStart, h.newStart]), [[1, 1], [3, 3]]);
    assert.equal(JSON.stringify(diff).includes('same'), false);
  }
});

test('known secret environment values redact before persistence, including multiline and plural keys', () => {
  const oldKeys = process.env.FIXTURE_KEYS, oldPassword = process.env.FIXTURE_PASSWORD;
  try {
    process.env.FIXTURE_KEYS = 'fixture-opaque-value-123456';
    const result = changedLines(null, Buffer.from('const value = "fixture-opaque-value-123456";\n'));
    assert.equal(JSON.stringify(changedLines(null, Buffer.from('const value = "fixture-runtime-only-value";'), { FIXTURE_PASS: 'fixture-runtime-only-value' })).includes('fixture-runtime-only-value'), false);
    assert.equal(JSON.stringify(result).includes('fixture-opaque-value-123456'), false);
    process.env.FIXTURE_PASSWORD = 'first-secret-line\ncontinuation-opaque-line';
    assert.deepEqual(changedLines(Buffer.from(process.env.FIXTURE_PASSWORD), Buffer.from('public')), { format: 'changed-lines', context: 0, redacted: true, truncated: true, reason: 'unsafe-text' });
  } finally {
    if (oldKeys === undefined) delete process.env.FIXTURE_KEYS; else process.env.FIXTURE_KEYS = oldKeys;
    if (oldPassword === undefined) delete process.env.FIXTURE_PASSWORD; else process.env.FIXTURE_PASSWORD = oldPassword;
  }
});

test('never attributes dangling or swapped file/parent symlinks to repository bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zen-capture-path-'));
  const outside = mkdtempSync(join(tmpdir(), 'zen-capture-outside-'));
  try {
    execFileSync('git', ['-C', root, 'init', '-q']);
    const tools = Object.fromEntries(fsTools({ cfg: { ...DEFAULTS, workdir: root, fs: { ...DEFAULTS.fs, roots: [root] } } } as ToolContext).map(t => [t.name, t]));
    const target = join(outside, 'missing.md'), link = join(root, 'dangling.md');
    symlinkSync(target, link);
    const result = await tools.write_file!.execute('dangling', { path: 'dangling.md', content: 'outside bytes' });
    assert.equal(result.details.fileObservation, undefined);
    assert.equal(readFileSync(target, 'utf8'), 'outside bytes'); // Write semantics unchanged, capture remains unknown.
    execFileSync('git', ['-C', outside, 'init', '-q']); // Parent escapes must also reject another Git repository.
    const file = join(root, 'swap.md'); writeFileSync(file, 'before');
    const prepared = prepareChange(file)!; assert.ok(prepared);
    unlinkSync(file); symlinkSync(target, file); writeFileSync(file, 'after');
    assert.equal(finishChange(file, prepared, 'after'), null);
    const parent = join(root, 'parent'); mkdirSync(parent);
    const nested = join(parent, 'note.md'); writeFileSync(nested, 'before');
    const prior = prepareChange(nested)!; assert.ok(prior);
    rmSync(parent, { recursive: true }); symlinkSync(outside, parent);
    writeFileSync(nested, 'after'); assert.equal(finishChange(nested, prior, 'after'), null);
    assert.equal(prepareChange(nested), null);
    const absentParent = join(root, 'new-parent', 'note.md'); const pending = prepareChange(absentParent)!; assert.ok(pending);
    symlinkSync(outside, join(root, 'new-parent')); writeFileSync(absentParent, 'after');
    assert.equal(finishChange(absentParent, pending, 'after'), null);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('actual write_file drops capture when a same-inode peer changes bytes after preparation', async t => {
  const root = mkdtempSync(join(tmpdir(), 'zen-write-peer-'));
  const originalMkdir = nodeFs.mkdirSync, originalWrite = nodeFs.writeFileSync;
  try {
    execFileSync('git', ['-C', root, 'init', '-q']);
    const path = join(root, 'note.md'); originalWrite(path, 'observed before\n');
    const inode = nodeFs.statSync(path).ino;
    const tools = Object.fromEntries(fsTools({ cfg: { ...DEFAULTS, workdir: root, fs: { ...DEFAULTS.fs, roots: [root] } } } as ToolContext).map(tool => [tool.name, tool]));
    let injected = false;
    t.mock.method(nodeFs, 'mkdirSync', ((...args: any[]) => {
      const result = Reflect.apply(originalMkdir, nodeFs, args);
      if (!injected && args[0] === root) { injected = true; originalWrite(path, 'peer intervening bytes\n'); }
      return result;
    }) as typeof nodeFs.mkdirSync);
    syncBuiltinESMExports();
    const result = await tools.write_file!.execute('write', { path: 'note.md', content: 'intended after\n' });
    assert.equal(injected, true); assert.equal(nodeFs.statSync(path).ino, inode);
    assert.equal(result.details.fileObservation, undefined);
    assert.equal(readFileSync(path, 'utf8'), 'intended after\n');
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true }); }
});
test('actual edit_file never captures a prepared baseline different from the bytes used for replacement', async t => {
  const root = mkdtempSync(join(tmpdir(), 'zen-edit-peer-'));
  const originalRead = nodeFs.readFileSync, originalWrite = nodeFs.writeFileSync;
  try {
    execFileSync('git', ['-C', root, 'init', '-q']);
    const path = join(root, 'note.md'); originalWrite(path, 'old public\n');
    const inode = nodeFs.statSync(path).ino;
    const tools = Object.fromEntries(fsTools({ cfg: { ...DEFAULTS, workdir: root, fs: { ...DEFAULTS.fs, roots: [root] } } } as ToolContext).map(tool => [tool.name, tool]));
    let injected = false;
    t.mock.method(nodeFs, 'readFileSync', ((...args: any[]) => {
      const result = Reflect.apply(originalRead, nodeFs, args);
      if (!injected && args[0] === path && args[1] === 'utf8') { injected = true; originalWrite(path, 'peer replaces baseline\n'); }
      return result;
    }) as typeof nodeFs.readFileSync);
    syncBuiltinESMExports();
    const result = await tools.edit_file!.execute('edit', { path: 'note.md', old: 'old public', new: 'new public' });
    assert.equal(injected, true); assert.equal(nodeFs.statSync(path).ino, inode);
    assert.equal(result.details.fileObservation, undefined);
    assert.equal(originalRead(path, 'utf8'), 'new public\n');
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true }); }
});

test('real relative and nested writes emit exact request binding outside content-free observation metadata', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zen-capture-request-'));
  try {
    execFileSync('git', ['-C', root, 'init', '-q']);
    mkdirSync(join(root, 'sub'));
    for (const [cwd, path, relativePath] of [[root, './note.md', 'note.md'], [join(root, 'sub'), 'note.md', 'sub/note.md']]) {
      const tools = Object.fromEntries(fsTools({ cfg: { ...DEFAULTS, workdir: cwd!, fs: { ...DEFAULTS.fs, roots: [root] } } } as ToolContext).map(tool => [tool.name, tool]));
      const result = await tools.write_file!.execute('relative', { path: path!, content: 'public changed line\n' });
      assert.equal(result.details.fileObservation.path, relativePath);
      assert.deepEqual(result.details.captureRequest, { path, resolvedPath: join(nodeFs.realpathSync(root), relativePath!) });
      assert.equal(JSON.stringify(result.details.fileObservation).includes('resolvedPath'), false);
      const edited = await tools.edit_file!.execute('relative-edit', { path: path!, old: 'public', new: 'edited' });
      assert.deepEqual(edited.details.captureRequest, result.details.captureRequest);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const initial of [null, 'observed before\n']) test(`after final pre-write check a peer ${initial === null ? 'create' : 'same-inode modification'} never yields a transition capture`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'zen-post-check-peer-'));
  const originalWrite = nodeFs.writeFileSync;
  try {
    execFileSync('git', ['-C', root, 'init', '-q']);
    const path = join(root, 'note.md');
    if (initial !== null) originalWrite(path, initial);
    const tools = Object.fromEntries(fsTools({ cfg: { ...DEFAULTS, workdir: root, fs: { ...DEFAULTS.fs, roots: [root] } } } as ToolContext).map(tool => [tool.name, tool]));
    let injected = false, peerInode: number | undefined;
    t.mock.method(nodeFs, 'writeFileSync', ((...args: any[]) => {
      if (!injected && args[0] === path) {
        injected = true; originalWrite(path, 'peer intervening bytes\n'); peerInode = nodeFs.statSync(path).ino;
      }
      return Reflect.apply(originalWrite, nodeFs, args);
    }) as typeof nodeFs.writeFileSync);
    syncBuiltinESMExports();
    const result = await tools.write_file!.execute('post-check', { path: 'note.md', content: 'intended after\n' });
    assert.equal(injected, true); assert.equal(nodeFs.statSync(path).ino, peerInode);
    assert.equal(result.details.change, undefined);
    assert.equal(result.details.fileObservation.ownership, 'unknown');
    assert.equal(result.details.fileObservation.observedBefore, initial === null ? null : hash(initial));
    assert.equal(result.details.fileObservation.observedAfter, hash('intended after\n'));
    assert.equal(JSON.stringify(result.details.fileObservation).includes('captured-diff'), false);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true }); }
});
