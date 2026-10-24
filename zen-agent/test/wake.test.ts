import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type Models } from '@earendil-works/pi-ai';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { ZenAgent } from '../src/agent.js';
import { loadConfig, type ZenConfig } from '../src/config.js';
import { cardMeta, fetchParts, fetchersFor, type Exec } from '../src/fetchers.js';
import { loadPersona } from '../src/persona.js';
import { Session } from '../src/session.js';
import type { Card, CardDetail, KanbanBackend } from '../src/tools/kanban.js';
import { runWake, wakeContext, wakePrompt } from '../src/wake.js';

/**
 * The contract of an org wake: every wake is a fresh run; a reply wake carries exactly the thread it answers; the
 * configured fetchers bring their one source each into a capped part; the trace says what happened.
 */

function setup(over: Partial<ZenConfig> = {}): { cfg: ZenConfig; faux: ReturnType<typeof fauxProvider>; models: Models; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'zen-wake-'));
  writeFileSync(join(dir, 'AGENTS.md'), '# Rules\nCap output.');
  mkdirSync(join(dir, '.agents', 'org'), { recursive: true });
  writeFileSync(join(dir, '.agents', 'org', 'org.json'), JSON.stringify({ agents: { bolt: { role: 'engineer', team: 'eng' }, sage: { role: 'researcher', team: 'research' } }, teams: { eng: { name: 'Eng', lead: 'bolt' }, research: { name: 'Research', lead: 'sage' } } }));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const cfg = loadConfig({ workdir: dir, env: {}, overrides: { model: 'faux/faux-1', tools: ['fs'], ...over } });
  return { cfg, faux, models, dir };
}

function card(id: string, title: string, body: string, extra: Partial<Card> = {}): CardDetail {
  return { task: { id, title, body, assignee: 'bolt', status: 'running', created_by: 'owner', created_at: 1_760_000_000, ...extra }, comments: [] };
}

/** A board that only shows cards; `complete` is there so the wake prompt asks for card_complete. */
function fakeBoard(cards: CardDetail[]): KanbanBackend & { shown: string[] } {
  const shown: string[] = [];
  return {
    kind: 'board',
    board: 'exo',
    shown,
    list: async () => cards.map((c) => c.task),
    show: async (id) => {
      shown.push(id);
      const c = cards.find((x) => x.task.id === id);
      if (!c) throw new Error(`no card ${id}`);
      return c;
    },
    create: async () => { throw new Error('not here'); },
    comment: async () => {},
    assign: async () => {},
    complete: async () => {},
    block: async () => {},
  };
}

