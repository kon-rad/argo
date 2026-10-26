import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { main } from '../src/cli-org.js';
import { config } from '../src/config.js';
import { query, setDatabaseUrl } from '../src/db.js';
import { applyGraph, assertMayAssign, assignTask, createTask, getAgent, importOrg, listTasks, redoTask, resolveAssignee } from '../src/org.js';
import { ALL_MODULES, truncateAll } from './helpers.js';

/**
 * The work graph: one card, one bot, one project. The record is the engine's board (cards); ids are minted by
 * the board function.
 */

const ORG = {
  version: 'tasks-1',
  company: 'Argo',
  ceo: 'owner',
  agents: {
    owner: { runtime: 'human', role: 'CEO', channels: ['*'] },
    atlas: { role: 'Head of Platform', team: 'platform', reports_to: 'owner' },
    rune: { role: 'Platform engineer', team: 'platform', reports_to: 'atlas', capabilities: ['code', 'web'] },
    juno: { role: 'Head of Media', team: 'media', reports_to: 'owner' },
    lena: { role: 'Writer', team: 'media', reports_to: 'juno' },
  },
  teams: { platform: { name: 'Platform', lead: 'atlas' }, media: { name: 'Media', lead: 'juno' } },
  channels: { 'all-hands': { members: '*' }, leads: { members: ['owner', 'atlas', 'juno'] } },
};

/** Cards already on the engine's board (made from the page, or imported), unassigned. */
async function seedCards(rows: [string, string, string][]): Promise<void> {
  await query(`INSERT INTO boards (slug, name) VALUES ('exo', 'Exo') ON CONFLICT DO NOTHING`);
  for (const [id, title, status] of rows) await query(`INSERT INTO cards (id, board_slug, title, status, created_by) VALUES ($1, 'exo', $2, $3, 'owner')`, [id, title, status]);
}

