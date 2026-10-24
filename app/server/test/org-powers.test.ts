import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { agentDatabaseUrl, main, plainSnippet } from '../src/cli-org.js';
import { query } from '../src/db.js';
import { applyGraph, assignTask, createTask, dm, getAgent, importOrg, neededCapability, nodeNeed, post, type KanbanRunner } from '../src/org.js';
import {
  forget, listFacts, recallExcluded, recallFacts, recallMemoryFiles, remember, shipCheck, shipDecide, shipRequest,
} from '../src/org-powers.js';
import { ALL_MODULES, truncateAll } from './helpers.js';

/**
 * Bot powers and shared memory: capabilities decide who gets a card, nothing ships without a human's yes (or a
 * ship-now card), status posts and bot chatter don't wake bots for nothing, and facts are sourced and closable.
 */

const ORG = {
  version: 'powers-1',
  company: 'Argo',
  ceo: 'owner',
  agents: {
    owner: { runtime: 'human', role: 'CEO', channels: ['*'] },
    atlas: { role: 'Head of Platform', team: 'platform', reports_to: 'owner', capabilities: ['review', 'merge'] },
    rune: { role: 'Platform engineer', team: 'platform', reports_to: 'atlas', capabilities: ['code'] },
    vera: { role: 'Reviewer', team: 'platform', reports_to: 'atlas', capabilities: ['review'] },
    sable: { role: 'Infrastructure engineer', team: 'platform', reports_to: 'atlas', capabilities: ['code', 'deploy'] },
    juno: { role: 'Head of Media', team: 'media', reports_to: 'owner' },
    lena: { role: 'Writer', team: 'media', reports_to: 'juno' },
    echo: { role: 'Video and livestream', team: 'media', reports_to: 'juno', capabilities: ['m1'] },
  },
  teams: { platform: { name: 'Platform', lead: 'atlas' }, media: { name: 'Media', lead: 'juno' } },
  channels: { 'all-hands': { members: '*' }, leads: { members: ['owner', 'atlas', 'juno'] } },
};

let n = 0;
const runner: KanbanRunner = async (args) => {
  if (args[3] !== 'create') return '';
  n++;
  return JSON.stringify({ id: `t_${String(n).padStart(6, '0')}` });
};
const PR = 'https://github.com/kon-rad/argo-exo/pull/12';

async function wakes(): Promise<{ agent_name: string; reason: string }[]> {
  return (await query<{ agent_name: string; reason: string }>(`SELECT agent_name, reason FROM org_wakeups WHERE done_at IS NULL ORDER BY id`)).rows;
}

