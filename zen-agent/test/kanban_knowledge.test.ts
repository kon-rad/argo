import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import { BoardKanban, CliKanban, formatDetail, HubKanban, kanbanTools, makeKanban } from '../src/tools/kanban.js';
import type { ToolContext } from '../src/tools/index.js';
import { formatHits, Knowledge, knowledgeTools } from '../src/tools/knowledge.js';
import { wakePrompt } from '../src/wake.js';

type Call = { url: string; init?: RequestInit };
function fakeFetch(answer: (c: Call) => unknown, status = 200): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const c = { url: String(url), init };
    calls.push(c);
    return new Response(JSON.stringify(answer(c)), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: f, calls };
}

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({ cfg: DEFAULTS, persona: null, models: null as never, skills: [], depth: 0, env: {}, fetch, ...over });

test('HubKanban speaks agent-hub\'s API with the bearer token', async () => {
  const { fetch: f, calls } = fakeFetch((c) => (c.url.includes('/board') ? { tasks: [{ id: 't_a1b2c3', title: 'Build', status: 'todo', assignee: 'bolt', body: null }] } : c.url.endsWith('/tasks') ? { id: 't_2', title: 'New', assignee: 'bolt', status: 'todo', body: 'b' } : { ok: true }));
  const kb = new HubKanban('http://127.0.0.1:8787/', 'tok', 'exo', f);
  const cards = await kb.list();
  assert.equal(cards[0]!.id, 't_a1b2c3');
  assert.equal(calls[0]!.url, 'http://127.0.0.1:8787/board?board=exo');
  assert.equal((calls[0]!.init!.headers as Record<string, string>)['Authorization'], 'Bearer tok');
  const created = await kb.create({ title: 'New', body: 'b', assignee: 'bolt', project: 'p' });
  assert.equal(created.id, 't_2');
  assert.deepEqual(JSON.parse(calls[1]!.init!.body as string), { title: 'New', body: 'b', assignee: 'bolt', project: 'p', board: 'exo' });
  await kb.comment('t_a1b2c3', 'hi');
  assert.deepEqual(JSON.parse(calls[2]!.init!.body as string), { board: 'exo', text: 'hi' });
  await assert.rejects(kb.show('bad id'), /bad card id/);
  assert.equal((kb as { complete?: unknown }).complete, undefined);
});

