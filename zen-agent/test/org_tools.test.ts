import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import type { ToolContext } from '../src/tools/index.js';
import { orgTools } from '../src/tools/org.js';

const ctx = (over: Partial<ToolContext> = {}): ToolContext =>
  ({ cfg: DEFAULTS, persona: { name: 'rune' } as never, models: null as never, skills: [], depth: 0, env: {}, fetch, ...over });

const remember = (calls: string[][]) => {
  const tools = orgTools(ctx(), async (args) => {
    calls.push(args);
    return '{}';
  });
  return tools.find((t) => t.name === 'org_remember')!;
};

test('org_remember passes --agent so a bot can save its own memory, and omits it for a company-wide fact', async () => {
  const calls: string[][] = [];
  const t = remember(calls);
  await t.execute('c1', { subject: 'Board exo', claim: 'The board is Postgres on the droplet.', source: 'episode:7', agent: 'rune' }, undefined);
  assert.deepEqual(calls[0], ['remember', 'Board exo', 'The board is Postgres on the droplet.', '--source', 'episode:7', '--agent', 'rune', '--json']);

  await t.execute('c2', { subject: 'S', claim: 'C', source: 'path/to/note.md' }, undefined);
  assert.deepEqual(calls[1], ['remember', 'S', 'C', '--source', 'path/to/note.md', '--json']);
  assert.ok(!calls[1]!.includes('--agent'));
});