describe('cards for bots', () => {
  beforeEach(async () => {
    await truncateAll();
    await importOrg(ORG);
    await query(`INSERT INTO projects (slug, title, team_slug, stage) VALUES ('secondbrain-app', 'Second Brain app', 'platform', 'building')`);
    await query(`INSERT INTO features (project_slug, slug, title, stage, owner) VALUES ('secondbrain-app', 'org-page', 'The /org page', 'testing', 'claude-code')`);
  });

  it('owner gives rune a card: board card, link row, feature owner, mention in #platform', async () => {
    const owner = await getAgent('owner');
    const r = await createTask(owner, { assignee: 'rune', title: 'Add the tasks route', body: 'GET /api/org/tasks', project: 'secondbrain-app', feature: 'org-page' });
    const id = r.task_id;
    expect(id).toMatch(/^t_[0-9a-f]{8}$/);
    expect(r.card).toMatchObject({ assignee: 'rune', created_by: 'owner', title: 'Add the tasks route' });
    const body = r.card.body!;
    expect(body).toContain('Project: secondbrain-app/org-page');
    expect(body).toContain('--kind status --task <this card> --project secondbrain-app --feature org-page');
    expect(body.endsWith('GET /api/org/tasks')).toBe(true);
    expect(r.link).toMatchObject({ task_id: id, board: 'exo', project_slug: 'secondbrain-app', feature_slug: 'org-page', assignee: 'rune', created_by: 'owner', rounds: 0 });
    const { rows } = await query<{ owner: string }>(`SELECT owner FROM features WHERE slug = 'org-page'`);
    expect(rows[0]!.owner).toBe('rune');
    expect(r.message).toMatchObject({ channel_slug: 'platform', kind: 'message', author: 'owner', task_id: id, project_slug: 'secondbrain-app', feature_slug: 'org-page', mentions: [] });
    expect(r.card).toMatchObject({ id, status: 'ready', board_slug: 'exo', kind: 'work', needs: null });
    // The note names rune without a mention: the ready card itself wakes rune, once (reason task), and nothing else does.
    const { rows: wakes } = await query<{ agent_name: string; reason: string; ref: string }>(`SELECT agent_name, reason, ref FROM org_wakeups WHERE done_at IS NULL ORDER BY id`);
    expect(wakes).toEqual([{ agent_name: 'rune', reason: 'task', ref: id }]);
    expect((await query<{ kind: string }>(`SELECT kind FROM card_events WHERE card_id = $1 ORDER BY id`, [id])).rows.map((e) => e.kind)).toEqual(['created']);
    expect((await listTasks({ project: 'secondbrain-app' })).map((t) => t.task_id)).toEqual([id]);
    expect((await listTasks({ agent: 'lena' })).length).toBe(0);
  });

  it('a lead assigns inside its team, a member only itself, nobody a human', async () => {
    const [atlas, rune, lena, owner] = await Promise.all(['atlas', 'rune', 'lena', 'owner'].map(getAgent));
    await expect(assertMayAssign(atlas!, rune!)).resolves.toBeUndefined();
    await expect(assertMayAssign(atlas!, lena!)).rejects.toThrow(/inside its team/);
    await expect(assertMayAssign(rune!, atlas!)).rejects.toThrow(/only to itself/);
    await expect(assertMayAssign(rune!, rune!)).resolves.toBeUndefined();
    await expect(assertMayAssign(owner!, lena!)).resolves.toBeUndefined();
    await expect(assertMayAssign(atlas!, owner!)).rejects.toThrow(/not a bot/);
    // A self-assigned card posts nothing.
    const r = await createTask(rune!, { assignee: 'rune', title: 'Follow-up: tests', project: 'secondbrain-app' });
    expect(r.message).toBeNull();
    expect(r.link.feature_slug).toBeNull();
  });

  it('assigns an existing card to a bot: a comment with the closing commands, the link row, a mention', async () => {
    const owner = await getAgent('owner');
    await seedCards([['t_01d00001', 'Second Brain app:  mobile-first update', 'ready'], ['t_01d00002', 'Old', 'done'], ['t_01d00003', 'Busy', 'running']]);
    const r = await assignTask(owner, { taskId: 't_01d00001', assignee: 'rune', project: 'secondbrain-app', feature: 'org-page' });
    expect(r.link).toMatchObject({ task_id: 't_01d00001', assignee: 'rune', project_slug: 'secondbrain-app', feature_slug: 'org-page', title: 'Second Brain app:  mobile-first update', kind: 'work' });
    // The closing commands are on the card as a comment, as the owner.
    const { rows: comments } = await query<{ author: string; body: string }>(`SELECT author, body FROM card_comments WHERE card_id = 't_01d00001'`);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ author: 'owner' });
    expect(comments[0]!.body).toContain('Project: secondbrain-app/org-page');
    expect(comments[0]!.body).toContain('cli-board finish <this card>');
    expect((await query<{ owner: string }>(`SELECT owner FROM features WHERE slug = 'org-page'`)).rows[0]!.owner).toBe('rune');
    expect(r.message).toMatchObject({ channel_slug: 'platform', mentions: [], task_id: 't_01d00001' });
    expect((await listTasks({ agent: 'rune' })).map((l) => l.task_id)).toEqual(['t_01d00001']);
    // A finished or running card is refused before anything is written; so is a card the board doesn't know.
    await expect(assignTask(owner, { taskId: 't_01d00002', assignee: 'rune', project: 'secondbrain-app' })).rejects.toThrow('is done');
    await expect(assignTask(owner, { taskId: 't_01d00003', assignee: 'rune', project: 'secondbrain-app' })).rejects.toThrow('is running');
    await expect(assignTask(owner, { taskId: 't_01d00009', assignee: 'rune', project: 'secondbrain-app' })).rejects.toThrow('no card t_01d00009');
    // A member can't take someone else's card for a teammate; the lead can.
    await expect(assignTask(await getAgent('rune'), { taskId: 't_01d00001', assignee: 'atlas', project: 'secondbrain-app' })).rejects.toThrow("can't give");
    const byLead = await assignTask(await getAgent('atlas'), { taskId: 't_01d00001', assignee: 'rune', project: 'secondbrain-app' });
    expect(byLead.link.feature_slug).toBeNull();
  });

  it('a card carries its kind of work: --type on create and assign, a graph template\'s work, the review round inherits it', async () => {
    const owner = await getAgent('owner');
    const r = await createTask(owner, { assignee: 'rune', title: 'Write the cap note', project: 'secondbrain-app', type: 'writing' });
    expect(r.link.work_type).toBe('writing');
    await expect(createTask(owner, { assignee: 'rune', title: 'x', project: 'secondbrain-app', type: 'dancing' })).rejects.toThrow(/--type dancing/);
    await seedCards([['t_01d00005', 'Design the kiosk', 'ready']]);
    const a = await assignTask(owner, { taskId: 't_01d00005', assignee: 'rune', project: 'secondbrain-app', type: 'design' });
    expect(a.link.work_type).toBe('design');
    // Assigning again without a type keeps the one it has.
    expect((await assignTask(owner, { taskId: 't_01d00005', assignee: 'rune', project: 'secondbrain-app' })).link.work_type).toBe('design');
    const g = await applyGraph(owner, { name: 'research-note', work: 'research', nodes: [
      { id: 'research', assign: 'rune', title: 'Research: {title}', after: [], kind: 'build' },
      { id: 'review', assign: 'lead', title: 'Review: {title}', after: ['research'], kind: 'review' },
    ] }, { project: 'secondbrain-app' });
    const links = await listTasks({ project: 'secondbrain-app' });
    expect(links.find((l) => l.task_id === g.cards[0]!.task_id)!.work_type).toBe('research');
    expect(links.find((l) => l.task_id === g.cards[1]!.task_id)!.work_type).toBe('research');
  });

  it('refuses an unknown project or feature before writing a card', async () => {
    const owner = await getAgent('owner');
    await expect(createTask(owner, { assignee: 'rune', title: 'x', project: 'nope' })).rejects.toThrow(/no project "nope"/);
    await expect(createTask(owner, { assignee: 'rune', title: 'x', project: 'secondbrain-app', feature: 'nope' })).rejects.toThrow(/no feature/);
    expect((await query(`SELECT 1 FROM cards`)).rowCount).toBe(0);
  });

  it('cli-org task create makes a board card and task list shows it', async () => {
    process.env.ORG_AGENT = 'owner';
    const lines: string[] = [];
    try {
      expect(await main(['task', 'create', 'lena', 'Draft the launch post', '--project', 'secondbrain-app', '--priority', '3'], (s) => lines.push(s))).toBe(0);
      expect(lines[0]).toMatch(/^card t_[0-9a-f]{8} for lena: Draft the launch post \(secondbrain-app\) \[ready\]; mention \d+ in #media$/);
      expect((await query<{ priority: number }>(`SELECT priority FROM cards WHERE title = 'Draft the launch post'`)).rows[0]!.priority).toBe(3);
      lines.length = 0;
      expect(await main(['task', 'list', '--agent', 'lena'], (s) => lines.push(s))).toBe(0);
      expect(lines[0]).toMatch(/lena\s+secondbrain-app\s+Draft the launch post/);
    } finally {
      delete process.env.ORG_AGENT;
    }
  });

  it('runs as the sb_org role the way the droplet does (ORG_AGENT + SB_ORG_DB_URL): reads features, writes through the definer', async () => {
    process.env.ORG_AGENT = 'atlas';
    process.env.SB_ORG_DB_URL = `postgres://sb_org@${process.env.PGHOST ?? 'localhost'}:${process.env.PGPORT ?? '5432'}/${process.env.SB_TEST_DB ?? 'secondbrain_test'}`;
    const lines: string[] = [];
    try {
      expect(await main(['task', 'create', 'rune', 'Wire it', '--project', 'secondbrain-app', '--feature', 'org-page', '--json'], (s) => lines.push(s))).toBe(0);
      const r = JSON.parse(lines[0]!) as { link: { assignee: string; created_by: string } };
      expect(r.link).toMatchObject({ assignee: 'rune', created_by: 'atlas' });
      // A lead outside its team is refused by the rule, and the definer refuses a forged caller.
      await expect(main(['task', 'create', 'lena', 'x', '--project', 'secondbrain-app'])).rejects.toThrow(/inside its team/);
    } finally {
      delete process.env.ORG_AGENT;
      delete process.env.SB_ORG_DB_URL;
      setDatabaseUrl(`postgres://${process.env.PGHOST ?? 'localhost'}:${process.env.PGPORT ?? '5432'}/${process.env.SB_TEST_DB ?? 'secondbrain_test'}`);
    }
    const { rows } = await query<{ owner: string }>(`SELECT owner FROM features WHERE slug = 'org-page'`);
    expect(rows[0]!.owner).toBe('rune');
  });

  it('assigns an existing card to the vault assignee with --repo vault through the sb_org role', async () => {
    // Regression (t_f25205f5): assignTask() set cards.repo with a direct `UPDATE cards` over the sb_org connection,
    // which has only SELECT on cards -> "permission denied for table cards". It only surfaced when the repo
    // changed (a vault card starts with repo NULL), so `cli-org task assign <card> m4 --repo vault` -- the
    // 2026-10-21 vault-code rule -- failed for exactly the cards it was meant for. The write now rides
    // board_card_assign() (SECURITY DEFINER). Repro before the fix: card with repo NULL -> permission denied.
    await seedCards([['t_01d000aa', 'Needs the M4', 'ready']]);
    process.env.ORG_AGENT = 'atlas';
    process.env.SB_ORG_DB_URL = `postgres://sb_org@${process.env.PGHOST ?? 'localhost'}:${process.env.PGPORT ?? '5432'}/${process.env.SB_TEST_DB ?? 'secondbrain_test'}`;
    const lines: string[] = [];
    try {
      expect((await query<{ repo: string | null }>(`SELECT repo FROM cards WHERE id = 't_01d000aa'`)).rows[0]!.repo).toBeNull();
      expect(await main(['task', 'assign', 't_01d000aa', 'm4', '--project', 'secondbrain-app', '--type', 'ops', '--repo', 'vault', '--json'], (s) => lines.push(s))).toBe(0);
      const r = JSON.parse(lines[0]!) as { link: { task_id: string; assignee: string } };
      expect(r.link).toMatchObject({ task_id: 't_01d000aa', assignee: 'm4' });
      // The repo is a column the link does not carry; the write is what this card fixes, so assert the row.
      const after = await query<{ assignee: string; repo: string | null }>(`SELECT assignee, repo FROM cards WHERE id = 't_01d000aa'`);
      expect(after.rows[0]).toMatchObject({ assignee: 'm4', repo: 'vault' });
    } finally {
      delete process.env.ORG_AGENT;
      delete process.env.SB_ORG_DB_URL;
      setDatabaseUrl(`postgres://${process.env.PGHOST ?? 'localhost'}:${process.env.PGPORT ?? '5432'}/${process.env.SB_TEST_DB ?? 'secondbrain_test'}`);
    }
  });

  it('GET /api/org/tasks lists links by project, feature and bot', async () => {
    const owner = await getAgent('owner');
    await createTask(owner, { assignee: 'rune', title: 'A', project: 'secondbrain-app', feature: 'org-page' });
    await createTask(owner, { assignee: 'lena', title: 'B', project: 'secondbrain-app' });
    const app = createApp({ modules: ALL_MODULES, vaultRoot: mkdtempSync(join(tmpdir(), 'sb-vault-')) });
    const all = await request(app).get('/api/org/tasks').expect(200);
    expect(all.body.tasks.map((t: { title: string }) => t.title)).toEqual(['B', 'A']);
    const one = await request(app).get('/api/org/tasks?feature=org-page').expect(200);
    expect(one.body.tasks.map((t: { assignee: string }) => t.assignee)).toEqual(['rune']);
    await request(app).get('/api/org/tasks?agent=Not-Valid').expect(400);
  });
});