test('BoardKanban speaks the engine\'s /api/board with a board token: every verb, plus claim and heartbeat', async () => {
  const card = { id: 't_a1b2c3d4', title: 'Build', body: 'do it', assignee: 'rune', status: 'ready', priority: 2, created_by: 'owner', created_at: '2026-10-24T10:00:00.000Z', result: null, block_kind: null, block_reason: null, contract: { objective: 'Ship it', returns: ['a PR'], budget: { turns: 20 } } };
  const { fetch: f, calls } = fakeFetch((c) => {
    if (c.url.endsWith('/cards?board=exo')) return { cards: [card] };
    if (c.url.endsWith('/cards/t_a1b2c3d4')) return { card, comments: [{ author: 'owner', body: 'go', created_at: '2026-10-24T10:05:00.000Z' }], events: [], depends_on: [{ id: 't_000001' }], dependants: [], runs: [] };
    if (c.url.endsWith('/claim')) return { card: { ...card, status: 'running' } };
    if (c.url.endsWith('/cards')) return { card: { ...card, id: 't_new00001', title: 'New' }, message: null };
    return { card };
  });
  const kb = new BoardKanban('http://127.0.0.1:5123/', 'sbb_x', 'exo', f);
  assert.equal((await kb.list())[0]!.id, 't_a1b2c3d4');
  assert.equal(calls[0]!.url, 'http://127.0.0.1:5123/api/board/cards?board=exo');
  assert.equal((calls[0]!.init!.headers as Record<string, string>)['Authorization'], 'Bearer sbb_x');
  const d = await kb.show('t_a1b2c3d4');
  assert.equal(d.task.created_at, Math.floor(Date.parse(card.created_at) / 1000));
  assert.match(d.task.body!, /do it[\s\S]*## Objective\nShip it[\s\S]*## Returns\n- a PR[\s\S]*## Budget\nturns: 20/);
  assert.deepEqual(d.parents, ['t_000001']);
  assert.equal(d.comments[0]!.author, 'owner');
  const created = await kb.create({ title: 'New', body: 'b', assignee: 'rune', project: 'p' });
  assert.equal(created.id, 't_new00001');
  assert.deepEqual(JSON.parse(calls[2]!.init!.body as string), { title: 'New', body: 'b', assignee: 'rune', board: 'exo', project: 'p' });
  await kb.comment('t_a1b2c3d4', 'hi');
  assert.deepEqual(JSON.parse(calls[3]!.init!.body as string), { body: 'hi' });
  await kb.complete('t_a1b2c3d4', 'PR 12');
  assert.ok(calls[4]!.url.endsWith('/cards/t_a1b2c3d4/finish'));
  assert.deepEqual(JSON.parse(calls[4]!.init!.body as string), { outcome: 'done', result: 'PR 12' });
  await kb.block('t_a1b2c3d4', 'needs the owner');
  assert.deepEqual(JSON.parse(calls[5]!.init!.body as string), { outcome: 'blocked', block_kind: 'other', result: 'needs the owner' });
  const claimed = await kb.claim({ runtime: 'zen-agent' });
  assert.equal(claimed!.status, 'running');
  assert.deepEqual(JSON.parse(calls[6]!.init!.body as string), { runtime: 'zen-agent', board: 'exo' });
  await kb.heartbeat('t_a1b2c3d4', { tokens: 1200, turns: 3 });
  assert.deepEqual(JSON.parse(calls[7]!.init!.body as string), { tokens: 1200, turns: 3 });
  // Nothing ready: 204 is null, not an error.
  const empty = new BoardKanban('http://127.0.0.1:5123', 'sbb_x', 'exo', (async () => new Response(null, { status: 204 })) as typeof fetch);
  assert.equal(await empty.claim({ runtime: 'zen-agent' }), null);
  // The tool set includes complete and block, which the engine's board can do.
  const names = kanbanTools(ctx(), kb).map((t) => t.name);
  assert.ok(names.includes('card_complete') && names.includes('card_block'));
  assert.throws(() => makeKanban({ kind: 'board', url: 'http://127.0.0.1:1', tokenEnv: 'BOARD_TOKEN', board: 'exo' }, {}, fetch, 'x'), /BOARD_TOKEN is not set/);
});

test('HubKanban surfaces the hub\'s error message', async () => {
  const { fetch: f } = fakeFetch(() => ({ error: 'no such board' }), 404);
  await assert.rejects(new HubKanban('http://127.0.0.1:1', 't', 'exo', f).list(), /kanban 404: no such board/);
});

test('CliKanban drives the board command and can complete and block', async () => {
  const seen: string[][] = [];
  const kb = new CliKanban('hermes', 'exo', 'atlas', async (cmd, args) => {
    seen.push([cmd, ...args]);
    if (args.includes('show')) return JSON.stringify({ task: { id: 't_abc123', title: 'Review', status: 'doing', body: '## Budget\nturns: 4' }, comments: [{ author: 'owner', body: 'go', created_at: 1_700_000_000 }] });
    if (args.includes('list')) return JSON.stringify([{ id: 't_abc123', title: 'Review', status: 'doing' }]);
    return '{}';
  });
  const d = await kb.show('t_abc123');
  assert.equal(d.task.title, 'Review');
  assert.deepEqual(seen[0], ['hermes', 'kanban', '--board', 'exo', 'show', 't_abc123', '--json']);
  assert.equal((await kb.list())[0]!.id, 't_abc123');
  await kb.comment('t_abc123', 'done');
  assert.deepEqual(seen[2], ['hermes', 'kanban', '--board', 'exo', 'comment', '--author', 'atlas', '--', 't_abc123', 'done']);
  await kb.complete('t_abc123', 'PR 12');
  assert.deepEqual(seen[3]!.slice(4), ['complete', 't_abc123', '--result', 'PR 12']);
  await kb.block('t_abc123', 'needs owner');
  assert.deepEqual(seen[4]!.slice(4), ['block', 't_abc123', 'needs owner']);
  assert.match(formatDetail(d), /t_abc123: Review\nstatus: doing\n\n## Budget\nturns: 4\n\nComments:\n- owner \(2023-11-14T22:13\): go/);
  const prompt = wakePrompt({ card: d, persona: 'atlas', canComplete: true });
  assert.match(prompt, /^You were woken for card t_abc123\./);
  assert.match(prompt, /card_complete on t_abc123/);
});

test('the kanban tool set follows the backend: none, hub, cli', () => {
  assert.deepEqual(kanbanTools(ctx()), []);
  assert.equal(makeKanban({ kind: 'none' }, {}, fetch, 'x'), null);
  assert.throws(() => makeKanban({ kind: 'hub', url: 'http://127.0.0.1:1', tokenEnv: 'HUB_TOKEN', board: 'exo' }, {}, fetch, 'x'), /HUB_TOKEN is not set/);
  const hub = kanbanTools(ctx(), makeKanban({ kind: 'hub', url: 'http://127.0.0.1:1', tokenEnv: 'HUB_TOKEN', board: 'exo' }, { HUB_TOKEN: 't' }, fetch, 'x'));
  assert.deepEqual(hub.map((t) => t.name), ['board_list', 'card_show', 'card_create', 'card_comment', 'card_assign']);
  const cli = kanbanTools(ctx(), new CliKanban('hermes', 'exo', 'x', async () => '[]'));
  assert.deepEqual(cli.map((t) => t.name).slice(-2), ['card_complete', 'card_block']);
});

test('Knowledge calls the second brain\'s search API with the headers from the environment', async () => {
  const { fetch: f, calls } = fakeFetch((c) =>
    c.url.includes('/api/file/source')
      ? { path: 'Areas/x.md', content: '# X\nbody' }
      : { q: 'x', mode: 'hybrid', total: 1, results: [{ ref_path: 'Areas/x.md', title: 'X', snippet: 'about   x', heading_path: 'X > Intro', similarity: 0.83 }] },
  );
  const kb = Knowledge.fromEnv({ url: 'http://127.0.0.1:3000/', headersEnv: 'SB_HEADERS' }, { SB_HEADERS: '{"Cookie":"sb_session=abc"}' }, f);
  const r = await kb.search('x', { limit: 3 });
  assert.equal(r.total, 1);
  assert.equal(calls[0]!.url, 'http://127.0.0.1:3000/api/search?q=x&mode=hybrid&limit=3');
  assert.equal((calls[0]!.init!.headers as Record<string, string>)['Cookie'], 'sb_session=abc');
  assert.match(formatHits(r.results), /^\[1\] Areas\/x\.md › X > Intro \(0\.83\)\n    about x$/);
  assert.equal((await kb.note('Areas/x.md')).content, '# X\nbody');
  assert.throws(() => Knowledge.fromEnv({ url: 'u', headersEnv: 'H' }, { H: 'not json' }, f), /JSON object/);
  const tools = knowledgeTools(ctx({ cfg: { ...DEFAULTS, knowledge: { kind: 'secondbrain', url: 'http://127.0.0.1:3000', headersEnv: 'H' } }, fetch: f }));
  assert.deepEqual(tools.map((t) => t.name), ['search_notes', 'search_everything', 'read_note']);
  assert.deepEqual(knowledgeTools(ctx()), []);
});

test('a 401 from the knowledge base explains the cookie', async () => {
  const { fetch: f } = fakeFetch(() => ({ error: { message: 'login required' } }), 401);
  const kb = new Knowledge('http://127.0.0.1:3000', {}, f);
  await assert.rejects(kb.search('x'), /401: login required \(set the session cookie/);
});
