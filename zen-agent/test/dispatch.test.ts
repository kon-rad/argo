import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from '@earendil-works/pi-ai';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ZenAgent } from '../src/agent.js';
import { parseMeta, parseThinking, parseTools, runOptions } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { buildSystemPrompt } from '../src/context.js';
import { buildModels } from '../src/models.js';
import { refreshMachines } from '../src/machines.js';

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
  assert.equal(meta['entrypoint'], null); // not told how it was started: says so, never guesses
});

for (const entrypoint of ['chat', 'run', 'wake', 'serve', 'subagent'] as const) {
  test(`serializes an explicit ${entrypoint} label and catalogue context`, async () => {
    const { cfg, faux, models } = setup();
    faux.setResponses([fauxAssistantMessage([fauxText('ok')])]);
    const zen = new ZenAgent({ config: cfg, models, env: {}, entrypoint });
    const r = await zen.run('hi');
    const meta = JSON.parse(readFileSync(r.sessionPath, 'utf8').split('\n')[0]!) as Record<string, unknown>;
    assert.equal(meta['entrypoint'], entrypoint);
    assert.equal(meta['context_window'], zen.model.contextWindow);
    assert.ok(typeof meta['context_window'] === 'number' && meta['context_window'] > 0);
  });
}

for (const capacity of [0, -1, NaN, Infinity, undefined]) {
  test(`an invalid or missing catalogue capacity (${capacity}) stays unknown`, () => {
    const { cfg, models } = setup();
    const model = models.getModel('faux', 'faux-1')!;
    const previous = model.contextWindow;
    try {
      Object.assign(model, { contextWindow: capacity });
      const zen = new ZenAgent({ config: cfg, models, env: {} });
      const meta = JSON.parse(readFileSync(zen.session.path, 'utf8').split('\n')[0]!) as Record<string, unknown>;
      assert.equal(meta['context_window'], null);
      assert.equal(meta['entrypoint'], null);
    } finally {
      model.contextWindow = previous;
    }
  });
}

