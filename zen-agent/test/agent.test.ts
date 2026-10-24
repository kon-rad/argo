import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type Models } from '@earendil-works/pi-ai';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ZenAgent } from '../src/agent.js';
import { loadConfig, type ZenConfig } from '../src/config.js';
import { Session } from '../src/session.js';

function setup(over: Partial<ZenConfig> = {}): { cfg: ZenConfig; faux: ReturnType<typeof fauxProvider>; models: Models; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'zen-agent-'));
  writeFileSync(join(dir, 'AGENTS.md'), '# Rules\nCap output.');
  writeFileSync(join(dir, 'hello.txt'), 'hello\nworld\n');
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const cfg = loadConfig({ workdir: dir, env: {}, overrides: { model: 'faux/faux-1', tools: ['fs', 'shell', 'skills'], ...over } });
  return { cfg, faux, models, dir };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function lines(path: string): any[] {
  return readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

test('a run: tool call, final text, usage, and a complete session trace', async () => {
  const { cfg, faux, models, dir } = setup();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('read_file', { path: 'hello.txt' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxText('The file says hello world.')]),
  ]);
  const events: string[] = [];
  const zen = new ZenAgent({ config: cfg, models, env: {}, onEvent: (e) => events.push(e.type) });
  assert.equal(zen.model.id, 'faux-1');
  assert.deepEqual(zen.tools.map((t) => t.name), ['read_file', 'write_file', 'edit_file', 'list_dir', 'bash']); // no skills dir → no read_skill
  assert.ok(zen.prompt.parts.some((p) => p.name === 'rules'));
  const r = await zen.run('What does hello.txt say?');
  assert.equal(r.stopped, 'done');
  assert.equal(r.text, 'The file says hello world.');
  assert.equal(r.turns, 2);
  assert.ok(r.usage.total > 0);
  assert.ok(events.includes('tool_execution_end'));
  const log = lines(r.sessionPath);
  assert.equal(log[0]!.type, 'meta');
  assert.deepEqual((log[0] as { parts: { name: string }[] }).parts.map((p) => p.name), ['identity', 'rules', 'environment']);
  assert.deepEqual(log.map((l) => l.type), ['meta', 'message', 'message', 'tool', 'message', 'message', 'end']);
  const tool = log.find((l) => l.type === 'tool') as { name: string; args: { path: string }; isError: boolean };
  assert.equal(tool.name, 'read_file');
  assert.equal(tool.args.path, 'hello.txt');
  assert.equal(tool.isError, false);
  assert.equal((log.at(-1) as { stopped: string }).stopped, 'done');
  assert.ok(r.sessionPath.startsWith(join(dir, '.zen', 'sessions')));
  assert.deepEqual(Session.list(cfg.sessionsDir), [r.sessionId]);
});

test('the guard blocks a secrets read in process and the model is told why', async () => {
  const { cfg, faux, models } = setup();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('bash', { command: 'cat .env' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxText('I cannot read that.')]),
  ]);
  const zen = new ZenAgent({ config: { ...cfg, guard: { ...cfg.guard, log: null } }, models, env: {} });
  const r = await zen.run('print the env');
  assert.equal(r.text, 'I cannot read that.');
  const log = lines(r.sessionPath);
  const blocked = log.find((l) => l.type === 'blocked') as { reason: string };
  assert.match(blocked.reason, /^guard: that would print or copy a secrets file/);
  const result = (log.filter((l) => l.type === 'message').map((l) => l['message']) as { role: string; isError?: boolean; content: { text: string }[] }[]).find((m) => m.role === 'toolResult')!;
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /guard:/);
});

test('a pre-tool-use hook command blocks too, in the Claude Code contract', async () => {
  const { cfg, faux, models, dir } = setup();
  const hook = join(dir, 'hook.sh');
  writeFileSync(hook, '#!/bin/sh\npayload=$(cat)\ncase "$payload" in *forbidden*) echo "hook: no forbidden words" >&2; exit 2;; esac\nexit 0\n');
  chmodSync(hook, 0o755);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('bash', { command: 'echo forbidden' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxToolCall('bash', { command: 'echo fine' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxText('ok')]),
  ]);
  const zen = new ZenAgent({ config: { ...cfg, guard: { ...cfg.guard, log: null, hooks: { preToolUse: [hook], stop: [] } } }, models, env: {} });
  const r = await zen.run('go');
  const log = lines(r.sessionPath);
  assert.equal((log.find((l) => l.type === 'blocked') as { reason: string }).reason, 'hook: no forbidden words');
  const tools = log.filter((l) => l.type === 'tool') as { args: { command: string }; isError: boolean }[];
  assert.deepEqual(tools.map((t) => [t.args.command, t.isError]), [['echo forbidden', true], ['echo fine', false]]);
});

test('the budget ends the run and says so', async () => {
  const { cfg, faux, models } = setup();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('bash', { command: 'echo 1' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxToolCall('bash', { command: 'echo 2' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxText('never reached')]),
  ]);
  const zen = new ZenAgent({ config: cfg, models, env: {}, budget: { turns: 2 } });
  const r = await zen.run('count');
  assert.equal(r.stopped, 'budget');
  assert.equal(r.turns, 2);
  assert.equal(r.text, '');
  assert.equal(faux.getPendingResponseCount(), 1);
  const byTokens = new ZenAgent({ config: cfg, models, env: {}, budget: { tokens: 1 } });
  faux.setResponses([fauxAssistantMessage([fauxToolCall('bash', { command: 'echo 1' })], { stopReason: 'toolUse' }), fauxAssistantMessage([fauxText('x')])]);
  assert.equal((await byTokens.run('count')).stopped, 'budget');
});

