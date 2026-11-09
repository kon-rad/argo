import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import {
  assignCard, BoardBus, claimCard, commentCard, createCard, createToken, driftReport, finishCard, findToken, flagCard, getCard, heartbeat, importHermesCards, linkCards,
  listBoards, listCards, listTokens, moveCard, reclaim, revokeToken, tagCard,
} from '../src/board.js';
import { formatCard, formatDetail, HttpBoard, main, parseHermesExport } from '../src/cli-board.js';
import { agentDatabaseUrl } from '../src/cli-org.js';
import { query, setDatabaseUrl } from '../src/db.js';
import { getAgent, importOrg } from '../src/org.js';
import { ALL_MODULES, truncateAll } from './helpers.js';

/**
 * The board module: the kanban record in the engine (docs/board-design.md). The rules live in the board_*
 * functions; these tests drive them through board.ts, the API (session and token doors), the CLI and the
 * sb_org role, and check the integration with the org (wakeups, roster) and the tracker (verifications).
 */

const ORG = {
  version: 'board-1',
  company: 'Argo',
  ceo: 'owner',
  agents: {
    owner: { runtime: 'human', role: 'CEO', channels: ['*'] },
    atlas: { role: 'Head of Platform', team: 'platform', reports_to: 'owner', capabilities: ['review', 'merge'] },
    rune: { runtime: 'zen-agent', role: 'Platform engineer', team: 'platform', reports_to: 'atlas', capabilities: ['code'] },
    vera: { role: 'Reviewer', team: 'platform', reports_to: 'atlas', capabilities: ['review'] },
    juno: { role: 'Head of Media', team: 'media', reports_to: 'owner' },
    lena: { runtime: 'hermes', role: 'Writer', team: 'media', reports_to: 'juno' },
    sol: { role: 'Chief of staff', team: 'staff', reports_to: 'owner', capabilities: ['dispatch'] },
    'cc-writer': { runtime: 'claude-code', role: 'Claude Code writer lane', lane: true },
  },
  teams: { platform: { name: 'Platform', lead: 'atlas' }, media: { name: 'Media', lead: 'juno' }, staff: { name: 'Staff', lead: 'sol' } },
  channels: { 'all-hands': { members: '*' }, leads: { members: ['owner', 'atlas', 'juno', 'sol'] } },
};

const TEST_DB = process.env.SB_TEST_DB ?? 'secondbrain_test';
const ownerUrl = `postgres://${process.env.PGUSER ?? ''}${process.env.PGUSER ? '@' : ''}${process.env.PGHOST ?? 'localhost'}:${process.env.PGPORT ?? '5432'}/${TEST_DB}`;
const asAgent = (name: string): string => agentDatabaseUrl(`postgres://sb_org@${process.env.PGHOST ?? 'localhost'}:${process.env.PGPORT ?? '5432'}/${TEST_DB}`, name);

async function sql<T extends pg.QueryResultRow>(url: string, text: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(text, params)).rows;
  } finally {
    await client.end();
  }
}

const wakes = async (): Promise<{ agent_name: string; ref: string | null }[]> =>
  (await query<{ agent_name: string; ref: string | null }>(`SELECT agent_name, ref FROM org_wakeups WHERE done_at IS NULL ORDER BY id`)).rows;

beforeEach(async () => {
  await truncateAll();
  await importOrg(ORG);
  await query(`INSERT INTO projects (slug, title, team_slug, stage) VALUES ('secondbrain-app', 'Second Brain app', 'platform', 'building')`);
  await query(`INSERT INTO features (project_slug, slug, title, stage) VALUES ('secondbrain-app', 'board', 'The board', 'building')`);
});