for (const [mode, capacity] of [['run', 4096], ['chat', 4096], ['run', undefined]] as const) {
  test(`the compiled CLI ${mode} producer persists its real entrypoint and ${capacity ?? 'unknown'} model window`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'zen-cli-provenance-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const requests: { path: string | undefined; model: unknown; authorization: string | undefined }[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => { body += chunk; });
      req.on('end', () => {
        let input: { model?: unknown };
        try { input = JSON.parse(body) as { model?: unknown }; }
        catch { res.writeHead(400).end(); return; }
        requests.push({ path: req.url, model: input.model, authorization: req.headers.authorization });
        const chunk = (delta: object, finish: string | null, usage?: object) => ({
          id: 'fixture-completion', object: 'chat.completion.chunk', created: 0, model: 'fixture-model',
          choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}),
        });
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'fixture answer' }, null))}\n\n`
          + `data: ${JSON.stringify(chunk({}, 'stop', { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 }))}\n\n`
          + 'data: [DONE]\n\n');
      });
    });
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const config = join(dir, 'zen.json');
    writeFileSync(config, JSON.stringify({
      model: 'fixture/fixture-model', sessionsDir: 'sessions', tools: [], skills: [], rules: [],
      guard: { local: null, log: null, hooks: { preToolUse: [], stop: [] } },
      providers: { fixture: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKeyEnv: 'ZEN_TEST_PROVIDER_KEY', models: [{ id: 'fixture-model', ...(capacity === undefined ? {} : { contextWindow: capacity }), maxTokens: 128 }] } },
    }));
    const catalogue = buildModels(loadConfig({ workdir: dir, path: config, env: {} }));
    assert.equal(catalogue.getModel('fixture', 'fixture-model')?.contextWindow, capacity ?? 128_000, 'runtime planning fallback remains intact');
    const args = [fileURLToPath(new URL('../src/cli.js', import.meta.url)), mode,
      ...(mode === 'run' ? ['hello', '--json'] : []), '--config', config, '--workdir', dir];
    const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child = execFile(process.execPath, args, { cwd: dir, encoding: 'utf8', timeout: 15_000, maxBuffer: 100_000,
        env: { PATH: process.env['PATH'] ?? '', HOME: dir, ZEN_TEST_PROVIDER_KEY: 'synthetic-test-key' } },
      (error, stdout, stderr) => error ? reject(new Error(`CLI ${mode} failed: ${error.message}; ${stderr.slice(0, 1000)}`)) : resolve({ stdout, stderr }));
      child.stdin?.on('error', () => {}); // A failed child is reported by its completion callback.
      child.stdin?.end(mode === 'chat' ? '/quit\n' : '');
    });
    const files = readdirSync(join(dir, 'sessions')).filter((name) => name.endsWith('.jsonl'));
    assert.equal(files.length, 1);
    const trace = readFileSync(join(dir, 'sessions', files[0]!), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(trace[0].entrypoint, mode);
    assert.equal(trace[0].model, 'fixture/fixture-model');
    assert.equal(trace[0].context_window, capacity ?? null);
    if (mode === 'run') {
      const run = JSON.parse(result.stdout) as { text: string; error?: string; stopped: string };
      assert.equal(run.text, 'fixture answer');
      assert.equal(run.error, undefined);
      assert.equal(run.stopped, 'done');
      assert.deepEqual(requests, [{ path: '/v1/chat/completions', model: 'fixture-model', authorization: 'Bearer synthetic-test-key' }]);
      assert.equal(trace.at(-1)?.type, 'end');
    } else {
      assert.equal(requests.length, 0, 'chat startup and quit do not call a model');
      assert.equal(trace.length, 1, 'chat still records its actual startup before the first prompt');
    }
    t.diagnostic(JSON.stringify({ producer: 'compiled-cli', entrypoint: trace[0].entrypoint,
      model: trace[0].model, context_window: trace[0].context_window, requests: requests.length }));
  });
}


for (const capacity of [undefined, 16_384]) {
  test(`machine factory records ${capacity ?? 'unknown'} capacity across cached refresh`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'zen-machine-provenance-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const models = createModels();
    const known = new Map();
    const machines = { fixture: { url: 'http://192.0.2.10:11434', ...(capacity === undefined ? {} : { contextWindow: capacity }) } };
    const discovery = (async (input: string | URL | Request) => String(input).endsWith('/api/tags')
      ? Response.json({ models: [{ name: 'fixture-model' }] })
      : Response.json({ capabilities: ['completion', 'tools'], model_info: { 'general.architecture': 'fixture', 'fixture.context_length': 65_536 } })) as typeof fetch;
    const config = loadConfig({ workdir: dir, env: {}, overrides: { model: 'ollama-fixture/fixture-model', tools: [] } });
    const check = (expected: number | null) => {
      const agent = new ZenAgent({ config, models, env: {}, entrypoint: 'serve' });
      assert.equal(agent.model.contextWindow, capacity ?? 32_000, 'discovery/cache keeps runtime capacity');
      const meta = JSON.parse(readFileSync(agent.session.path, 'utf8').split('\n')[0]!);
      assert.equal(meta.context_window, expected);
      assert.equal(meta.entrypoint, 'serve');
    };
    await refreshMachines(models, machines, known, discovery);
    check(capacity ?? null);
    const unreachable = (async () => { throw new Error('fixture offline'); }) as typeof fetch;
    await refreshMachines(models, machines, known, unreachable);
    check(capacity ?? null);
    await refreshMachines(models, { fixture: { ...machines.fixture, contextWindow: 8192 } }, known, unreachable);
    check(null); // Changing a setting cannot prove that an unreachable server adopted it.
  });
}

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

test('--model reaches the run options, so it beats a persona\'s own model', () => {
  assert.equal(runOptions({ model: 'openrouter/deepseek/deepseek-v4.1-flash' } as never).model, 'openrouter/deepseek/deepseek-v4.1-flash');
  assert.equal(runOptions({} as never).model, undefined);
});
