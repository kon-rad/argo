import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { kanbanRunner, main } from '../src/cli-org.js';
import { config } from '../src/config.js';
import { query, setDatabaseUrl } from '../src/db.js';
import { applyGraph, assertMayAssign, assignTask, createTask, getAgent, importOrg, listTasks, redoTask, resolveAssignee, type KanbanRunner } from '../src/org.js';
import { ALL_MODULES, truncateAll } from './helpers.js';

/**
 * The work graph: one card, one bot, one project. The kanban is a fake script
 * here (ORG_KANBAN_CMD); the link row and the handoff are the real thing.
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

/** A stand-in for `hermes kanban … create --json`: echoes its argv into a log and prints a card id. */
function fakeKanban(): { cmd: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sb-kanban-'));
  const log = join(dir, 'argv.json');
  const cmd = join(dir, 'hermes');
  writeFileSync(cmd, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));\nconsole.log(JSON.stringify({ id: 't_' + require('crypto').randomBytes(4).toString('hex'), status: 'ready' }));\n`);
  chmodSync(cmd, 0o755);
  return { cmd, log };
}

const calls: string[][] = [];
const runner: KanbanRunner = async (args) => {
  calls.push(args);
  return JSON.stringify({ id: `t_${String(calls.length).padStart(6, '0')}` });
};

describe('cards for bots', () => {
  beforeEach(async () => {
    calls.length = 0;
    await truncateAll();
    await importOrg(ORG);
    await query(`INSERT INTO projects (slug, title, team_slug, stage) VALUES ('secondbrain-app', 'Second Brain app', 'platform', 'building')`);
    await query(`INSERT INTO features (project_slug, slug, title, stage, owner) VALUES ('secondbrain-app', 'org-page', 'The /org page', 'testing', 'claude-code')`);
  });

  it('owner gives rune a card: kanban create, link row, feature owner, mention in #platform', async () => {
    const owner = await getAgent('owner');
    const r = await createTask(owner, { assignee: 'rune', title: 'Add the tasks route', body: 'GET /api/org/tasks', project: 'secondbrain-app', feature: 'org-page' }, runner);
    expect(r.task_id).toBe('t_000001');
    const args = calls[0]!;
    expect(args.slice(0, 4)).toEqual(['kanban', '--board', 'exo', 'create']);
    expect(args).toContain('--assignee');
    expect(args[args.indexOf('--assignee') + 1]).toBe('rune');
    expect(args[args.indexOf('--created-by') + 1]).toBe('owner');
    expect(args.slice(-2)).toEqual(['--', 'Add the tasks route']);
    const body = args.find((a) => a.startsWith('--body='))!;
    expect(body).toContain('Project: secondbrain-app/org-page');
    expect(body).toContain('--kind status --task <this card> --project secondbrain-app --feature org-page');
    expect(body.endsWith('GET /api/org/tasks')).toBe(true);
    expect(r.link).toMatchObject({ task_id: 't_000001', board: 'exo', project_slug: 'secondbrain-app', feature_slug: 'org-page', assignee: 'rune', created_by: 'owner', rounds: 0 });
    const { rows } = await query<{ owner: string }>(`SELECT owner FROM features WHERE slug = 'org-page'`);
    expect(rows[0]!.owner).toBe('rune');
    expect(r.message).toMatchObject({ channel_slug: 'platform', kind: 'message', author: 'owner', task_id: 't_000001', project_slug: 'secondbrain-app', feature_slug: 'org-page', mentions: [] });
    // The note names rune without a mention: the card itself wakes rune when it is ready, so nothing else does.
    const { rows: wakes } = await query<{ agent_name: string; reason: string }>(`SELECT agent_name, reason FROM org_wakeups WHERE done_at IS NULL ORDER BY id`);
    expect(wakes).toEqual([]);
    expect((await listTasks({ project: 'secondbrain-app' })).map((t) => t.task_id)).toEqual(['t_000001']);
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
    const r = await createTask(rune!, { assignee: 'rune', title: 'Follow-up: tests', project: 'secondbrain-app' }, runner);
    expect(r.message).toBeNull();
    expect(r.link.feature_slug).toBeNull();
  });

  it('assigns an existing card to a bot: kanban assign, a comment with the closing commands, the link row, a mention', async () => {
    const shown: Record<string, { title: string; status: string }> = {
      t_01d00001: { title: 'Second Brain app:  mobile-first update', status: 'ready' },
      t_01d00002: { title: 'Old', status: 'done' },
      t_01d00003: { title: 'Busy', status: 'running' },
    };
    const kb: KanbanRunner = async (args) => {
      calls.push(args);
      if (args[3] === 'show') return JSON.stringify({ task: { id: args[4], ...shown[args[4]!] } });
      return '';
    };
    const owner = await getAgent('owner');
    const r = await assignTask(owner, { taskId: 't_01d00001', assignee: 'rune', project: 'secondbrain-app', feature: 'org-page' }, kb);
    expect(r.link).toMatchObject({ task_id: 't_01d00001', assignee: 'rune', project_slug: 'secondbrain-app', feature_slug: 'org-page', title: 'Second Brain app: mobile-first update', kind: 'work' });
    expect(calls.map((c) => c[3])).toEqual(['show', 'assign', 'comment']);
    expect(calls[1]).toEqual(['kanban', '--board', 'exo', 'assign', 't_01d00001', 'rune']);
    const comment = calls[2]!;
    expect(comment.slice(4, 8)).toEqual(['--author', 'owner', '--', 't_01d00001']);
    expect(comment[8]).toContain('Project: secondbrain-app/org-page');
    expect(comment[8]).toContain('hermes kanban complete <this card>');
    expect((await query<{ owner: string }>(`SELECT owner FROM features WHERE slug = 'org-page'`)).rows[0]!.owner).toBe('rune');
    expect(r.message).toMatchObject({ channel_slug: 'platform', mentions: [], task_id: 't_01d00001' });
    expect((await listTasks({ agent: 'rune' })).map((l) => l.task_id)).toEqual(['t_01d00001']);
    // A finished or running card is refused before the kanban is touched; so is a card the board doesn't know.
    calls.length = 0;
    await expect(assignTask(owner, { taskId: 't_01d00002', assignee: 'rune', project: 'secondbrain-app' }, kb)).rejects.toThrow('is done');
    await expect(assignTask(owner, { taskId: 't_01d00003', assignee: 'rune', project: 'secondbrain-app' }, kb)).rejects.toThrow('is running');
    await expect(assignTask(owner, { taskId: 't_01d00009', assignee: 'rune', project: 'secondbrain-app' }, kb)).rejects.toThrow('no card t_01d00009');
    expect(calls.map((c) => c[3])).toEqual(['show', 'show', 'show']);
    // A member can't take someone else's card for a teammate; the lead can.
    await expect(assignTask(await getAgent('rune'), { taskId: 't_01d00001', assignee: 'atlas', project: 'secondbrain-app' }, kb)).rejects.toThrow("can't give");
    const byLead = await assignTask(await getAgent('atlas'), { taskId: 't_01d00001', assignee: 'rune', project: 'secondbrain-app' }, kb);
    expect(byLead.link.feature_slug).toBeNull();
  });

  it('a card carries its kind of work: --type on create and assign, a graph template\'s work, the review round inherits it', async () => {
    const owner = await getAgent('owner');
    const r = await createTask(owner, { assignee: 'rune', title: 'Write the cap note', project: 'secondbrain-app', type: 'writing' }, runner);
    expect(r.link.work_type).toBe('writing');
    await expect(createTask(owner, { assignee: 'rune', title: 'x', project: 'secondbrain-app', type: 'dancing' }, runner)).rejects.toThrow(/--type dancing/);
    const kb: KanbanRunner = async (args) => {
      calls.push(args);
      if (args[3] === 'show') return JSON.stringify({ task: { id: args[4], title: 'Design the kiosk', status: 'ready' } });
      return '';
    };
    const a = await assignTask(owner, { taskId: 't_01d00005', assignee: 'rune', project: 'secondbrain-app', type: 'design' }, kb);
    expect(a.link.work_type).toBe('design');
    // Assigning again without a type keeps the one it has.
    expect((await assignTask(owner, { taskId: 't_01d00005', assignee: 'rune', project: 'secondbrain-app' }, kb)).link.work_type).toBe('design');
    const g = await applyGraph(owner, { name: 'research-note', work: 'research', nodes: [
      { id: 'research', assign: 'rune', title: 'Research: {title}', after: [], kind: 'build' },
      { id: 'review', assign: 'lead', title: 'Review: {title}', after: ['research'], kind: 'review' },
    ] }, { project: 'secondbrain-app' }, runner);
    const links = await listTasks({ project: 'secondbrain-app' });
    expect(links.find((l) => l.task_id === g.cards[0]!.task_id)!.work_type).toBe('research');
    expect(links.find((l) => l.task_id === g.cards[1]!.task_id)!.work_type).toBe('research');
  });

  it('refuses an unknown project or feature before touching the kanban', async () => {
    const owner = await getAgent('owner');
    await expect(createTask(owner, { assignee: 'rune', title: 'x', project: 'nope' }, runner)).rejects.toThrow(/no project "nope"/);
    await expect(createTask(owner, { assignee: 'rune', title: 'x', project: 'secondbrain-app', feature: 'nope' }, runner)).rejects.toThrow(/no feature/);
    expect(calls).toEqual([]);
  });

  it('cli-org task create runs the kanban binary from ORG_KANBAN_CMD and task list shows the card', async () => {
    const fake = fakeKanban();
    process.env.ORG_AGENT = 'owner';
    process.env.ORG_KANBAN_CMD = fake.cmd;
    const lines: string[] = [];
    try {
      expect(await main(['task', 'create', 'lena', 'Draft the launch post', '--project', 'secondbrain-app', '--priority', '3'], (s) => lines.push(s))).toBe(0);
      expect(lines[0]).toMatch(/^card t_[0-9a-f]{8} for lena: Draft the launch post \(secondbrain-app\); mention \d+ in #media$/);
      const argv = JSON.parse(readFileSync(fake.log, 'utf8')) as string[];
      expect(argv[argv.indexOf('--priority') + 1]).toBe('3');
      lines.length = 0;
      expect(await main(['task', 'list', '--agent', 'lena'], (s) => lines.push(s))).toBe(0);
      expect(lines[0]).toMatch(/lena\s+secondbrain-app\s+Draft the launch post/);
      // The runner's own error path.
      await expect(kanbanRunner({ ...process.env, ORG_KANBAN_CMD: '/nonexistent/hermes' })(['kanban'])).rejects.toThrow(/kanban:/);
    } finally {
      delete process.env.ORG_AGENT;
      delete process.env.ORG_KANBAN_CMD;
    }
  });

  it('runs as the sb_org role the way the droplet does (ORG_AGENT + SB_ORG_DB_URL): reads features, writes through the definer', async () => {
    const fake = fakeKanban();
    process.env.ORG_AGENT = 'atlas';
    process.env.ORG_KANBAN_CMD = fake.cmd;
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
      delete process.env.ORG_KANBAN_CMD;
      delete process.env.SB_ORG_DB_URL;
      setDatabaseUrl(`postgres://${process.env.PGHOST ?? 'localhost'}:${process.env.PGPORT ?? '5432'}/${process.env.SB_TEST_DB ?? 'secondbrain_test'}`);
    }
    const { rows } = await query<{ owner: string }>(`SELECT owner FROM features WHERE slug = 'org-page'`);
    expect(rows[0]!.owner).toBe('rune');
  });

  it('GET /api/org/tasks lists links by project, feature and bot', async () => {
    const owner = await getAgent('owner');
    await createTask(owner, { assignee: 'rune', title: 'A', project: 'secondbrain-app', feature: 'org-page' }, runner);
    await createTask(owner, { assignee: 'lena', title: 'B', project: 'secondbrain-app' }, runner);
    const app = createApp({ modules: ALL_MODULES, vaultRoot: mkdtempSync(join(tmpdir(), 'sb-vault-')) });
    const all = await request(app).get('/api/org/tasks').expect(200);
    expect(all.body.tasks.map((t: { title: string }) => t.title)).toEqual(['B', 'A']);
    const one = await request(app).get('/api/org/tasks?feature=org-page').expect(200);
    expect(one.body.tasks.map((t: { assignee: string }) => t.assignee)).toEqual(['rune']);
    await request(app).get('/api/org/tasks?agent=Not-Valid').expect(400);
  });
});