test('a stop hook sends the agent back exactly once', async () => {
  const { cfg, faux, models, dir } = setup();
  const gate = join(dir, 'gate.sh');
  writeFileSync(gate, '#!/bin/sh\npayload=$(cat)\ncase "$payload" in *\'"stop_hook_active":true\'*) exit 0;; esac\ncase "$payload" in *transcript_path*) ;; *) echo "no transcript" >&2; exit 2;; esac\necho "gate: write the dev log first" >&2\nexit 2\n');
  chmodSync(gate, 0o755);
  faux.setResponses([fauxAssistantMessage([fauxText('done')]), fauxAssistantMessage([fauxText('dev log written')])]);
  const zen = new ZenAgent({ config: { ...cfg, guard: { ...cfg.guard, hooks: { preToolUse: [], stop: [gate] } } }, models, env: {} });
  const r = await zen.run('do it');
  assert.equal(r.text, 'dev log written');
  const msgs = lines(r.sessionPath).filter((l) => l.type === 'message').map((l) => l['message'] as { role: string; content: unknown });
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  const nudge = msgs[2]!.content as string | { text: string }[];
  assert.equal(typeof nudge === 'string' ? nudge : nudge[0]!.text, 'gate: write the dev log first');
  assert.equal(faux.getPendingResponseCount(), 0);
});

test('compaction summarises old turns when the transcript passes the cap', async () => {
  const { cfg, faux, models } = setup({ context: { cap: 0.0005, keepTurns: 1, parts: {}, fetchers: {} } }); // 64 tokens of a 128k window
  faux.setResponses([fauxAssistantMessage([fauxText('one '.repeat(100))]), fauxAssistantMessage([fauxText('two')]), fauxAssistantMessage([fauxText('three')])]);
  const zen = new ZenAgent({ config: cfg, models, env: {}, summarize: async () => 'SUMMARY OF EARLIER TURNS' });
  await zen.run('first');
  await zen.run('second');
  const r = await zen.run('third');
  assert.equal(r.text, 'three');
  const log = lines(r.sessionPath);
  const comp = log.find((l) => l.type === 'compaction') as { before: number; after: number; dropped: number };
  assert.ok(comp, 'a compaction was recorded');
  assert.ok(comp.after < comp.before);
  const roles = zen.agent.state.messages.map((m) => (m as { role: string }).role);
  assert.equal(roles[0], 'system');
  assert.ok(zen.agent.state.messages.some((m) => String((m as { content: unknown }).content).includes('SUMMARY OF EARLIER TURNS')));
});

test('resume replays an earlier session', async () => {
  const { cfg, faux, models } = setup();
  faux.setResponses([fauxAssistantMessage([fauxText('remembered: 42')])]);
  const first = new ZenAgent({ config: cfg, models, env: {} });
  const r1 = await first.run('remember 42');
  faux.setResponses([fauxAssistantMessage([fauxText('it was 42')])]);
  const second = new ZenAgent({ config: cfg, models, env: {}, resume: r1.sessionId });
  assert.equal(second.agent.state.messages.length, 3); // system, user, assistant
  const r2 = await second.run('what was it?');
  assert.equal(r2.text, 'it was 42');
  assert.equal(r2.sessionId, r1.sessionId);
});

test('a persona picks its model and the skills it can read', async () => {
  const { cfg, faux, models, dir } = setup();
  mkdirSync(join(dir, '.agents', 'org'), { recursive: true });
  mkdirSync(join(dir, '.agents', 'skills', 'greet'), { recursive: true });
  writeFileSync(join(dir, '.agents', 'skills', 'greet', 'SKILL.md'), '---\nname: greet\ndescription: Say hello properly.\n---\nAlways say hello twice.\n');
  writeFileSync(join(dir, '.agents', 'org', 'org.json'), JSON.stringify({ agents: { bolt: { role: 'engineer', team: 'eng', model: 'faux/faux-1' } }, teams: { eng: { name: 'Eng', lead: 'bolt' } } }));
  faux.setResponses([fauxAssistantMessage([fauxToolCall('read_skill', { name: 'greet' })], { stopReason: 'toolUse' }), fauxAssistantMessage([fauxText('hello hello')])]);
  const zen = new ZenAgent({ config: { ...cfg, model: 'nope/nothing' }, persona: 'bolt', models, env: {} });
  assert.equal(zen.persona?.name, 'bolt');
  assert.match(zen.prompt.prompt, /^You are bolt, engineer on team Eng\. You lead the team\./);
  assert.match(zen.prompt.prompt, /- greet: Say hello properly\./);
  const r = await zen.run('greet');
  assert.equal(r.text, 'hello hello');
  const tool = lines(r.sessionPath).find((l) => l.type === 'tool') as { name: string; isError: boolean };
  assert.deepEqual([tool.name, tool.isError], ['read_skill', false]);
  assert.match(r.sessionId, /^bolt-/);
});

test('delegate runs a child with its own session and returns its report', async () => {
  const { cfg, faux, models } = setup({ tools: ['fs', 'subagent'] });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('delegate', { objective: 'count the lines of hello.txt', turns: 3 })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxText('two lines')]), // the child's answer
    fauxAssistantMessage([fauxText('The child says: two lines')]),
  ]);
  const zen = new ZenAgent({ config: cfg, models, env: {} });
  const r = await zen.run('how long is hello.txt?');
  assert.equal(r.text, 'The child says: two lines');
  const sessions = Session.list(cfg.sessionsDir);
  assert.equal(sessions.length, 2);
  const child = sessions.find((s) => s !== r.sessionId)!;
  const meta = Session.load(cfg.sessionsDir, child).meta as unknown as { parent: string; tools: string[] };
  assert.equal(meta.parent, r.sessionId);
  assert.ok(!meta.tools.includes('delegate'), 'a child cannot delegate');
});
