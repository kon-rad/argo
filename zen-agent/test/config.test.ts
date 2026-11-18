import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig, parseBudgetLine } from '../src/config.js';
import { cardBudget } from '../src/wake.js';

test('defaults resolve against the working directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zen-cfg-'));
  const cfg = loadConfig({ workdir: dir, env: {} });
  assert.equal(cfg.workdir, dir);
  assert.equal(cfg.vault, dir);
  assert.equal(cfg.sessionsDir, join(dir, '.zen', 'sessions'));
  assert.deepEqual(cfg.rules, [join(dir, 'AGENTS.md')]);
  assert.equal(cfg.persona.org, join(dir, '.agents', 'org', 'org.json'));
  assert.deepEqual(cfg.fs.roots, [dir, dir]);
  assert.equal(cfg.kanban.kind, 'none');
});

test('zen.json merges deeply, the environment picks the model, flags win', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zen-cfg-'));
  mkdirSync(join(dir, 'vault'));
  writeFileSync(
    join(dir, 'zen.json'),
    JSON.stringify({
      model: 'openai/gpt-5.2',
      vault: 'vault',
      budget: { turns: 5 },
      context: { parts: { rules: 10 } },
      kanban: { kind: 'board', url: 'http://127.0.0.1:5123', tokenEnv: 'BOARD_TOKEN', board: 'exo' },
      providers: { ollama: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:11434/v1', models: [{ id: 'qwen3:8b' }] } },
    }),
  );
  const cfg = loadConfig({ workdir: dir, env: { ZEN_MODEL: 'together/x' } });
  assert.equal(cfg.model, 'together/x');
  assert.equal(cfg.vault, join(dir, 'vault'));
  assert.deepEqual(cfg.budget, { turns: 5, tokens: 400_000, minutes: 30 });
  assert.equal(cfg.context.parts['rules'], 10);
  assert.equal(cfg.context.parts['persona'], 3000);
  assert.equal(cfg.rules[0], join(dir, 'vault', 'AGENTS.md'));
  assert.equal(cfg.kanban.kind, 'board');
  assert.ok(cfg.providers['ollama']);
  const over = loadConfig({ workdir: dir, env: { ZEN_MODEL: 'together/x' }, overrides: { model: 'faux/faux-1' } });
  assert.equal(over.model, 'faux/faux-1');
});

test('a broken zen.json is an error, not a silent default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zen-cfg-'));
  writeFileSync(join(dir, 'zen.json'), '{ nope');
  assert.throws(() => loadConfig({ workdir: dir, env: {} }), /zen config/);
});

test('budget lines from a card contract', () => {
  assert.deepEqual(parseBudgetLine('turns: 30 · tokens: 300000 · wakes: 3'), { turns: 30, tokens: 300000 });
  assert.deepEqual(parseBudgetLine('turns=12, tokens 1_000_000, minutes: 5'), { turns: 12, tokens: 1_000_000, minutes: 5 });
  assert.deepEqual(cardBudget('## Objective\nShip it.\n## Budget\nturns: 8 · tokens: 50000\n## Scope\nall'), { turns: 8, tokens: 50000 });
  assert.deepEqual(cardBudget('no contract here'), {});
  assert.deepEqual(cardBudget(null), {});
});

for (const [label, managedSkills] of [
  ['missing root', {}],
  ['numeric root', {root:42}],
  ['empty root', {root:''}],
  ['whitespace root', {root:'  \t'}],
  ['array', []],
  ['string', 'managed'],
  ['false', false],
  ['true', true],
  ['numeric', 42],
  ['string enforce', {root:'managed',enforce:'false'}],
  ['numeric enforce', {root:'managed',enforce:0}],
  ['null enforce', {root:'managed',enforce:null}],
  ['numeric snapshots', {root:'managed',snapshots:42}],
  ['empty snapshots', {root:'managed',snapshots:''}],
  ['whitespace snapshots', {root:'managed',snapshots:' \n '}],
  ['false snapshots', {root:'managed',snapshots:false}],
] as const) test(`malformed managed skills config fails closed: ${label}`, () => {
  const dir=mkdtempSync(join(tmpdir(),'zen-managed-config-'));
  writeFileSync(join(dir,'zen.json'),JSON.stringify({managedSkills}));
  assert.throws(()=>loadConfig({workdir:dir,env:{}}),/zen config managedSkills/);
});

test('managed skills accepts deliberate legacy configuration and normalizes valid paths', () => {
  const dir=mkdtempSync(join(tmpdir(),'zen-managed-config-'));
  const file=join(dir,'zen.json');
  assert.equal(loadConfig({workdir:dir,env:{}}).managedSkills,null);
  writeFileSync(file,JSON.stringify({managedSkills:null}));
  assert.equal(loadConfig({workdir:dir,env:{}}).managedSkills,null);
  writeFileSync(file,JSON.stringify({vault:'vault',managedSkills:{root:'./cache/../managed',snapshots:'./traces/../snapshots',enforce:true}}));
  assert.deepEqual(loadConfig({workdir:dir,env:{}}).managedSkills,{root:join(dir,'vault','managed'),snapshots:join(dir,'vault','snapshots'),enforce:true});
  writeFileSync(file,JSON.stringify({managedSkills:{root:'managed'}}));
  assert.deepEqual(loadConfig({workdir:dir,env:{}}).managedSkills,{root:join(dir,'managed'),snapshots:null,enforce:false});
  writeFileSync(file,JSON.stringify({managedSkills:{root:'managed',snapshots:null,enforce:false}}));
  assert.deepEqual(loadConfig({workdir:dir,env:{}}).managedSkills,{root:join(dir,'managed'),snapshots:null,enforce:false});
  assert.equal(loadConfig({workdir:dir,env:{},overrides:{managedSkills:null}}).managedSkills,null);
  assert.throws(()=>loadConfig({workdir:dir,env:{},overrides:{managedSkills:false as any}}),/zen config managedSkills/);
});
