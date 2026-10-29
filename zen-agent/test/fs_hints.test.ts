import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import { fsTools, vaultLayout } from '../src/tools/fs.js';
import type { ToolContext } from '../src/tools/index.js';

/** The failing calls from sol's run of 2026-10-27 (Qwen 35B on the M1), replayed on a small vault. */
function vault() {
  const root = mkdtempSync(join(tmpdir(), 'zen-fs-'));
  writeFileSync(join(root, 'PRIORITIES.md'), '# Priorities\n');
  mkdirSync(join(root, 'CURRENT'));
  writeFileSync(join(root, 'CURRENT', 'todo-master.md'), 'todo\n');
  mkdirSync(join(root, '.hermes/skills/productivity/daily-stand-up/scripts'), { recursive: true });
  writeFileSync(join(root, '.hermes/skills/productivity/daily-stand-up/scripts/standup_context.py'), 'print(1)\n');
  mkdirSync(join(root, '.git'));
  mkdirSync(join(root, '.zen'));
  const cfg = { ...DEFAULTS, workdir: root, vault: root, fs: { ...DEFAULTS.fs, roots: [root] } };
  const ctx = { cfg, persona: null, models: null as never, skills: [], depth: 0, env: {}, fetch } as ToolContext;
  const tools = Object.fromEntries(fsTools(ctx).map((t) => [t.name, t]));
  const run = async (name: string, args: Record<string, unknown>) => {
    const r = await (tools[name] as any).execute('id', args);
    return r.content.map((c: { text: string }) => c.text).join('');
  };
  return { root, run };
}

test('a mistyped file name gets the closest real names back', async () => {
  const { run } = vault();
  await assert.rejects(run('read_file', { path: 'PRIOITIES.md' }), /PRIOITIES\.md does not exist\. Closest names in .*: PRIORITIES\.md/);
});

test('a path with a dropped folder lists the nearest folder that exists', async () => {
  const { run } = vault();
  await assert.rejects(
    run('read_file', { path: '.hermes/skills/productivity/scripts/standup_context.py' }),
    /does not exist\..*daily-stand-up/,
  );
});

test('a guessed folder lists what the vault does have', async () => {
  const { run } = vault();
  await assert.rejects(run('list_dir', { path: '.CLAUDE', all: true }), /does not exist\..*(CURRENT\/|PRIORITIES\.md)/);
});

test('read_file on a folder returns its listing instead of an error', async () => {
  const { run } = vault();
  const out = await run('read_file', { path: 'CURRENT/' });
  assert.match(out, /is a folder, not a file/);
  assert.match(out, /todo-master\.md/);
});

test('edit_file on a missing file says so with the same hint', async () => {
  const { run } = vault();
  await assert.rejects(run('edit_file', { path: 'PRIORITES.md', old: 'a', new: 'b' }), /does not exist\..*PRIORITIES\.md/);
});

test('the vault layout keeps hidden skill folders and drops .git, .zen and caps a long root', async () => {
  const { root } = vault();
  const out = vaultLayout(root);
  assert.match(out, /CURRENT\//);
  assert.match(out, /\.hermes\//);
  assert.doesNotMatch(out, /\.git\/|\.zen\//);
  assert.match(vaultLayout(root, 2), /\(\+\d+ more; list_dir to see them\)/);
});