/** Graph templates and the review loop. Card ids are minted by the board function, so the tests read them back. */
describe('graphs and the review loop', () => {
  const TEMPLATE = {
    name: 'feature-build',
    nodes: [
      { id: 'spec', assign: 'lead', title: 'Spec: {title}', after: [], kind: 'spec' },
      { id: 'build', assign: 'role:engineer', title: 'Build: {title}', body: 'Build {feature} for {project}.', after: ['spec'], kind: 'build' },
      { id: 'review', assign: 'role:review', title: 'Review: {title}', after: ['build'], kind: 'review' },
      { id: 'verify', assign: 'lead', title: 'Verify: {title}', after: ['review'], kind: 'verify' },
    ],
  };

  beforeEach(async () => {
    await truncateAll();
    await importOrg({ ...ORG, agents: { ...ORG.agents, vera: { role: 'Reviewer', team: 'platform', reports_to: 'atlas' } } });
    await query(`INSERT INTO projects (slug, title, team_slug, stage) VALUES ('secondbrain-app', 'Second Brain app', 'platform', 'building')`);
    await query(`INSERT INTO features (project_slug, slug, title, stage, owner) VALUES ('secondbrain-app', 'org-page', 'The /org page', 'testing', 'claude-code')`);
  });

  it('resolves lead, role:<word> and names on the project team; the lead is the fallback', async () => {
    expect(await resolveAssignee('lead', 'platform', 'atlas')).toBe('atlas');
    expect(await resolveAssignee('role:engineer', 'platform', 'atlas')).toBe('rune');
    expect(await resolveAssignee('role:review', 'platform', 'atlas')).toBe('vera');
    expect(await resolveAssignee('role:designer', 'platform', 'atlas')).toBe('atlas');
    expect(await resolveAssignee('lena', 'platform', 'atlas')).toBe('lena');
    await expect(resolveAssignee('role:engineer', null, null)).rejects.toThrow(/needs a team/);
  });

  it('applies a template: cards in order with their parents, roots mentioned, one summary post', async () => {
    const owner = await getAgent('owner');
    const dry = await applyGraph(owner, TEMPLATE, { project: 'secondbrain-app', feature: 'org-page', dryRun: true });
    expect(dry.cards.map((c) => [c.node, c.assignee, c.task_id])).toEqual([['spec', 'atlas', null], ['build', 'rune', null], ['review', 'vera', null], ['verify', 'atlas', null]]);
    expect((await query(`SELECT 1 FROM cards`)).rowCount).toBe(0);
    const r = await applyGraph(owner, TEMPLATE, { project: 'secondbrain-app', feature: 'org-page' });
    const [spec, build, review, verify] = r.cards.map((c) => c.task_id!);
    for (const id of [spec, build, review, verify]) expect(id).toMatch(/^t_[0-9a-f]{8}$/);
    const deps = async (id: string) => (await query<{ depends_on: string }>(`SELECT depends_on FROM card_deps WHERE card_id = $1`, [id])).rows.map((d) => d.depends_on);
    expect(await deps(build!)).toEqual([spec]);
    expect(await deps(review!)).toEqual([build]);
    expect(await deps(verify!)).toEqual([review]);
    const body = (await query<{ body: string }>(`SELECT body FROM cards WHERE id = $1`, [build])).rows[0]!.body;
    expect(body).toContain('Graph feature-build, node build (build)');
    expect(body).toContain(`After: spec ${spec}.`);
    expect(body).toContain('Build org-page for secondbrain-app.');
    const links = await listTasks({ feature: 'org-page' });
    expect(links.map((l) => [l.node, l.kind, l.graph]).sort()).toEqual([['build', 'build', 'feature-build'], ['review', 'review', 'feature-build'], ['spec', 'spec', 'feature-build'], ['verify', 'verify', 'feature-build']]);
    // The feature's owner is the builder, not the reviewer or the lead of the verify node.
    expect((await query<{ owner: string }>(`SELECT owner FROM features WHERE slug = 'org-page'`)).rows[0]!.owner).toBe('rune');
    expect(r.message).toMatchObject({ channel_slug: 'platform', mentions: [], task_id: spec });
    expect(r.message!.body).toContain(`spec ${spec} (atlas) → build ${build} (rune) → review ${review} (vera) → verify ${verify} (atlas)`);
    // The root card is ready and wakes its bot; the rest wait in todo for their parents (the summary names them without a mention).
    const { rows: wakes } = await query<{ agent_name: string; ref: string }>(`SELECT agent_name, ref FROM org_wakeups WHERE done_at IS NULL`);
    expect(wakes).toEqual([{ agent_name: 'atlas', ref: spec }]);
    const status = async (id: string) => (await query<{ status: string }>(`SELECT status FROM cards WHERE id = $1`, [id])).rows[0]!.status;
    expect([await status(spec!), await status(build!), await status(review!), await status(verify!)]).toEqual(['ready', 'todo', 'todo', 'todo']);
  });

  it('redo opens a round for the builder, parks the review card on it, and escalates after two rounds', async () => {
    const owner = await getAgent('owner');
    const vera = await getAgent('vera');
    const applied = await applyGraph(owner, TEMPLATE, { project: 'secondbrain-app', feature: 'org-page' });
    const [spec, build, review] = applied.cards.map((c) => c.task_id!) as [string, string, string];
    const row = async (id: string) => (await query<{ status: string; block_kind: string | null; author?: string }>(`SELECT status, block_kind FROM cards WHERE id = $1`, [id])).rows[0]!;
    const finish = (by: string, id: string, result: string) => query(`SELECT board_card_finish($1, $2, 'done', $3, NULL, NULL, NULL, NULL, NULL)`, [by, id, result]);
    // The spec and the build are done: the review card is ready and vera reviews it.
    await finish('atlas', spec, 'spec written');
    await finish('rune', build, 'PR 1');
    expect((await row(review)).status).toBe('ready');
    const r1 = await redoTask(vera, review, 'The route returns 500 on an empty board.');
    expect(r1).toMatchObject({ escalated: false, rounds: 1 });
    const round1 = r1.task_id!;
    const card1 = (await query<{ title: string; body: string; assignee: string }>(`SELECT title, body, assignee FROM cards WHERE id = $1`, [round1])).rows[0]!;
    expect(card1.assignee).toBe('rune');
    expect(card1.title).toBe('Build: The /org page (round 1)');
    expect(card1.body).toContain(`Changes requested by vera on ${review}`);
    const round = (await listTasks({ agent: 'rune' })).find((l) => l.task_id === round1)!;
    expect(round).toMatchObject({ rounds: 1, node: 'build', kind: 'build', graph: 'feature-build', status: 'ready' });
    expect((await listTasks({ feature: 'org-page' })).find((l) => l.task_id === review)!.rounds).toBe(1);
    // The review card waits for the round, and comes back when the round is finished.
    expect(await row(review)).toEqual({ status: 'blocked', block_kind: 'dependency' });
    await finish('rune', round1, 'fixed');
    expect((await row(review)).status).toBe('ready');
    expect(r1.message).toMatchObject({ channel_slug: 'platform', mentions: [], task_id: round1 });
    // Round 2 reviews the round-1 card (now a parent of the review card).
    const r2 = await redoTask(vera, review, 'Still 500.');
    expect(r2).toMatchObject({ escalated: false, rounds: 2 });
    expect((await query<{ title: string }>(`SELECT title FROM cards WHERE id = $1`, [r2.task_id])).rows[0]!.title).toBe('Build: The /org page (round 2)');
    // Round 3 is refused: a comment on the review card and a DM to the lead.
    const before = (await query(`SELECT 1 FROM cards`)).rowCount;
    const r3 = await redoTask(vera, review, 'Still broken.');
    expect(r3).toMatchObject({ escalated: true, task_id: null, rounds: 3 });
    expect((await query(`SELECT 1 FROM cards`)).rowCount).toBe(before);
    expect((await query<{ author: string }>(`SELECT author FROM card_comments WHERE card_id = $1 ORDER BY id DESC LIMIT 1`, [review])).rows[0]!.author).toBe('vera');
    expect(r3.message).toMatchObject({ channel_slug: 'dm:atlas:vera', author: 'vera', task_id: review });
    // Only the reviewer, the lead or a human may ask for changes.
    await expect(redoTask(await getAgent('rune'), review, 'x')).rejects.toThrow(/can't give/);
  });

  it('cli-org graph list and apply read the compiled templates from the vault', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'sb-vault-'));
    mkdirSync(join(vault, '.agents', 'org'), { recursive: true });
    writeFileSync(join(vault, '.agents', 'org', 'graphs.json'), JSON.stringify({ graphs: { note: { name: 'note', description: 'a note', nodes: [{ id: 'write', assign: 'lead', title: 'Write: {title}', after: [], kind: 'build' }] } } }));
    process.env.ORG_AGENT = 'owner';
    const prev = config.vaultRoot;
    (config as { vaultRoot: string }).vaultRoot = vault;
    const lines: string[] = [];
    try {
      expect(await main(['graph', 'list'], (s) => lines.push(s))).toBe(0);
      expect(lines[0]).toMatch(/^note\s+write \(lead\)\n\s+a note$/);
      lines.length = 0;
      expect(await main(['graph', 'apply', 'note', '--project', 'secondbrain-app', '--dry-run'], (s) => lines.push(s))).toBe(0);
      expect(lines[0]).toBe('would create 1 cards for secondbrain-app (note):');
      expect(lines[1]).toMatch(/^\s+-\s+write\s+build\s+atlas\s+Write: Second Brain app$/);
      lines.length = 0;
      expect(await main(['graph', 'apply', 'note', '--project', 'secondbrain-app'], (s) => lines.push(s))).toBe(0);
      expect(lines[0]).toBe('created 1 cards for secondbrain-app (note):');
      expect(lines[2]).toMatch(/^posted \d+ in #platform$/);
      await expect(main(['graph', 'apply', 'nope', '--project', 'secondbrain-app'])).rejects.toThrow(/no graph template/);
    } finally {
      (config as { vaultRoot: string }).vaultRoot = prev;
      delete process.env.ORG_AGENT;
    }
  });
});