describe('the record', () => {
  it('the import makes roster rows for the vault session and a lane, so every assignee has a key', async () => {
    const rows = (await query<{ name: string; runtime: string; team_slug: string | null }>(`SELECT name, runtime, team_slug FROM org_agents WHERE runtime IN ('session', 'claude-code') AND team_slug IS NULL ORDER BY name`)).rows;
    expect(rows).toEqual([
      { name: 'cc-dispatcher', runtime: 'session', team_slug: null },
      { name: 'cc-writer', runtime: 'claude-code', team_slug: null },
      { name: 'claude-telegram', runtime: 'session', team_slug: null },
      { name: 'm4', runtime: 'session', team_slug: null },
      { name: 'vault-session', runtime: 'session', team_slug: null },
    ]);
    // A second import keeps the vault session; agents gone from the file are retired, the session row is not.
    await importOrg({ ...ORG, agents: Object.fromEntries(Object.entries(ORG.agents).filter(([n]) => n !== 'lena')) });
    expect((await query<{ n: number }>(`SELECT count(*)::int AS n FROM org_agents WHERE retired_at IS NOT NULL`)).rows[0]!.n).toBe(1);
    expect((await getAgent('vault-session')).runtime).toBe('session');
  });

  it('a card is ready at once, wakes its bot, and carries its project, contract and flags', async () => {
    const c = await createCard('owner', { title: '  Build   the board ', body: 'GET /api/board', contract: { objective: 'Ship it', budget: { turns: 20 } }, assignee: 'rune', project: 'secondbrain-app', feature: 'board', kind: 'build', work: 'coding', needs: 'code', repo: 'secondbrain', priority: 2 });
    expect(c).toMatchObject({ title: 'Build the board', status: 'ready', board_slug: 'exo', assignee: 'rune', created_by: 'owner', kind: 'build', work_type: 'coding', needs: 'code', priority: 2, contract: { objective: 'Ship it', budget: { turns: 20 } } });
    expect(c.id).toMatch(/^t_[0-9a-f]{8}$/);
    expect(await wakes()).toEqual([{ agent_name: 'rune', ref: c.id }]);
    expect((await query<{ owner: string }>(`SELECT owner FROM features WHERE slug = 'board'`)).rows[0]!.owner).toBe('rune');
    // The board came into being with the first card; the old task_links view shows the same row.
    expect((await listBoards()).map((b) => [b.slug, b.open])).toEqual([['exo', 1]]);
    expect((await query<{ task_id: string; board: string }>(`SELECT task_id, board FROM task_links`)).rows).toEqual([{ task_id: c.id, board: 'exo' }]);
    const d = await getCard(c.id);
    expect(d.events.map((e) => [e.kind, e.actor])).toEqual([['created', 'owner']]);
  });

  it('refuses what the org refuses: a member giving a teammate a card, a bot without the capability, ship-now from a bot, a human as assignee', async () => {
    await expect(createCard('rune', { title: 'x', assignee: 'vera' })).rejects.toThrow(/rune can't give vera a card/);
    await expect(createCard('owner', { title: 'x', assignee: 'lena', needs: 'code' })).rejects.toThrow(/lena doesn't have the code capability.*rune/);
    await expect(createCard('atlas', { title: 'x', assignee: 'rune', shipNow: true })).rejects.toThrow(/only the owner can mark a card ship-now/);
    await expect(createCard('owner', { title: 'x', assignee: 'owner' })).rejects.toThrow(/not a bot/);
    await expect(createCard('owner', { title: 'x', assignee: 'rune', project: 'nope' })).rejects.toThrow(/no project "nope"/);
    await expect(createCard('nobody', { title: 'x' })).rejects.toThrow(/unknown agent "nobody"/);
    // A lead assigns inside its team; dispatch anywhere; the vault session takes cards from leads.
    await expect(createCard('atlas', { title: 'x', assignee: 'lena' })).rejects.toThrow(/inside its team/);
    expect((await createCard('sol', { title: 'x', assignee: 'lena' })).assignee).toBe('lena');
    expect((await createCard('atlas', { title: 'vault thing', assignee: 'vault-session' })).assignee).toBe('vault-session');
    await expect(createCard('rune', { title: 'x', assignee: 'vault-session' })).rejects.toThrow(/leads do/);
    // An unassigned card is the owner's backlog: no wake.
    const backlog = await createCard('owner', { title: 'Think about it' });
    expect(backlog.assignee).toBeNull();
    expect((await wakes()).map((w) => w.agent_name)).toEqual(['lena']);   // the vault session and the backlog woke nobody
  });

  it('dependencies: a card waits in todo, is promoted when its parents finish, and cycles are refused', async () => {
    const spec = await createCard('owner', { title: 'Spec', assignee: 'atlas', kind: 'spec' });
    const build = await createCard('owner', { title: 'Build', assignee: 'rune', kind: 'build', deps: [spec.id] });
    const review = await createCard('owner', { title: 'Review', assignee: 'vera', kind: 'review', deps: [build.id] });
    expect([build.status, review.status]).toEqual(['todo', 'todo']);
    expect(await wakes()).toEqual([{ agent_name: 'atlas', ref: spec.id }]);
    await expect(linkCards('owner', spec.id, review.id)).rejects.toThrow(/cycle/);
    await expect(linkCards('owner', spec.id, spec.id)).rejects.toThrow(/itself/);
    await finishCard('atlas', spec.id, { outcome: 'done', result: 'written' });
    // The spec's wake is answered by the finish; the build's begins.
    expect((await getCard(build.id)).card.status).toBe('ready');
    expect((await getCard(review.id)).card.status).toBe('todo');
    expect(await wakes()).toEqual([{ agent_name: 'rune', ref: build.id }]);
    // A ready card linked after an open one goes back to todo.
    const extra = await createCard('owner', { title: 'Extra', assignee: 'rune' });
    await linkCards('owner', extra.id, build.id);
    expect((await getCard(extra.id)).card.status).toBe('todo');
    expect((await getCard(build.id)).dependants.map((d) => d.id).sort()).toEqual([extra.id, review.id].sort());
  });

  it('claim: contention-safe, by runtime or agent, with a lease; heartbeat extends it; reclaim takes back a lost run', async () => {
    const a = await createCard('owner', { title: 'A', assignee: 'rune', priority: 1 });
    const b = await createCard('owner', { title: 'B', assignee: 'rune', priority: 3 });
    await createCard('owner', { title: 'C', assignee: 'lena' });
    // Two lanes of the same runtime claiming at once get different cards, highest priority first.
    const [x, y, z] = await Promise.all([claimCard(null, { runtime: 'zen-agent' }), claimCard(null, { runtime: 'zen-agent' }), claimCard(null, { runtime: 'zen-agent' })]);
    const got = [x, y, z].filter(Boolean).map((c) => c!.id).sort();
    expect(got).toEqual([a.id, b.id].sort());
    expect([x, y, z].filter((c) => c === null)).toHaveLength(1);
    expect((await getCard(a.id)).card.status).toBe('running');
    expect((await getCard(a.id)).runs[0]).toMatchObject({ agent_name: 'rune', runtime: 'zen-agent', outcome: null });
    // A bot claims only its own cards; dispatch any; a human any.
    await expect(claimCard('rune', { runtime: 'hermes' })).rejects.toThrow(/only its own cards/);
    expect((await claimCard('lena', { agent: 'lena' }))!.title).toBe('C');
    expect(await claimCard('sol', { runtime: 'hermes' })).toBeNull();
    // Heartbeat by the run's agent; another bot may not.
    const run = await heartbeat('rune', a.id, { tokens: 500, turns: 2, leaseMinutes: 5 });
    expect(run.tokens).toBe(500);
    await expect(heartbeat('vera', a.id, {})).rejects.toThrow(/is rune's/);
    // The lease runs out: reclaim marks the run lost, the card is ready and wakes rune again.
    await query(`UPDATE card_runs SET lease_until = now() - interval '1 minute' WHERE card_id = $1`, [a.id]);
    expect(await reclaim()).toBe(1);
    const after = await getCard(a.id);
    expect(after.card.status).toBe('ready');
    expect(after.runs[0]!.outcome).toBe('lost');
    expect(after.events.map((e) => e.kind)).toContain('reclaimed');
  });

  it('claim by task_id: a lane that already picked a card claims that exact one, or fails without taking another', async () => {
    const a = await createCard('owner', { title: 'Picked by the lane', assignee: 'rune', priority: 1 });
    const b = await createCard('owner', { title: 'Also ready', assignee: 'rune', priority: 2 });
    // Someone else takes it first: the named claim fails and must not fall back to a different ready card.
    await claimCard(null, { agent: 'rune', taskId: a.id });
    expect(await claimCard(null, { runtime: 'zen-agent', taskId: a.id })).toBeNull();
    expect((await getCard(b.id)).card.status).toBe('ready'); // b is untouched, not grabbed as a consolation prize
    // The exact card claims cleanly when it is still ready.
    const got = await claimCard(null, { agent: 'rune', taskId: b.id });
    expect(got!.id).toBe(b.id);
    expect((await getCard(b.id)).card.status).toBe('running');
    // A bot naming a card is still bound by "only its own cards" (rune has no dispatch capability here).
    const c = await createCard('owner', { title: "Not vera's", assignee: 'vera' });
    await expect(claimCard('rune', { runtime: 'hermes', taskId: c.id })).rejects.toThrow(/only its own cards/);
  });

  it('finish: only the assignee or a human; done writes the result and the verification; blocked needs a kind; budget and partial', async () => {
    const c = await createCard('owner', { title: 'Verify the board', assignee: 'rune', project: 'secondbrain-app', feature: 'board', kind: 'verify' });
    await claimCard(null, { agent: 'rune' });
    await expect(finishCard('vera', c.id, { outcome: 'done' })).rejects.toThrow(/can't finish rune's card/);
    await expect(finishCard('rune', c.id, { outcome: 'blocked' })).rejects.toThrow(/says why/);
    await finishCard('rune', c.id, { outcome: 'budget', result: 'out of turns', tokens: 9000, turns: 40 });
    expect((await getCard(c.id)).card).toMatchObject({ status: 'blocked', block_kind: 'budget', block_reason: 'out of turns' });
    expect((await getCard(c.id)).runs[0]).toMatchObject({ outcome: 'budget', tokens: 9000, turns: 40 });
    // The owner moves it back; rune finishes it with a verification that moves the tracker.
    await moveCard('owner', c.id, 'ready');
    await claimCard(null, { agent: 'rune' });
    const done = await finishCard('rune', c.id, { outcome: 'done', result: 'npm test green', verification: { kind: 'test', check: 'npm test', result: 'pass', evidence: '48 passed' }, runId: 'run-9' });
    expect(done).toMatchObject({ status: 'done', result: 'npm test green', block_kind: null });
    expect(done.completed_at).not.toBeNull();
    const { rows: v } = await query<{ kind: string; check_run: string; result: string; by: string }>(`SELECT kind, check_run, result, by FROM verifications`);
    expect(v).toEqual([{ kind: 'test', check_run: 'npm test', result: 'pass', by: 'rune' }]);
    await expect(finishCard('rune', c.id, { outcome: 'done' })).rejects.toThrow(/already done/);
    // Partial puts the card back to ready for the next wake.
    const p = await createCard('owner', { title: 'Long', assignee: 'rune' });
    await claimCard(null, { agent: 'rune' });
    expect((await finishCard('rune', p.id, { outcome: 'partial', result: 'first step done' })).status).toBe('ready');
  });

  it('move: a human anywhere, a bot its own card and never to done; comments are always by the caller; flags', async () => {
    const c = await createCard('owner', { title: 'Vault work', assignee: 'vault-session' });
    expect((await moveCard('vault-session', c.id, 'running')).status).toBe('running');
    await expect(moveCard('vault-session', c.id, 'done')).rejects.toThrow(/finish the card/);
    await expect(moveCard('rune', c.id, 'blocked')).rejects.toThrow(/can't move vault-session's card/);
    expect((await moveCard('owner', c.id, 'blocked', 'waiting on a decision')).block_reason).toBe('waiting on a decision');
    expect((await moveCard('owner', c.id, 'done')).status).toBe('done');
    const m = await commentCard('vera', c.id, 'looks fine');
    expect(m.author).toBe('vera');
    await expect(commentCard('rune', 't_deadbeef', 'x')).rejects.toThrow(/no card/);
    const f = await createCard('atlas', { title: 'Flagged', assignee: 'rune' });
    await expect(flagCard('rune', f.id, { shipNow: true })).rejects.toThrow(/only the owner/);
    await expect(flagCard('vera', f.id, { needs: 'review' })).rejects.toThrow(/didn't give/);
    expect((await flagCard('atlas', f.id, { needs: 'review' })).needs).toBe('review');
    expect((await flagCard('owner', f.id, { shipNow: true })).ship_now).toBe(true);
    // The old function name still works for callers that have it.
    await query(`SELECT org_task_flags($1, false, 'code')`, [f.id]);
    expect((await getCard(f.id)).card.needs).toBe('code');
    const list = await listCards({ assignee: 'rune', status: 'ready,todo' });
    expect(list.map((x) => x.id)).toEqual([f.id]);
    expect((await listCards({ q: 'flagged' })).map((x) => x.id)).toEqual([f.id]);
    expect(await listCards({ assignee: 'none' })).toEqual([]);
  });

  it('the sb_org role reads the company boards and its team\'s, writes only through the functions, as itself', async () => {
    const c = await createCard('owner', { title: 'Company card', assignee: 'rune' });
    await query(`INSERT INTO boards (slug, name, team_slug) VALUES ('media-only', 'Media', 'media')`);
    const m = await createCard('juno', { title: 'Media card', assignee: 'lena', board: 'media-only' });
    expect((await sql<{ id: string }>(asAgent('rune'), `SELECT id FROM cards ORDER BY id`)).map((r) => r.id)).toEqual([c.id]);
    expect((await sql<{ id: string }>(asAgent('lena'), `SELECT id FROM cards ORDER BY created_at`)).map((r) => r.id)).toEqual([c.id, m.id]);
    expect((await sql<{ slug: string }>(asAgent('rune'), `SELECT slug FROM boards`)).map((r) => r.slug)).toEqual(['exo']);
    await expect(sql(asAgent('rune'), `INSERT INTO card_comments (card_id, author, body) VALUES ($1, 'rune', 'x')`, [c.id])).rejects.toThrow(/permission denied/);
    await expect(sql(asAgent('rune'), `SELECT board_card_comment('vera', $1, 'as vera')`, [c.id])).rejects.toThrow(/caller is rune, not vera/);
    await sql(asAgent('rune'), `SELECT board_card_comment('rune', $1, 'as myself')`, [c.id]);
    expect((await getCard(c.id)).comments.map((x) => x.author)).toEqual(['rune']);
    // Visibility through the TypeScript reads follows the same rule for a token's viewer.
    expect((await listCards({}, 'rune')).map((x) => x.id)).toEqual([c.id]);
    expect((await listBoards('lena')).map((b) => b.slug)).toEqual(['exo', 'media-only']);
    await expect(getCard(m.id, 'rune')).rejects.toThrow(/no card/);
  });
});

describe('ticket numbers and project tags', () => {
  const app = () => createApp({ modules: ALL_MODULES, board: { owner: 'owner' } });
  const ids = (cs: { id: string }[]): string[] => cs.map((c) => c.id);

  it('q finds a card by its ticket number: t_<id>, a bare 8-hex id, #<prefix>, and the exact id comes first', async () => {
    const a = await createCard('owner', { id: 't_1d4c0eff', title: 'Search by ticket number' });
    const b = await createCard('owner', { id: 't_1d4c0eff99', title: 'A longer id with the same prefix' });
    const other = await createCard('owner', { id: 't_abcdef12', title: 'Unrelated' });
    expect(ids(await listCards({ q: 't_1d4c0eff' }))).toEqual([a.id, b.id]);
    expect(ids(await listCards({ q: '1d4c0eff' }))).toEqual([a.id, b.id]);
    expect(ids(await listCards({ q: '#1d4c' }))).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(ids(await listCards({ q: '#1d4c' }))).not.toContain(other.id);
    expect(ids(await listCards({ q: '1D4C0EFF99' }))).toEqual([b.id]);
    expect(ids(await listCards({ q: ' t_abcdef12 ' }))).toEqual([other.id]);
    // Words still go through the full-text index; a short hex word is not an id and a hex-looking word still matches text.
    expect(ids(await listCards({ q: 'unrelated' }))).toEqual([other.id]);
    expect(await listCards({ q: '1d4' })).toEqual([]);
    const beef = await createCard('owner', { title: 'beef stew' });
    expect(ids(await listCards({ q: 'beef' }))).toEqual([beef.id]);
  });

  it('ids filters the board to one or several cards by id or prefix, and the API takes ?id=', async () => {
    const a = await createCard('owner', { id: 't_1d4c0eff', title: 'One' });
    const b = await createCard('owner', { id: 't_2e5d1f00', title: 'Two' });
    await createCard('owner', { id: 't_3f6e2a11', title: 'Three' });
    expect(ids(await listCards({ ids: ['t_1d4c0eff'] }))).toEqual([a.id]);
    expect(ids(await listCards({ ids: ['1d4c0eff', '#2e5d'] })).sort()).toEqual([a.id, b.id]);
    const r = await request(app()).get('/api/board/cards').query({ id: 't_1d4c0eff,2e5d1f00' }).expect(200);
    expect(ids(r.body.cards).sort()).toEqual([a.id, b.id]);
    await request(app()).get('/api/board/cards').query({ id: 'not-an-id' }).expect(400);
  });

  it('a project filter returns only that project\'s cards; a card made with --project carries the tag', async () => {
    await query(`INSERT INTO projects (slug, title, team_slug, stage) VALUES ('argo-second-brain', 'Argo second brain', 'platform', 'building')`);
    const tagged = await createCard('owner', { title: 'Tagged', project: 'argo-second-brain' });
    await createCard('owner', { title: 'Other project', project: 'secondbrain-app' });
    await createCard('owner', { title: 'No project' });
    expect(tagged.project_slug).toBe('argo-second-brain');
    expect(ids(await listCards({ project: 'argo-second-brain' }))).toEqual([tagged.id]);
    const r = await request(app()).get('/api/board/cards').query({ project: 'argo-second-brain' }).expect(200);
    expect(r.body.cards.map((c: { id: string; project_slug: string }) => [c.id, c.project_slug])).toEqual([[tagged.id, 'argo-second-brain']]);
    await expect(createCard('owner', { title: 'Bad', project: 'no-such-project' })).rejects.toThrow(/no project/);
  });

  it('tagCard sets, changes and clears a card\'s project and feature without touching its assignee', async () => {
    await query(`INSERT INTO projects (slug, title, team_slug, stage) VALUES ('argo-second-brain', 'Argo second brain', 'platform', 'building')`);
    const c = await createCard('atlas', { title: 'Untagged', assignee: 'rune' });
    const before = await wakes();
    const t1 = await tagCard('owner', c.id, { project: 'secondbrain-app', feature: 'board' });
    expect([t1.project_slug, t1.feature_slug, t1.assignee]).toEqual(['secondbrain-app', 'board', 'rune']);
    const t2 = await tagCard('owner', c.id, { project: 'argo-second-brain', feature: null });
    expect([t2.project_slug, t2.feature_slug]).toEqual(['argo-second-brain', null]);
    const t3 = await tagCard('owner', c.id, { project: null, feature: null });
    expect([t3.project_slug, t3.feature_slug, t3.assignee]).toEqual([null, null, 'rune']);
    expect(await wakes()).toEqual(before);
    await expect(tagCard('owner', c.id, { project: 'no-such-project', feature: null })).rejects.toThrow(/no project/);
    await expect(tagCard('owner', c.id, { project: 'secondbrain-app', feature: 'nope' })).rejects.toThrow(/no feature/);
    await expect(tagCard('owner', c.id, { project: null, feature: 'board' })).rejects.toThrow(/feature needs a project/);
    // The giver, the assignee and dispatch may tag; another bot may not.
    expect((await tagCard('atlas', c.id, { project: 'secondbrain-app', feature: null })).project_slug).toBe('secondbrain-app');
    expect((await tagCard('rune', c.id, { project: 'argo-second-brain', feature: null })).project_slug).toBe('argo-second-brain');
    expect((await tagCard('sol', c.id, { project: null, feature: null })).project_slug).toBeNull();
    await expect(tagCard('lena', c.id, { project: 'secondbrain-app', feature: null })).rejects.toThrow(/can't tag/);
    expect((await getCard(c.id)).events.filter((e) => e.kind === 'tagged').length).toBe(6);
    // The page's door: POST /cards/:id/project, as the owner.
    const r = await request(app()).post(`/api/board/cards/${c.id}/project`).send({ project: 'secondbrain-app', feature: 'board' }).expect(200);
    expect([r.body.card.project_slug, r.body.card.feature_slug]).toEqual(['secondbrain-app', 'board']);
    const cleared = await request(app()).post(`/api/board/cards/${c.id}/project`).send({ project: null }).expect(200);
    expect([cleared.body.card.project_slug, cleared.body.card.feature_slug]).toEqual([null, null]);
    await request(app()).post(`/api/board/cards/${c.id}/project`).send({ project: 'no-such-project' }).expect(404);
  });
});

describe('tokens and the API', () => {
  const app = () => createApp({ modules: ALL_MODULES, board: { owner: 'owner' } });

  it('a token names one roster member; it is hashed, seen, revocable, and dead with a retired agent', async () => {
    const t = await createToken('rune', 'laptop');
    expect(t.token).toMatch(/^sbb_[A-Za-z0-9_-]{43}$/);
    expect(await findToken(t.token)).toEqual({ id: t.id, agent: 'rune' });
    expect(await findToken('sbb_nope')).toBeNull();
    const [row] = await listTokens();
    expect(row).toMatchObject({ agent_name: 'rune', label: 'laptop', revoked_at: null });
    expect(row!.last_seen_at).not.toBeNull();
    expect((await query<{ token_hash: string }>(`SELECT token_hash FROM board_tokens`)).rows[0]!.token_hash).not.toContain(t.token.slice(4, 20));
    await expect(createToken('ghost')).rejects.toThrow(/unknown agent/);
    expect(await revokeToken(t.id)).toBe(true);
    expect(await revokeToken(t.id)).toBe(false);
    expect(await findToken(t.token)).toBeNull();
    const t2 = await createToken('lena');
    await importOrg({ ...ORG, agents: Object.fromEntries(Object.entries(ORG.agents).filter(([n]) => n !== 'lena')) });
    expect(await findToken(t2.token)).toBeNull();
  });

  it('the session door acts as the owner; the token door as its agent; the rules follow', async () => {
    const a = app();
    const made = await request(a).post('/api/board/cards').send({ title: 'From the page', assignee: 'rune', project: 'secondbrain-app', feature: 'board', work: 'coding' }).expect(201);
    expect(made.body.card).toMatchObject({ created_by: 'owner', assignee: 'rune', status: 'ready', work_type: 'coding', needs: 'code' });
    expect(made.body.message).toMatchObject({ channel_slug: 'platform', author: 'owner' });
    const id = made.body.card.id as string;
    const rune = (await createToken('rune', 'rune box')).token;
    const vera = (await createToken('vera')).token;
    await request(a).get('/api/board/cards').set('Authorization', 'Bearer sbb_bad').expect(401);
    const list = await request(a).get('/api/board/cards').set('Authorization', `Bearer ${rune}`).expect(200);
    expect(list.body.cards.map((c: { id: string }) => c.id)).toEqual([id]);
    const comment = await request(a).post(`/api/board/cards/${id}/comment`).set('Authorization', `Bearer ${rune}`).send({ body: 'on it' }).expect(201);
    expect(comment.body.comment.author).toBe('rune');
    // vera may not finish rune's card; rune may, once it is running; a token may not read tokens.
    await request(a).post(`/api/board/cards/${id}/finish`).set('Authorization', `Bearer ${vera}`).send({ outcome: 'done' }).expect(403);
    const claimed = await request(a).post('/api/board/claim').set('Authorization', `Bearer ${rune}`).send({ agent: 'rune' }).expect(200);
    expect(claimed.body.card.id).toBe(id);
    await request(a).post('/api/board/claim').set('Authorization', `Bearer ${rune}`).send({ agent: 'rune' }).expect(204);
    await request(a).post(`/api/board/cards/${id}/heartbeat`).set('Authorization', `Bearer ${rune}`).send({ tokens: 10 }).expect(200);
    const done = await request(a).post(`/api/board/cards/${id}/finish`).set('Authorization', `Bearer ${rune}`).send({ outcome: 'done', result: 'PR 3', verification: { check: 'npm test' } }).expect(200);
    expect(done.body.card.status).toBe('done');
    expect((await query<{ n: number }>(`SELECT count(*)::int AS n FROM verifications`)).rows[0]!.n).toBe(1);
    await request(a).get('/api/board/tokens').set('Authorization', `Bearer ${rune}`).expect(403);
    const tokens = await request(a).get('/api/board/tokens').expect(200);
    expect(tokens.body.tokens.map((t: { agent_name: string }) => t.agent_name).sort()).toEqual(['rune', 'vera']);
    const runeRow = tokens.body.tokens.find((t: { agent_name: string }) => t.agent_name === 'rune') as { id: number };
    await request(a).post(`/api/board/tokens/${runeRow.id}/revoke`).expect(200);
    await request(a).get('/api/board/cards').set('Authorization', `Bearer ${rune}`).expect(401);
    await request(a).post('/api/board/tokens/999/revoke').expect(404);
    // Bad input is a 400, a missing card a 404, ship-now from a bot a 403.
    await request(a).post('/api/board/cards').send({ title: '' }).expect(400);
    await request(a).get('/api/board/cards/t_00000000').expect(404);
    await request(a).post(`/api/board/cards/${id}/flags`).set('Authorization', `Bearer ${vera}`).send({ ship_now: true }).expect(403);
    const detail = await request(a).get(`/api/board/cards/${id}`).expect(200);
    expect(detail.body.events.map((e: { kind: string }) => e.kind)).toEqual(['created', 'commented', 'claimed', 'heartbeat', 'finished']);
    expect(detail.body.runs[0]).toMatchObject({ outcome: 'done', tokens: 10 });
    // Unassign, assign, move and link from the page, and the boards list.
    const other = await request(a).post('/api/board/cards').send({ title: 'Loose end' }).expect(201);
    await request(a).post(`/api/board/cards/${other.body.card.id}/assign`).send({ assignee: 'lena' }).expect(200);
    await request(a).post(`/api/board/cards/${other.body.card.id}/assign`).send({ assignee: null }).expect(200);
    await request(a).post(`/api/board/cards/${other.body.card.id}/move`).send({ status: 'triage' }).expect(200);
    await request(a).post(`/api/board/cards/${other.body.card.id}/link`).send({ depends_on: id }).expect(200);
    expect((await request(a).get('/api/board/boards').expect(200)).body.boards[0]).toMatchObject({ slug: 'exo', open: 1 });
    await request(a).get('/api/board/cards/t_00000000/log').expect(404);
    expect((await request(a).post('/api/board/reclaim').expect(200)).body).toEqual({ reclaimed: 0 });
  });

  it('is not mounted when the module is off', async () => {
    const off = createApp({ modules: new Set(['org'] as const) });
    await request(off).get('/api/board/cards').expect(404);
  });

  it('the live bus relays board events from pg_notify', async () => {
    const bus = new BoardBus(ownerUrl);
    const seen: { card: string; kind: string }[] = [];
    const off = bus.subscribe((n) => seen.push({ card: n.card, kind: n.kind }));
    await new Promise((r) => setTimeout(r, 300));
    const c = await createCard('owner', { title: 'Live', assignee: 'rune' });
    await commentCard('owner', c.id, 'hello');
    await new Promise((r) => setTimeout(r, 400));
    off();
    await bus.close();
    expect(seen).toEqual([{ card: c.id, kind: 'created' }, { card: c.id, kind: 'commented' }]);
  });
});

describe('the CLI', () => {
  const run = async (argv: string[], env: NodeJS.ProcessEnv = {}, fetchFn: typeof fetch = fetch): Promise<{ code: number; lines: string[] }> => {
    const lines: string[] = [];
    const code = await main(argv, (s) => lines.push(s), { ...process.env, BOARD_URL: undefined, BOARD_TOKEN: undefined, ...env }, fetchFn);
    return { code, lines };
  };

  it('drives the board as the owner through the database door', async () => {
    const made = await run(['create', 'Write the docs', '--to', 'lena', '--project', 'secondbrain-app', '--priority', '2', '--type', 'writing']);
    expect(made.code).toBe(0);
    const id = /card (t_[0-9a-f]+) for lena \[ready\]/.exec(made.lines[0]!)![1]!;
    expect(made.lines[0]).toContain('noted as');
    const list = await run(['list', '--assignee', 'lena']);
    expect(list.lines[0]).toMatch(new RegExp(`^${id}  \\[ready    \\] p2 lena`));
    const shown = await run(['show', id, '--json']);
    expect(JSON.parse(shown.lines[0]!).card.work_type).toBe('writing');
    expect((await run(['comment', id, 'go'])).lines[0]).toBe(`commented on ${id}`);
    expect((await run(['claim', '--runtime', 'hermes'])).lines[0]).toMatch(/^claimed t_/);
    expect((await run(['claim', '--runtime', 'hermes'])).code).toBe(3);
    expect((await run(['heartbeat', id, '--tokens', '12'])).code).toBe(0);
    const fin = await run(['finish', id, '--done', 'docs/board.md', '--tokens', '300', '--turns', '5']);
    expect(fin.lines[0]).toBe(`${id} is done: docs/board.md`);
    const detail = await run(['show', id]);
    expect(detail.lines[0]).toContain('result: docs/board.md');
    expect(detail.lines[0]).toMatch(/Runs:\n- #\d+ lena \(hermes\).*→ done.*300 tokens/);
    expect((await run(['boards'])).lines[0]).toMatch(/^exo\s+0 open  Exo$/);
    // Tokens from the CLI, shown once.
    const tok = await run(['token', 'create', 'rune', '--label', 'laptop']);
    expect(tok.lines[0]).toMatch(/^token \d+ for rune \(shown once.*\):\nsbb_/);
    expect((await run(['token', 'list'])).lines[0]).toMatch(/^#\d+ rune\s+laptop/);
    const tid = /^token (\d+)/.exec(tok.lines[0]!)![1]!;
    expect((await run(['token', 'revoke', tid])).lines[0]).toBe(`token ${tid} revoked`);
    expect((await run(['help'])).lines[0]).toContain('cli-board <command>');
    await expect(run(['finish', id])).rejects.toThrow(/finish needs --done/);
  });

  it('runs as an agent through the RLS role, and refuses what is not its own', async () => {
    const owner = await run(['create', 'Fix it', '--to', 'rune', '--project', 'secondbrain-app', '--type', 'coding']);
    const id = /card (t_[0-9a-f]+)/.exec(owner.lines[0]!)![1]!;
    const env = { ORG_AGENT: 'rune', SB_ORG_DB_URL: `postgres://sb_org@${process.env.PGHOST ?? 'localhost'}:${process.env.PGPORT ?? '5432'}/${TEST_DB}` };
    try {
      const list = await run(['list', '--json'], env);
      expect(JSON.parse(list.lines[0]!).map((c: { id: string }) => c.id)).toEqual([id]);
      expect((await run(['claim', '--agent', 'rune'], env)).lines[0]).toBe(`claimed ${id} for rune: Fix it`);
      await expect(run(['finish', id, '--done', 'x'], { ...env, ORG_AGENT: 'vera' })).rejects.toThrow(/can't finish rune's card/);
      expect((await run(['finish', id, '--blocked', 'needs-owner', 'which repo?'], env)).lines[0]).toBe(`${id} is blocked (needs-owner)`);
      await expect(run(['token', 'list'], env)).rejects.toThrow(/permission denied/);
    } finally {
      setDatabaseUrl(ownerUrl);
    }
  });

  it('a lead giving the vault assignee a card through the RLS role provisions its roster row, not a direct INSERT', async () => {
    // Regression: cardTarget() used to INSERT/UPDATE org_agents directly, which sb_org (SELECT-only) can't do.
    // `cli-org task create` and a bot's own wakes always run with ORG_AGENT set, so --to vault-session failed
    // with "permission denied for table org_agents" for every caller except the owner's unauthenticated connection.
    const env = { ORG_AGENT: 'atlas', SB_ORG_DB_URL: `postgres://sb_org@${process.env.PGHOST ?? 'localhost'}:${process.env.PGPORT ?? '5432'}/${TEST_DB}` };
    try {
      const made = await run(['create', 'Vault thing over RLS', '--to', 'vault-session', '--project', 'secondbrain-app'], env);
      expect(made.code).toBe(0);
      expect(made.lines[0]).toContain('for vault-session');
      expect((await getAgent('vault-session')).runtime).toBe('session');
      // The legacy slug works the same way, and a second call just clears retired_at again (no error).
      await run(['create', 'Vault thing, legacy slug', '--to', 'm4', '--project', 'secondbrain-app'], env);
      expect((await getAgent('m4')).runtime).toBe('session');
    } finally {
      setDatabaseUrl(ownerUrl);
    }
  });

  it('speaks to the app over HTTP with a token (the second door), same verbs', async () => {
    const a = createApp({ modules: ALL_MODULES, board: { owner: 'owner' } });
    const server: Server = createServer(a);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const token = (await createToken('rune', 'laptop')).token;
      const env = { BOARD_URL: url, BOARD_TOKEN: token };
      const made = await run(['create', 'Over HTTP', '--to', 'rune'], env);
      expect(made.lines[0]).toMatch(/^card t_[0-9a-f]+ for rune \[ready\]: Over HTTP$/);
      const id = /card (t_[0-9a-f]+)/.exec(made.lines[0]!)![1]!;
      expect((await run(['list'], env)).lines[0]).toContain(id);
      expect((await run(['comment', id, 'hi'], env)).lines[0]).toBe(`commented on ${id}`);
      expect((await getCard(id)).comments[0]).toMatchObject({ author: 'rune', body: 'hi' });
      expect((await run(['claim', '--agent', 'rune'], env)).lines[0]).toMatch(/^claimed/);
      expect((await run(['claim', '--agent', 'rune'], env)).code).toBe(3);
      expect((await run(['finish', id, '--done', 'ok', '--verify', 'npm test'], env)).lines[0]).toBe(`${id} is done: ok`);
      await expect(run(['token', 'list'], env)).resolves.toBeDefined();   // tokens stay on the database door (the owner's own machine)
      await expect(run(['list'], { BOARD_URL: url, BOARD_TOKEN: 'sbb_wrong' })).rejects.toThrow(/board 401/);
      const http = new HttpBoard(url, token);
      expect((await http.boards())[0]!.slug).toBe('exo');
      expect(formatCard((await http.list({}))[0]!)).toContain('Over HTTP');
      expect(formatDetail(await http.show(id))).toContain('result: ok');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('imports a Hermes export, reports drift, and adds nothing twice', async () => {
    const exported = JSON.stringify([
      { id: 't_0a0a0a01', title: 'Old one', body: 'from hermes', assignee: 'researcher', status: 'done', priority: 2, created_by: 'owner', created_at: 1_760_000_000, completed_at: 1_760_000_900, result: 'a note', comments: [{ author: 'researcher', body: 'done', created_at: 1_760_000_800 }] },
      { task: { id: 't_0a0a0a02', title: 'Still open', assignee: 'rune', status: 'ready', created_by: 'atlas', created_at: '2026-10-20T10:00:00Z' }, parents: ['t_0a0a0a01'] },
      { id: 'bad', title: 'skipped' },
    ]);
    const docs = parseHermesExport(exported);
    expect(docs.map((d) => d.id)).toEqual(['t_0a0a0a01', 't_0a0a0a02', 'bad']);
    const r = await importHermesCards('exo', docs, 'owner');
    expect(r).toEqual({ cards: 2, comments: 1, agents: 1, deps: 1 });
    expect((await getAgent('researcher')).runtime).toBe('hermes');
    const old = await getCard('t_0a0a0a01');
    expect(old.card).toMatchObject({ status: 'done', result: 'a note', assignee: 'researcher', created_by: 'owner' });
    expect(old.comments[0]).toMatchObject({ author: 'researcher', body: 'done' });
    expect((await getCard('t_0a0a0a02')).depends_on.map((d) => d.id)).toEqual(['t_0a0a0a01']);
    expect(await importHermesCards('exo', docs, 'owner')).toEqual({ cards: 2, comments: 0, agents: 0, deps: 0 });
    await moveCard('owner', 't_0a0a0a02', 'blocked', 'x');
    const drift = await driftReport('exo', docs.slice(0, 1));
    expect(drift).toEqual({ onlyHermes: [], onlyEngine: ['t_0a0a0a02'], statusDiffers: [] });
    expect((await driftReport('exo', docs)).statusDiffers).toEqual([{ id: 't_0a0a0a02', engine: 'blocked', hermes: 'ready' }]);
  });
});

describe('cli-board parity: --repo/--ship-now on assign, redo, unknown flags', () => {
  const run = async (argv: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; lines: string[] }> => {
    const lines: string[] = [];
    const code = await main(argv, (s) => lines.push(s), { ...process.env, BOARD_URL: undefined, BOARD_TOKEN: undefined, ...env });
    return { code, lines };
  };

  it('assign forwards --repo and --ship-now instead of dropping them', async () => {
    const made = await run(['create', 'Parity card', '--to', 'lena']);
    const id = /card (t_[0-9a-f]+)/.exec(made.lines[0]!)![1]!;
    const r = await run(['assign', id, 'lena', '--repo', 'reports', '--ship-now']);
    expect(r.code).toBe(0);
    expect(r.lines[0]).toBe(`${id} is now lena [ready]`);
    const card = JSON.parse((await run(['show', id, '--json'])).lines[0]!).card;
    expect(card.repo).toBe('reports');
    expect(card.ship_now).toBe(true);
    // ship-now stays the owner's: a bot caller is refused, not silently allowed.
    const botEnv = { ORG_AGENT: 'sol', SB_ORG_DB_URL: `postgres://sb_org@${process.env.PGHOST ?? 'localhost'}:${process.env.PGPORT ?? '5432'}/${TEST_DB}` };
    try {
      await expect(run(['assign', id, 'lena', '--ship-now'], botEnv)).rejects.toThrow(/only the owner can mark a card ship-now/);
    } finally {
      setDatabaseUrl(ownerUrl);
    }
  });

  it('an unknown flag is a hard error, not a silent drop', async () => {
    const made = await run(['create', 'Flag card', '--to', 'rune']);
    const id = /card (t_[0-9a-f]+)/.exec(made.lines[0]!)![1]!;
    await expect(run(['list', '--repo', 'x'])).rejects.toThrow(/unknown flag --repo for "list"/);
    await expect(run(['assign', id, 'rune', '--nope', 'x'])).rejects.toThrow(/unknown flag --nope/);
    // A flag the verb does know still passes, and --json is always accepted.
    expect((await run(['list', '--assignee', 'rune'])).code).toBe(0);
    expect((await run(['list', '--json'])).code).toBe(0);
  });

  it('redo asks for a new round on the reviewed card', async () => {
    const spec = await run(['create', 'Spec', '--to', 'atlas', '--kind', 'spec']);
    const specId = /card (t_[0-9a-f]+)/.exec(spec.lines[0]!)![1]!;
    const build = await run(['create', 'Build', '--to', 'rune', '--kind', 'build', '--after', specId]);
    const buildId = /card (t_[0-9a-f]+)/.exec(build.lines[0]!)![1]!;
    const review = await run(['create', 'Review', '--to', 'vera', '--kind', 'review', '--after', buildId]);
    const reviewId = /card (t_[0-9a-f]+)/.exec(review.lines[0]!)![1]!;
    const r = await run(['redo', reviewId, 'tighten the error handling']);
    expect(r.code).toBe(0);
    expect(r.lines[0]).toMatch(/^round 1 requested on t_[0-9a-f]+ from t_/);
    const mine = JSON.parse((await run(['list', '--assignee', 'rune', '--json'])).lines[0]!) as { title: string; rounds: number }[];
    expect(mine.some((c) => c.rounds === 1 && /\(round 1\)/.test(c.title))).toBe(true);
  });

  it('the API takes repo/ship_now on assign and exposes a redo route', async () => {
    const a = createApp({ modules: ALL_MODULES, board: { owner: 'owner' } });
    const made = await request(a).post('/api/board/cards').send({ title: 'API parity', assignee: 'lena', project: 'secondbrain-app' }).expect(201);
    const id = made.body.card.id as string;
    const assigned = await request(a).post(`/api/board/cards/${id}/assign`).send({ assignee: 'lena', repo: 'reports', ship_now: true }).expect(200);
    expect(assigned.body.card).toMatchObject({ repo: 'reports', ship_now: true });
    // redo needs a review card waiting on a built card.
    const build = await request(a).post('/api/board/cards').send({ title: 'Build', assignee: 'rune', kind: 'build' }).expect(201);
    const review = await request(a).post('/api/board/cards').send({ title: 'Review', assignee: 'vera', kind: 'review', deps: [build.body.card.id] }).expect(201);
    const redo = await request(a).post(`/api/board/cards/${review.body.card.id}/redo`).send({ changes: 'fix the retry' }).expect(200);
    expect(redo.body).toMatchObject({ escalated: false, rounds: 1 });
    expect(redo.body.task_id).toBeTruthy();
    await request(a).post(`/api/board/cards/${review.body.card.id}/redo`).send({}).expect(400);
  });
});

afterAll(() => setDatabaseUrl(ownerUrl));