/** A fake command runner: records every call and answers from a table keyed by `<command> <first args>`. */
function fakeExec(table: Record<string, string | ((args: string[]) => string)>): { exec: Exec; calls: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] } {
  const calls: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const exec: Exec = async (command, args, env) => {
    calls.push({ command, args, env });
    for (const [key, v] of Object.entries(table)) {
      const [cmd, ...head] = key.split(' ');
      if (command === cmd && head.every((h, i) => args[i] === h)) return typeof v === 'function' ? v(args) : v;
    }
    throw new Error(`${command} ${args.join(' ')}: no such command in this test`);
  };
  return { exec, calls };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function lines(path: string): any[] {
  return readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

function messageTexts(path: string): string {
  return lines(path)
    .filter((l) => l.type === 'message')
    .map((l) => JSON.stringify(l.message))
    .join('\n');
}

test('two wakes of one persona on unrelated cards are two sessions with nothing in common', async () => {
  const { cfg, faux, models } = setup();
  const kb = fakeBoard([
    card('t_aaaaaa', 'Fix the login redirect', 'Project: app/login\n## Objective\nRedirect after login.'),
    card('t_bbbbbb', 'Write the pricing page', 'Project: site/pricing\n## Objective\nA pricing page.'),
  ]);
  const { exec, calls } = fakeExec({});
  faux.setResponses([fauxAssistantMessage([fauxText('login redirect fixed')])]);
  const first = await runWake({ cfg, kb, cardId: 't_aaaaaa', persona: 'bolt', models, env: {}, exec });
  faux.setResponses([fauxAssistantMessage([fauxText('pricing page written')])]);
  const second = await runWake({ cfg, kb, cardId: 't_bbbbbb', persona: 'bolt', models, env: {}, exec });

  assert.notEqual(first.sessionId, second.sessionId);
  assert.deepEqual(Session.list(cfg.sessionsDir).sort(), [first.sessionId, second.sessionId].sort());
  const m1 = messageTexts(first.sessionPath);
  const m2 = messageTexts(second.sessionPath);
  assert.match(m1, /t_aaaaaa/);
  assert.doesNotMatch(m1, /t_bbbbbb|pricing/);
  assert.match(m2, /t_bbbbbb/);
  assert.doesNotMatch(m2, /t_aaaaaa|login redirect/);
  for (const r of [first, second]) {
    const meta = lines(r.sessionPath)[0] as { resumed: string | null; persona: string; fetchers: { on: boolean }[] };
    assert.equal(meta.resumed, null, 'a wake never resumes');
    assert.equal(meta.persona, 'bolt');
    assert.ok(meta.fetchers.every((f) => !f.on), 'no fetcher is on unless configured');
    assert.equal(lines(r.sessionPath).filter((l) => l.type === 'message' && l.message.role === 'user').length, 1, 'one user turn: the card');
  }
  assert.equal(calls.length, 0, 'no fetcher ran: nothing configured, no thread');
  assert.match(m1, /This run starts fresh/);
  assert.deepEqual(kb.shown, ['t_aaaaaa', 't_bbbbbb']);
});

test('a DM wake carries exactly the thread it answers, and nothing else of the board', async () => {
  const { cfg, faux, models } = setup();
  const thread = [
    { id: 41, channel_slug: 'dm-bolt-sage', thread_id: null, author: 'sage', kind: 'message', body: 'Can you check the login redirect on staging?', created_at: '2026-10-24T09:00:00.000Z' },
    { id: 44, channel_slug: 'dm-bolt-sage', thread_id: 41, author: 'bolt', kind: 'reply', body: 'On it after lunch.', created_at: '2026-10-24T09:05:00.000Z' },
    { id: 47, channel_slug: 'dm-bolt-sage', thread_id: 41, author: 'sage', kind: 'reply', body: 'Any news?', created_at: '2026-10-24T14:00:00.000Z' },
  ];
  const { exec, calls } = fakeExec({
    'cli-org thread 47': JSON.stringify(thread),
    'cli-org read': JSON.stringify([{ id: 99, channel_slug: 'eng', author: 'owner', kind: 'message', body: 'UNRELATED CHANNEL MESSAGE', created_at: '2026-10-24T10:00:00.000Z' }]),
  });
  const persona = loadPersona(cfg, 'bolt');
  const ctx = await wakeContext({ cfg, card: null, persona, env: {}, exec, thread: 47 });
  assert.deepEqual(ctx.parts.map((p) => p.name), ['thread']);
  assert.equal(ctx.parts[0]!.cap, 2000);
  const text = ctx.parts[0]!.text;
  assert.match(text, /^Thread 41 in #dm-bolt-sage, 3 message\(s\)\. You were woken by message 47\. Answer in this thread \(thread=41\)/);
  for (const m of thread) assert.ok(text.includes(m.body), `has message ${m.id}`);
  assert.equal(text.match(/^\d+ \d{4}-\d{2}-\d{2} /gm)?.length, 3, 'three messages, no more');
  assert.doesNotMatch(text, /UNRELATED/);
  assert.deepEqual(calls.map((c) => [c.command, c.args]), [['cli-org', ['thread', '47', '--json']]]);
  assert.equal(calls[0]!.env['ORG_AGENT'], 'bolt', 'the thread is read as the persona, so membership rules apply');
  const stat = ctx.fetchers.find((f) => f.name === 'thread')!;
  assert.ok(stat.on && stat.chars > 0 && stat.error === null);

  // The run: the thread part is in the system prompt, in its own tags, and the trace records its size.
  faux.setResponses([fauxAssistantMessage([fauxText('Checked: the redirect works on staging.')])]);
  const zen = new ZenAgent({ config: cfg, persona, parts: ctx.parts, fetchers: ctx.fetchers, models, env: {}, task: 'You were woken by a DM. Answer in the thread.' });
  assert.match(zen.prompt.prompt, /<thread>\nThread 41 in #dm-bolt-sage[\s\S]*Any news\?\n<\/thread>/);
  assert.doesNotMatch(zen.prompt.prompt, /UNRELATED/);
  const r = await zen.run('Reply to the thread.');
  const meta = lines(r.sessionPath)[0] as { parts: { name: string; tokens: number }[]; fetchers: { name: string; on: boolean }[]; resumed: null };
  assert.ok(meta.parts.find((p) => p.name === 'thread')!.tokens > 0);
  assert.deepEqual(meta.fetchers.filter((f) => f.on).map((f) => f.name), ['thread']);
  assert.equal(meta.resumed, null);
  assert.equal(lines(r.sessionPath).filter((l) => l.type === 'message').length, 2, 'the whole transcript is this wake');
});

test('the thread part is cut at its cap and the cut is recorded', async () => {
  const { cfg } = setup({ context: { cap: 0.6, keepTurns: 6, parts: { thread: 40 }, fetchers: {} } });
  const long = Array.from({ length: 30 }, (_, i) => ({ id: 100 + i, channel_slug: 'eng', thread_id: i ? 100 : null, author: 'sage', kind: 'reply', body: `message number ${i} of the long thread`, created_at: '2026-10-24T09:00:00.000Z' }));
  const { exec } = fakeExec({ 'cli-org thread 129': JSON.stringify(long) });
  const persona = loadPersona(cfg, 'bolt');
  const ctx = await wakeContext({ cfg, card: null, persona, env: {}, exec, thread: 129 });
  const { fauxProvider: fp, createModels: cm } = await import('@earendil-works/pi-ai');
  const models = cm();
  models.setProvider(fp().provider);
  const zen = new ZenAgent({ config: cfg, persona, parts: ctx.parts, fetchers: ctx.fetchers, models, env: {} });
  const stat = zen.prompt.parts.find((p) => p.name === 'thread')!;
  assert.ok(stat.truncated);
  assert.ok(stat.tokens <= 50);
  assert.ok(ctx.fetchers.find((f) => f.name === 'thread')!.chars > stat.chars, 'the stat keeps what was fetched; the part keeps what entered');
});

test('cardMeta reads the project, feature, repo, branch, PR and work type off a card', () => {
  const c = card('t_c0ffee', 'Ship it', 'Project: app/login\nAssigned by atlas. Repo: acme/app. Round 2.\nBranch: feat/login-redirect\n## Scope\nSee https://github.com/acme/app/pull/12 for the draft.', { work_type: 'coding' });
  assert.deepEqual(cardMeta(c), { project: 'app', feature: 'login', repo: 'acme/app', branch: 'feat/login-redirect', pr: 'https://github.com/acme/app/pull/12', workType: 'coding' });
  const vault = card('t_c0ffe1', 'Notes', 'Project: brain\nAssigned by atlas. Repo: vault. Worked by a Claude Code session.\ntype: research');
  assert.deepEqual(cardMeta(vault), { project: 'brain', feature: null, repo: null, branch: null, pr: null, workType: 'research' });
  assert.deepEqual(cardMeta(null), { project: null, feature: null, repo: null, branch: null, pr: null, workType: null });
});

test('fetchersFor unites default, team and work-type lists and rejects an unknown name', () => {
  const { cfg } = setup({ context: { cap: 0.6, keepTurns: 6, parts: {}, fetchers: { default: ['recall'], coding: ['tracker', 'github'], 'team:research': ['recall', 'tracker'], research: ['thread'] } } });
  const bolt = loadPersona(cfg, 'bolt');
  const sage = loadPersona(cfg, 'sage');
  assert.deepEqual(fetchersFor(cfg, card('t_1', 'x', 'Type: coding'), bolt).sort(), ['github', 'recall', 'tracker']);
  assert.deepEqual(fetchersFor(cfg, card('t_1', 'x', 'nothing typed'), bolt), ['recall']);
  assert.deepEqual(fetchersFor(cfg, card('t_1', 'x', 'Type: research'), sage).sort(), ['recall', 'tracker'], 'thread is never configured, a thread id turns it on');
  assert.deepEqual(fetchersFor(cfg, null, null), ['recall']);
  const plain = setup();
  assert.deepEqual(fetchersFor(plain.cfg, card('t_1', 'x', 'Type: coding'), bolt), [], 'off by default');
  assert.throws(() => fetchersFor(setup({ context: { cap: 0.6, keepTurns: 6, parts: {}, fetchers: { default: ['embeddings'] } } }).cfg, null, null), /unknown context fetcher "embeddings"/);
});

const TRACKER_LIST = [
  'app [building] division=product team=eng',
  '  app/login [building 3d] verified=pass  Login redirect',
  '  app/billing [designing 9d]  Billing page',
  'site [live] team=growth',
  '  site/pricing [testing 1d]  Pricing page',
].join('\n');

test('tracker: on for the card type, the project row enters the prompt; off, the part is empty and the trace says so', async () => {
  const on = setup({ context: { cap: 0.6, keepTurns: 6, parts: { tracker: 1500 }, fetchers: { coding: ['tracker'] } } });
  const kb = fakeBoard([card('t_aaaaaa', 'Fix the login redirect', 'Project: app/login\n## Objective\nRedirect after login.', { work_type: 'coding' })]);
  const { exec, calls } = fakeExec({ 'cli-projects list': TRACKER_LIST });
  on.faux.setResponses([fauxAssistantMessage([fauxText('done')])]);
  const r = await runWake({ cfg: on.cfg, kb, cardId: 't_aaaaaa', persona: 'bolt', models: on.models, env: {}, exec });
  assert.deepEqual(calls.map((c) => [c.command, c.args]), [['cli-projects', ['list']]]);
  const meta = lines(r.sessionPath)[0] as { parts: { name: string; tokens: number }[]; fetchers: { name: string; on: boolean; chars: number }[] };
  const part = meta.parts.find((p) => p.name === 'tracker');
  assert.ok(part && part.tokens > 0, 'the tracker part is in the trace');
  const tracker = r.fetchers.find((f) => f.name === 'tracker')!;
  assert.ok(tracker.on && tracker.chars > 0);
  const system = (lines(r.sessionPath).find((l) => l.type === 'message')!.message as { content: unknown }).content; // the first message is the user turn
  assert.ok(system, 'has messages');
  const ctx = await wakeContext({ cfg: on.cfg, card: await kb.show('t_aaaaaa'), persona: loadPersona(on.cfg, 'bolt'), env: {}, exec });
  assert.equal(ctx.parts[0]!.text, 'Tracker row for app/login (cli-projects list):\napp [building] division=product team=eng\n  app/login [building 3d] verified=pass  Login redirect');
  assert.doesNotMatch(ctx.parts[0]!.text, /billing|pricing/);

  // Off: the same card, no fetcher configured for its type.
  const off = setup({ context: { cap: 0.6, keepTurns: 6, parts: { tracker: 1500 }, fetchers: { research: ['tracker'] } } });
  const { exec: exec2, calls: calls2 } = fakeExec({ 'cli-projects list': TRACKER_LIST });
  off.faux.setResponses([fauxAssistantMessage([fauxText('done')])]);
  const r2 = await runWake({ cfg: off.cfg, kb, cardId: 't_aaaaaa', persona: 'bolt', models: off.models, env: {}, exec: exec2 });
  assert.equal(calls2.length, 0);
  const meta2 = lines(r2.sessionPath)[0] as { parts: { name: string }[]; fetchers: { name: string; on: boolean; chars: number }[] };
  assert.ok(!meta2.parts.some((p) => p.name === 'tracker'), 'no tracker part');
  assert.deepEqual(meta2.fetchers.find((f) => f.name === 'tracker'), { name: 'tracker', on: false, chars: 0, tokens: 0, error: null });

  // --fetch overrides the configuration both ways.
  const forced = await wakeContext({ cfg: off.cfg, card: await kb.show('t_aaaaaa'), persona: loadPersona(off.cfg, 'bolt'), env: {}, exec: exec2, fetchers: ['tracker'] });
  assert.deepEqual(forced.parts.map((p) => p.name), ['tracker']);
  const none = await wakeContext({ cfg: on.cfg, card: await kb.show('t_aaaaaa'), persona: loadPersona(on.cfg, 'bolt'), env: {}, exec, fetchers: [] });
  assert.deepEqual(none.parts, []);
});

test('tracker: a card without a project brings nothing; a project the tracker lacks says so', async () => {
  const { cfg } = setup();
  const { exec, calls } = fakeExec({ 'cli-projects list': TRACKER_LIST });
  const r = await fetchParts(['tracker'], { cfg, card: card('t_1', 'x', 'no header'), persona: null, env: {}, exec });
  assert.deepEqual(r.parts, []);
  assert.equal(calls.length, 0);
  const r2 = await fetchParts(['tracker'], { cfg, card: card('t_1', 'x', 'Project: ghost'), persona: null, env: {}, exec });
  assert.equal(r2.parts[0]!.text, 'Tracker row for ghost (cli-projects list):\nnot in the tracker.');
});

test('github: PR and CI status for the card\'s branch when it names a repo; nothing when it does not', async () => {
  const { cfg } = setup();
  const pr = { number: 12, title: 'Login redirect', state: 'OPEN', isDraft: false, reviewDecision: 'APPROVED', headRefName: 'feat/login-redirect', url: 'https://github.com/acme/app/pull/12', statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }, { name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' }, { name: 'build', status: 'IN_PROGRESS', conclusion: null }] };
  const runs = [{ name: 'CI', status: 'completed', conclusion: 'failure', url: 'https://github.com/acme/app/actions/runs/1' }];
  const { exec, calls } = fakeExec({ 'gh pr view': JSON.stringify(pr), 'gh run list': JSON.stringify(runs) });
  const c = card('t_1', 'Ship it', 'Project: app/login\nAssigned by atlas. Repo: acme/app.\nBranch: feat/login-redirect');
  const r = await fetchParts(['github'], { cfg, card: c, persona: null, env: {}, exec });
  assert.equal(
    r.parts[0]!.text,
    [
      'GitHub (gh) for acme/app branch feat/login-redirect:',
      'PR #12 "Login redirect": OPEN, review APPROVED, branch feat/login-redirect, https://github.com/acme/app/pull/12',
      'checks: 1 passed, 1 failed (lint), 1 pending',
      'recent runs:',
      '- CI: failure https://github.com/acme/app/actions/runs/1',
    ].join('\n'),
  );
  assert.deepEqual(calls.map((x) => x.args), [
    ['pr', 'view', 'feat/login-redirect', '--repo', 'acme/app', '--json', 'number,title,state,isDraft,reviewDecision,headRefName,url,statusCheckRollup'],
    ['run', 'list', '--repo', 'acme/app', '--branch', 'feat/login-redirect', '--limit', '5', '--json', 'name,status,conclusion,url'],
  ]);
  assert.equal(r.parts[0]!.cap, 1500);

  // No PR yet: gh says so, the run list still comes.
  const { exec: e2 } = fakeExec({ 'gh pr view': () => { throw new Error('gh: no pull requests found for branch "feat/x"'); }, 'gh run list': '[]' });
  const r2 = await fetchParts(['github'], { cfg, card: card('t_2', 'x', 'Repo: acme/app\nBranch: feat/x'), persona: null, env: {}, exec: e2 });
  assert.match(r2.parts[0]!.text, /no pull request for this branch yet\nrecent runs: none/);

  // A PR URL alone is enough; a card with neither brings nothing and runs nothing.
  const { exec: e3, calls: c3 } = fakeExec({ 'gh pr view': JSON.stringify(pr), 'gh run list': '[]' });
  const r3 = await fetchParts(['github'], { cfg, card: card('t_3', 'x', 'See https://github.com/acme/app/pull/12'), persona: null, env: {}, exec: e3 });
  assert.equal(c3[0]!.args[2], 'https://github.com/acme/app/pull/12');
  assert.match(r3.parts[0]!.text, /PR #12/);
  const { exec: e4, calls: c4 } = fakeExec({});
  const r4 = await fetchParts(['github'], { cfg, card: card('t_4', 'x', 'Project: app'), persona: null, env: {}, exec: e4 });
  assert.deepEqual(r4.parts, []);
  assert.equal(c4.length, 0);
});

test('recall: the card title is the query, as the persona, scoped to the project; a failing fetcher leaves its part empty', async () => {
  const { cfg } = setup();
  const hits = [
    { source: 'fact', ref: '#f12', title: 'login', text: 'The staging login uses the test IdP.', score: 1 },
    { source: 'memory', ref: '.agents/org/memory/bolt.md', title: 'bolt', text: 'Check the redirect allowlist first.', score: 0.5 },
  ];
  const { exec, calls } = fakeExec({ 'cli-org recall': JSON.stringify(hits) });
  const persona = loadPersona(cfg, 'bolt');
  const r = await fetchParts(['recall'], { cfg, card: card('t_1', 'Fix the login redirect', 'Project: app/login'), persona, env: {}, exec });
  assert.deepEqual(calls[0]!.args, ['recall', 'Fix the login redirect', '--limit', '6', '--project', 'app', '--json']);
  assert.equal(calls[0]!.env['ORG_AGENT'], 'bolt');
  assert.equal(
    r.parts[0]!.text,
    'Recall for "Fix the login redirect" (2 hit(s); facts and notes already written down, verify before you build on them):\n- [fact] #f12  login\n  The staging login uses the test IdP.\n- [memory] .agents/org/memory/bolt.md\n  Check the redirect allowlist first.',
  );
  assert.equal(r.parts[0]!.cap, 2000);
  const empty = await fetchParts(['recall'], { cfg, card: card('t_1', 'x', null as unknown as string), persona: null, env: {}, exec });
  assert.deepEqual(empty.parts, [], 'no persona, no recall (cli-org needs ORG_AGENT)');

  const { exec: broken } = fakeExec({});
  const r2 = await fetchParts(['recall', 'tracker'], { cfg, card: card('t_1', 'Fix it', 'Project: app'), persona, env: {}, exec: broken });
  assert.deepEqual(r2.parts, []);
  const recall = r2.stats.find((s) => s.name === 'recall')!;
  assert.ok(recall.on && recall.error && /no such command/.test(recall.error));
});

test('the wake prompt tells the model the run is fresh', () => {
  const p = wakePrompt({ card: card('t_abc123', 'x', 'y'), persona: 'bolt', canComplete: true });
  assert.match(p, /This run starts fresh: nothing from your earlier runs is in front of you/);
});

test('Session.summary gives one run in numbers: parts, fetchers, usage', async () => {
  const { cfg, faux, models } = setup();
  faux.setResponses([fauxAssistantMessage([fauxToolCall('list_dir', { path: '.' })], { stopReason: 'toolUse' }), fauxAssistantMessage([fauxText('ok')])]);
  const zen = new ZenAgent({ config: cfg, persona: 'bolt', models, env: {}, parts: [{ name: 'thread', text: 'Thread 1 in #eng, 1 message(s).', cap: 2000 }], fetchers: [{ name: 'thread', on: true, chars: 30, tokens: 8, error: null }] });
  const r = await zen.run('look');
  const s = Session.summary(cfg.sessionsDir, r.sessionId);
  assert.equal(s.id, r.sessionId);
  assert.equal(s.persona, 'bolt');
  assert.equal(s.resumed, null);
  assert.equal(s.stopped, 'done');
  assert.equal(s.turns, 2);
  assert.ok(s.usage && s.usage.total === r.usage.total && s.usage.total > 0);
  assert.ok(s.parts.some((p) => p.name === 'thread'));
  assert.equal(s.promptTokens, s.parts.reduce((n, p) => n + p.tokens, 0));
  assert.deepEqual(s.fetchers.filter((f) => f.on).map((f) => f.name), ['thread']);
  assert.equal(s.messages, 4);
});

test('the CLI: wake refuses --resume before touching anything; sessions --json prints one summary per run', async () => {
  const { cfg, faux, models, dir } = setup();
  faux.setResponses([fauxAssistantMessage([fauxText('ok')])]);
  await new ZenAgent({ config: cfg, persona: 'bolt', models, env: {} }).run('hi');
  const cli = resolve('dist/src/cli.js');
  const run = (args: string[]) =>
    new Promise<{ code: number; out: string; err: string }>((done) => {
      execFile(process.execPath, [cli, ...args, '--workdir', dir], { env: { PATH: process.env['PATH'] ?? '' } }, (error, out, err) => done({ code: (error as { code?: number } | null)?.code ?? 0, out, err }));
    });
  const refused = await run(['wake', 't_aaaaaa', '--resume', 'bolt-20261024-0900-abcd']);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /wake never resumes a session: every wake is a fresh run/);
  const bad = await run(['run', 'hi', '--thread', 'x']);
  assert.match(bad.err, /--thread takes a message id/);
  const list = await run(['sessions', '--json']);
  assert.equal(list.code, 0);
  const rows = list.out.trim().split('\n').map((l) => JSON.parse(l) as { persona: string; resumed: null; usage: { total: number }; parts: Record<string, number>; fetchers: string[] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.persona, 'bolt');
  assert.equal(rows[0]!.resumed, null);
  assert.ok(rows[0]!.usage.total > 0);
  assert.ok((rows[0]!.parts['identity'] ?? 0) > 0);
  assert.deepEqual(rows[0]!.fetchers, []);
});