describe('bot powers', () => {
  beforeEach(async () => {
    n = 0;
    await truncateAll();
    await importOrg(ORG);
    await query(`INSERT INTO projects (slug, title, team_slug, stage) VALUES ('argo-exo', 'Exo', 'platform', 'building')`);
  });

  it('imports capabilities and refuses an unknown one', async () => {
    expect((await getAgent('rune')).capabilities).toEqual(['code']);
    expect((await getAgent('lena')).capabilities).toEqual([]);
    await expect(importOrg({ ...ORG, agents: { ...ORG.agents, lena: { ...ORG.agents.lena, capabilities: ['sudo'] } } })).rejects.toThrow();
  });

  it('maps work to a capability and graph nodes to theirs', () => {
    expect(neededCapability('coding', undefined)).toBe('code');
    expect(neededCapability('ops', undefined)).toBe('deploy');
    expect(neededCapability('writing', undefined)).toBeNull();
    expect(neededCapability('media', 'm1')).toBe('m1');
    expect(() => neededCapability(undefined, 'root')).toThrow(/--needs root/);
    expect(nodeNeed('build', 'coding')).toBe('code');
    expect(nodeNeed('review', 'coding')).toBe('review');
    expect(nodeNeed('review', 'writing')).toBeNull();
    expect(nodeNeed('spec', 'coding')).toBeNull();
  });

  it('a coding card goes only to a bot with code, and the refusal names who can', async () => {
    const owner = await getAgent('owner');
    await expect(createTask(owner, { assignee: 'lena', title: 'Fix the dispatcher', project: 'argo-exo', type: 'coding' }, runner))
      .rejects.toThrow(/lena doesn't have the code capability.*rune, sable/);
    const r = await createTask(owner, { assignee: 'rune', title: 'Fix the dispatcher', project: 'argo-exo', type: 'coding' }, runner);
    expect(r.link).toMatchObject({ needs: 'code', ship_now: false });
    await expect(assignTask(owner, { taskId: 't_abcdef', assignee: 'juno', project: 'argo-exo', needs: 'm1' }, runner)).rejects.toThrow(/echo/);
  });

  it('a card note names the bot without waking it a second time', async () => {
    const r = await createTask(await getAgent('owner'), { assignee: 'rune', title: 'Tidy', project: 'argo-exo' }, runner);
    expect(r.message).toMatchObject({ channel_slug: 'platform', mentions: [] });
    expect(r.message!.body).toBe(`card ${r.task_id} for rune: Tidy (argo-exo)`);
    // The ready card wakes rune once (reason task); the note adds no mention wake on top.
    expect(await wakes()).toEqual([{ agent_name: 'rune', reason: 'task' }]);
  });

  it('a graph checks every node: a code review node needs a reviewer', async () => {
    const g = { name: 'feature-build', description: '', work: 'coding', nodes: [
      { id: 'build', kind: 'build', assign: 'rune', title: 'Build', after: [] },
      { id: 'review', kind: 'review', assign: 'lena', title: 'Review', after: ['build'] },
    ] };
    await expect(applyGraph(await getAgent('owner'), g as never, { project: 'argo-exo', team: 'platform' }, runner)).rejects.toThrow(/lena doesn't have the review/);
  });

  it('only the owner marks a card ship-now', async () => {
    await expect(createTask(await getAgent('atlas'), { assignee: 'rune', title: 'x', project: 'argo-exo', shipNow: true }, runner)).rejects.toThrow(/only the owner/);
    const r = await createTask(await getAgent('owner'), { assignee: 'rune', title: 'Ship it', project: 'argo-exo', type: 'coding', shipNow: true }, runner);
    expect(r.link.ship_now).toBe(true);
  });

  it('request → owner approves → merge check passes for that PR only; the requester is woken', async () => {
    const card = (await createTask(await getAgent('owner'), { assignee: 'rune', title: 'Build', project: 'argo-exo', type: 'coding' }, runner)).task_id;
    const r = await shipRequest(await getAgent('atlas'), { card, summary: 'adds the m1 gate; 85 tests pass', pr: PR, deploy: 'argo-exo-agents' });
    expect(r).toMatchObject({ created: true, approval: { status: 'pending', requested_by: 'atlas' } });
    expect(r.message).toMatchObject({ channel_slug: 'platform', kind: 'question-for-owner', task_id: card });
    expect((await shipRequest(await getAgent('atlas'), { card, summary: 'again', pr: PR, deploy: 'argo-exo-agents' })).created).toBe(false);
    expect((await shipCheck(card, { pr: PR })).ok).toBe(false);
    expect((await shipCheck(card, { pr: PR })).reason).toMatch(/waiting on the owner/);

    await expect(shipDecide(await getAgent('owner'), r.approval.id, true, undefined, { ORG_RUN: 'org-x' })).rejects.toThrow(/never given from inside a bot run/);
    await expect(shipDecide(await getAgent('atlas'), r.approval.id, true, undefined, {})).rejects.toThrow(/only the owner/);
    const a = await shipDecide(await getAgent('owner'), r.approval.id, true, 'go', {});
    expect(a).toMatchObject({ status: 'approved', decided_by: 'owner' });
    expect(await wakes()).toContainEqual({ agent_name: 'atlas', reason: 'owner' });
    expect((await shipCheck(card, { pr: PR })).ok).toBe(true);
    expect((await shipCheck(card, { deploy: 'argo-exo-agents' })).ok).toBe(true);
    expect((await shipCheck(card, { pr: 'https://github.com/kon-rad/argo-exo/pull/13' })).ok).toBe(false);
    expect((await shipCheck(card, { deploy: 'argo-web' })).ok).toBe(false);
    await expect(shipDecide(await getAgent('owner'), r.approval.id, false, 'late', {})).rejects.toThrow(/already approved/);
  });

  it('a ship-now card is approved at once; a bot without code, merge or deploy can not ask', async () => {
    const card = (await createTask(await getAgent('owner'), { assignee: 'rune', title: 'Hotfix', project: 'argo-exo', type: 'coding', shipNow: true }, runner)).task_id;
    const r = await shipRequest(await getAgent('rune'), { card, summary: 'hotfix', pr: PR });
    expect(r.approval).toMatchObject({ status: 'approved', ship_now: true, decided_by: 'owner' });
    expect(r.message).toBeNull();
    expect((await shipCheck(card, { deploy: 'anything' })).ok).toBe(true);
    await expect(shipRequest(await getAgent('lena'), { card, summary: 'x', pr: PR })).rejects.toThrow(/has none of/);
    await expect(shipRequest(await getAgent('rune'), { card, summary: 'x', pr: 'https://evil.example/pull/1' })).rejects.toThrow(/--pr takes/);
  });

  it('the database refuses a bot that decides through the RLS role', async () => {
    const card = (await createTask(await getAgent('owner'), { assignee: 'rune', title: 'Build', project: 'argo-exo', type: 'coding' }, runner)).task_id;
    const r = await shipRequest(await getAgent('rune'), { card, summary: 's', pr: PR });
    const url = agentDatabaseUrl(`postgres://sb_org@${process.env.PGHOST ?? 'localhost'}:${process.env.PGPORT ?? '5432'}/${process.env.SB_TEST_DB ?? 'secondbrain_test'}`, 'rune');
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      await expect(c.query(`SELECT org_ship_decide($1, true, 'owner', null)`, [r.approval.id])).rejects.toThrow(/caller is rune/);
      await expect(c.query(`SELECT org_ship_decide($1, true, 'rune', null)`, [r.approval.id])).rejects.toThrow(/only the owner/);
      await expect(c.query(`UPDATE org_approvals SET status = 'approved'`)).rejects.toThrow(/permission denied/);
      await expect(c.query(`SELECT org_task_flags($1, true, null)`, [card])).rejects.toThrow(/only the owner/);
      await expect(c.query(`UPDATE org_agents SET capabilities = '{merge}' WHERE name = 'rune'`)).rejects.toThrow(/permission denied/);
    } finally {
      await c.end();
    }
  });

  it('the approvals routes list and decide as the owner', async () => {
    const card = (await createTask(await getAgent('owner'), { assignee: 'rune', title: 'Build', project: 'argo-exo', type: 'coding' }, runner)).task_id;
    const r = await shipRequest(await getAgent('rune'), { card, summary: 's', pr: PR });
    const app = createApp({ modules: ALL_MODULES });
    const list = await request(app).get('/api/org/approvals').expect(200);
    expect(list.body.map((a: { id: number }) => a.id)).toEqual([r.approval.id]);
    await request(app).post(`/api/org/approvals/${r.approval.id}/deny`).send({}).expect(400);
    const d = await request(app).post(`/api/org/approvals/${r.approval.id}/deny`).send({ note: 'needs a test' }).expect(200);
    expect(d.body).toMatchObject({ status: 'denied', note: 'needs a test' });
  });
});

describe('fewer wakes', () => {
  beforeEach(async () => {
    await truncateAll();
    await importOrg(ORG);
  });

  it('status and reply posts wake nobody; the owner always wakes', async () => {
    const rune = await getAgent('rune');
    await post(rune, 'platform', '@atlas done, see t_x', { kind: 'status' });
    await dm(rune, 'vera', 'thanks', { kind: 'reply' });
    expect(await wakes()).toEqual([]);
    await post(await getAgent('owner'), 'platform', '@rune nice', { kind: 'status' });
    expect(await wakes()).toEqual([{ agent_name: 'rune', reason: 'owner' }]);
  });

  it('one bot wakes another at most three times a day; the messages still arrive', async () => {
    const rune = await getAgent('rune');
    for (let i = 0; i < 5; i++) await dm(rune, 'vera', `question ${i}`);
    const { rows } = await query<{ n: number }>(`SELECT count(*)::int AS n FROM org_wakeups WHERE agent_name = 'vera'`);
    expect(rows[0]!.n).toBe(3);
    const { rows: m } = await query<{ n: number }>(`SELECT count(*)::int AS n FROM org_messages WHERE channel_slug = 'dm:rune:vera'`);
    expect(m[0]!.n).toBe(5);
    await dm(await getAgent('atlas'), 'vera', 'from the lead');
    const { rows: v } = await query<{ n: number }>(`SELECT count(*)::int AS n FROM org_wakeups WHERE agent_name = 'vera'`);
    expect(v[0]!.n).toBe(4);
  });
});

describe('shared memory', () => {
  beforeEach(async () => {
    await truncateAll();
    await importOrg(ORG);
    await query(`INSERT INTO projects (slug, title, team_slug, stage) VALUES ('argo-exo', 'Exo', 'platform', 'building')`);
  });

  it('remembers a sourced fact, recalls it, supersedes and closes it', async () => {
    const rune = await getAgent('rune');
    await expect(remember(rune, { subject: 'x', claim: 'y', source: ' ' })).rejects.toThrow(/--source/);
    const f = await remember(rune, { subject: 'droplet RAM', claim: 'about 3 GB free with two workers', source: 'agents/cc-lanes/lanes.toml', project: 'argo-exo' });
    const hits = await recallFacts('droplet RAM workers', { project: 'argo-exo' });
    expect(hits[0]).toMatchObject({ source: 'fact', ref: `fact #${f.id}`, title: 'droplet RAM' });
    const g = await remember(rune, { subject: 'droplet RAM', claim: 'about 2.5 GB free with two workers', source: '#201', supersedes: f.id, via: 'claude-code@droplet' });
    const current = await listFacts({ subject: 'droplet' });
    expect(current.map((x) => x.id)).toEqual([g.id]);
    expect((await listFacts({ subject: 'droplet', all: true })).find((x) => x.id === f.id)).toMatchObject({ retired_why: `superseded by #${g.id}` });
    await expect(forget(await getAgent('lena'), g.id, 'no')).rejects.toThrow(/only its author/);
    await forget(await getAgent('atlas'), g.id, 'measured again');
    expect(await listFacts({ subject: 'droplet' })).toEqual([]);
  });

  it('a bot writes facts only as itself through the RLS role', async () => {
    const url = agentDatabaseUrl(`postgres://sb_org@${process.env.PGHOST ?? 'localhost'}:${process.env.PGPORT ?? '5432'}/${process.env.SB_TEST_DB ?? 'secondbrain_test'}`, 'lena');
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      await c.query(`INSERT INTO memory_facts (subject, claim, source, author) VALUES ('a', 'b', 'c', 'lena')`);
      await expect(c.query(`INSERT INTO memory_facts (subject, claim, source, author) VALUES ('a', 'b', 'c', 'owner')`)).rejects.toThrow(/row-level security/);
      await expect(c.query(`UPDATE memory_facts SET claim = 'z'`)).rejects.toThrow(/permission denied/);
    } finally {
      await c.end();
    }
  });

  it('memory files are searched line by line; private paths never come back', () => {
    const vault = mkdtempSync(join(tmpdir(), 'sb-vault-'));
    mkdirSync(join(vault, '.agents', 'org', 'memory'), { recursive: true });
    writeFileSync(join(vault, '.agents', 'org', 'memory', 'atlas.md'), '# atlas memory\n\n- deploy.sh runs npm ci in place\n- unrelated line\n');
    const hits = recallMemoryFiles(vault, 'npm ci deploy');
    expect(hits[0]).toMatchObject({ source: 'memory', ref: '.agents/org/memory/atlas.md:3', title: 'atlas' });
    expect(recallExcluded('CURRENT/todo-master.md')).toBe(true);
    expect(recallExcluded('Areas/Finance/exports/x.md')).toBe(true);
    expect(recallExcluded('Areas/zion/tenancy.md', ['Areas/zion/'])).toBe(true);
    expect(recallExcluded('Projects/kanban/kanban-design.md')).toBe(false);
  });

  it('vault snippets reach the bot as plain text', () => {
    expect(plainSnippet('the <b>kanban</b> &quot;exo&quot; board&#39;s <mark>SQLite</mark> &lt;file&gt; &amp; more')).toBe(`the kanban "exo" board's SQLite <file> & more`);
  });

  it('cli-org recall merges facts, memory files and the vault', async () => {
    await remember(await getAgent('atlas'), { subject: 'kanban', claim: 'board exo lives in SQLite on the droplet', source: 'Projects/kanban/kanban-design.md' });
    const out: string[] = [];
    const prev = process.env.ORG_AGENT;
    process.env.ORG_AGENT = 'rune';
    try {
      expect(await main(['recall', 'kanban SQLite'], (s) => out.push(s))).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.ORG_AGENT;
      else process.env.ORG_AGENT = prev;
    }
    expect(out.join('\n')).toMatch(/\[fact\] fact #\d+  kanban/);
  });
});