/**
 * Graph templates and the review loop. The fake kanban answers create (ids in
 * order), show (parents it was told), link and block, and records everything.
 */
describe('graphs and the review loop', () => {
  const calls: string[][] = [];
  let n = 0;
  const parents = new Map<string, string[]>();
  const fake: KanbanRunner = async (args) => {
    calls.push(args);
    const verb = args[3];
    if (verb === 'create') {
      const id = `t_${String(++n).padStart(6, '0')}`;
      const ps: string[] = [];
      args.forEach((a, i) => { if (a === '--parent') ps.push(args[i + 1]!); });
      parents.set(id, ps);
      return JSON.stringify({ id });
    }
    if (verb === 'show') return JSON.stringify({ task: { id: args[4] }, parents: parents.get(args[4]!) ?? [] });
    if (verb === 'link') { parents.set(args[5]!, [...(parents.get(args[5]!) ?? []), args[4]!]); return ''; }
    return '';
  };
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
    calls.length = 0;
    n = 0;
    parents.clear();
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
    const dry = await applyGraph(owner, TEMPLATE, { project: 'secondbrain-app', feature: 'org-page', dryRun: true }, fake);
    expect(dry.cards.map((c) => [c.node, c.assignee, c.task_id])).toEqual([['spec', 'atlas', null], ['build', 'rune', null], ['review', 'vera', null], ['verify', 'atlas', null]]);
    expect(calls).toEqual([]);
    const r = await applyGraph(owner, TEMPLATE, { project: 'secondbrain-app', feature: 'org-page' }, fake);
    expect(r.cards.map((c) => c.task_id)).toEqual(['t_000001', 't_000002', 't_000003', 't_000004']);
    expect(parents.get('t_000002')).toEqual(['t_000001']);
    expect(parents.get('t_000003')).toEqual(['t_000002']);
    expect(parents.get('t_000004')).toEqual(['t_000003']);
    const build = calls.find((c) => c.includes('--') && c[c.length - 1] === 'Build: The /org page')!;
    const body = build.find((a) => a.startsWith('--body='))!;
    expect(body).toContain('Graph feature-build, node build (build)');
    expect(body).toContain('After: spec t_000001.');
    expect(body).toContain('Build org-page for secondbrain-app.');
    const links = await listTasks({ feature: 'org-page' });
    expect(links.map((l) => [l.node, l.kind, l.graph])).toEqual([['verify', 'verify', 'feature-build'], ['review', 'review', 'feature-build'], ['build', 'build', 'feature-build'], ['spec', 'spec', 'feature-build']]);
    // The feature's owner is the builder, not the reviewer or the lead of the verify node.
    expect((await query<{ owner: string }>(`SELECT owner FROM features WHERE slug = 'org-page'`)).rows[0]!.owner).toBe('rune');
    expect(r.message).toMatchObject({ channel_slug: 'platform', mentions: [], task_id: 't_000001' });
    expect(r.message!.body).toContain('spec t_000001 (atlas) → build t_000002 (rune) → review t_000003 (vera) → verify t_000004 (atlas)');
    const { rows: wakes } = await query<{ agent_name: string }>(`SELECT agent_name FROM org_wakeups WHERE done_at IS NULL`);
    expect(wakes).toEqual([]);   // each card wakes its bot when it is ready; the summary names them without a mention
  });

  it('redo opens a round for the builder, parks the review card on it, and escalates after two rounds', async () => {
    const owner = await getAgent('owner');
    const vera = await getAgent('vera');
    await applyGraph(owner, TEMPLATE, { project: 'secondbrain-app', feature: 'org-page' }, fake);
    calls.length = 0;
    const r1 = await redoTask(vera, 't_000003', 'The route returns 500 on an empty board.', fake);
    expect(r1).toMatchObject({ escalated: false, task_id: 't_000005', rounds: 1 });
    const create = calls.find((c) => c[3] === 'create')!;
    expect(create[create.indexOf('--assignee') + 1]).toBe('rune');
    expect(create[create.length - 1]).toBe('Build: The /org page (round 1)');
    expect(create.find((a) => a.startsWith('--body='))).toContain('Changes requested by vera on t_000003');
    expect(calls.some((c) => c[3] === 'link' && c[4] === 't_000005' && c[5] === 't_000003')).toBe(true);
    const block = calls.find((c) => c[3] === 'block')!;
    expect(block.slice(4, 7)).toEqual(['--kind', 'dependency', 't_000003']);
    const round = (await listTasks({ agent: 'rune' })).find((l) => l.task_id === 't_000005')!;
    expect(round).toMatchObject({ rounds: 1, node: 'build', kind: 'build', graph: 'feature-build' });
    expect((await listTasks({ feature: 'org-page' })).find((l) => l.task_id === 't_000003')!.rounds).toBe(1);
    expect(r1.message).toMatchObject({ channel_slug: 'platform', mentions: [], task_id: 't_000005' });
    // Round 2 reviews the round-1 card (now a parent of the review card).
    const r2 = await redoTask(vera, 't_000003', 'Still 500.', fake);
    expect(r2).toMatchObject({ escalated: false, task_id: 't_000006', rounds: 2 });
    expect(calls.filter((c) => c[3] === 'create').pop()!.pop()).toBe('Build: The /org page (round 2)');
    // Round 3 is refused: a comment on the review card and a DM to the lead.
    calls.length = 0;
    const r3 = await redoTask(vera, 't_000003', 'Still broken.', fake);
    expect(r3).toMatchObject({ escalated: true, task_id: null, rounds: 3 });
    expect(calls.map((c) => c[3])).toEqual(['show', 'comment']);
    expect(r3.message).toMatchObject({ channel_slug: 'dm:atlas:vera', author: 'vera', task_id: 't_000003' });
    // Only the reviewer, the lead or a human may ask for changes.
    await expect(redoTask(await getAgent('rune'), 't_000003', 'x', fake)).rejects.toThrow(/can't give/);
  });

  it('cli-org graph list and apply read the compiled templates from the vault', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'sb-vault-'));
    mkdirSync(join(vault, '.agents', 'org'), { recursive: true });
    writeFileSync(join(vault, '.agents', 'org', 'graphs.json'), JSON.stringify({ graphs: { note: { name: 'note', description: 'a note', nodes: [{ id: 'write', assign: 'lead', title: 'Write: {title}', after: [], kind: 'build' }] } } }));
    const fakeBin = fakeKanban();
    process.env.ORG_AGENT = 'owner';
    process.env.ORG_KANBAN_CMD = fakeBin.cmd;
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
      delete process.env.ORG_KANBAN_CMD;
    }
  });
});
