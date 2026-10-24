import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from '@earendil-works/pi-ai';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ZenAgent } from '../src/agent.js';
import { parseMeta, parseThinking, parseTools } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { buildSystemPrompt } from '../src/context.js';

// What a dispatcher needs from a run (docs/zen-runtime.md, section 8): labels in the trace, a handoff part
// instead of a resumed transcript, the tool sets and thinking level per run, and the model and part sizes
// in the --json result.

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'zen-dispatch-'));
  writeFileSync(join(dir, 'AGENTS.md'), '# Rules\nCap output.');
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const cfg = loadConfig({ workdir: dir, env: {}, overrides: { model: 'faux/faux-1', tools: ['fs', 'shell'] } });
  return { cfg, faux, models, dir };
}

test('the handoff part sits before the task with its own cap, and is recorded like every part', () => {
  const a = buildSystemPrompt({
    persona: null, rulesFiles: [], skills: [], caps: { handoff: 500, task: 4000 }, environment: { date: '2026-01-01' },
    handoff: 'Previous run: posted the brief, ended done.', task: 'Standing orders.',
  });
  assert.deepEqual(a.parts.map((p) => p.name), ['identity', 'handoff', 'task', 'environment']);
  assert.match(a.prompt, /<handoff>\nPrevious run: posted the brief, ended done\.\n<\/handoff>\n\n<task>/);
  const small = buildSystemPrompt({ persona: null, rulesFiles: [], skills: [], caps: { handoff: 5 }, environment: {}, handoff: 'word '.repeat(100) });
  assert.equal(small.parts.find((p) => p.name === 'handoff')!.truncated, true);
});

test('the default handoff cap is 500 tokens', () => {
  const cfg = loadConfig({ workdir: mkdtempSync(join(tmpdir(), 'zen-cap-')), env: {} });
  assert.equal(cfg.context.parts['handoff'], 500);
});

test('dispatch labels, the format version, the tool sets and the thinking level land in the run and its trace', async () => {
  const { cfg, faux, models } = setup();
  faux.setResponses([fauxAssistantMessage([fauxText('Nothing to do.')])]);
  const zen = new ZenAgent({
    config: cfg, models, env: {},
    toolSets: ['fs'], thinking: 'low', handoff: 'Last run ended with budget after 3 turns.',
    dispatch: { run_id: 'r-1', reasons: [{ reason: 'dm', ref: '42' }], tier: 'flash-low' },
  });
  assert.deepEqual(zen.tools.map((t) => t.name), ['read_file', 'write_file', 'edit_file', 'list_dir']); // --tools fs: no bash
  assert.equal(zen.agent.state.thinkingLevel, 'low');
  const r = await zen.run('Anything for me?');
  assert.equal(r.model, 'faux/faux-1');
  assert.deepEqual(r.parts.map((p) => p.name), ['identity', 'rules', 'handoff', 'environment']);
  const meta = JSON.parse(readFileSync(r.sessionPath, 'utf8').split('\n')[0]!) as Record<string, unknown>;
  assert.equal(meta['version'], 1);
  assert.deepEqual(meta['dispatch'], { run_id: 'r-1', reasons: [{ reason: 'dm', ref: '42' }], tier: 'flash-low' });
  assert.deepEqual(meta['tools'], ['read_file', 'write_file', 'edit_file', 'list_dir']);
  assert.deepEqual((meta['parts'] as { name: string }[]).map((p) => p.name), r.parts.map((p) => p.name));
});

test('a run without dispatcher flags has an empty dispatch object, not a missing one', async () => {
  const { cfg, faux, models } = setup();
  faux.setResponses([fauxAssistantMessage([fauxText('ok')])]);
  const r = await new ZenAgent({ config: cfg, models, env: {} }).run('hi');
  const meta = JSON.parse(readFileSync(r.sessionPath, 'utf8').split('\n')[0]!) as Record<string, unknown>;
  assert.deepEqual(meta['dispatch'], {});
  assert.equal(meta['version'], 1);
});

test('the CLI parsers: --meta pairs over --meta-json, thinking levels, tool lists', () => {
  assert.deepEqual(parseMeta(['run_id=r-1', 'note=a=b'], '{"tier":"mid","run_id":"old"}'), { tier: 'mid', run_id: 'r-1', note: 'a=b' });
  assert.deepEqual(parseMeta(), {});
  assert.throws(() => parseMeta(['novalue']), /key=value/);
  assert.throws(() => parseMeta([], '[1]'), /JSON object/);
  assert.equal(parseThinking('high'), 'high');
  assert.equal(parseThinking(undefined), undefined);
  assert.throws(() => parseThinking('lots'), /--thinking must be one of/);
  assert.deepEqual(parseTools('fs, org,,'), ['fs', 'org']);
  assert.equal(parseTools(undefined), undefined);
  assert.throws(() => parseTools(','), /comma list/);
});
