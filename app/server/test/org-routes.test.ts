import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { query } from '../src/db.js';
import { addWakeup, agentActivity, claimWakeups, dm, finishWakeups, getAgent, importOrg, markChannelRead, pageMessages, post, standup, unreadCounts } from '../src/org.js';
import { ALL_MODULES, truncateAll } from './helpers.js';

/** The /org page's API, read and written as owner. Same fixture org as org.test.ts. */

const ORG = {
  version: 'test-1',
  company: 'Argo',
  ceo: 'owner',
  agents: {
    owner: { runtime: 'human', role: 'CEO', channels: ['*'] },
    atlas: { role: 'Head of Platform', team: 'platform', reports_to: 'owner', model: 'opus' },
    rune: { role: 'Platform engineer', team: 'platform', reports_to: 'atlas' },
    juno: { role: 'Head of Media', team: 'media', reports_to: 'owner', model: 'opus' },
    lena: { role: 'Writer', team: 'media', reports_to: 'juno' },
  },
  teams: {
    platform: { name: 'Platform & Agents', lead: 'atlas' },
    media: { name: 'Media & Growth', lead: 'juno' },
  },
  channels: {
    'all-hands': { members: '*', purpose: 'company-wide' },
    leads: { members: ['owner', 'atlas', 'juno'], purpose: 'leads' },
  },
};

function fixtureVault(): string {
  const root = mkdtempSync(join(tmpdir(), 'sb-org-'));
  mkdirSync(join(root, '.agents', 'org', 'memory'), { recursive: true });
  mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
  writeFileSync(
    join(root, '.agents', 'org', 'org-agents.json'),
    JSON.stringify({ agents: { atlas: { wakes_per_day: 6, cooldown_minutes: 10, max_runtime_minutes: 30, lane: null, routines: [{ name: 'daily-standup', at: '05:30', kind: 'standup' }] } } }),
  );
  writeFileSync(join(root, '.agents', 'org', 'memory', 'atlas.md'), '# atlas\n\n- 2026-10-15: learned the board\n');
  writeFileSync(join(root, '.claude', 'agents', 'atlas.md'), '---\nname: atlas\nmodel: opus\n---\n\n# atlas, Head of Platform\n\n**Personality.** Calm, exact.\n');
  return root;
}

const vault = fixtureVault();
const app = () => createApp({ modules: ALL_MODULES, vaultRoot: vault });

describe('org views', () => {
  beforeEach(async () => {
    await truncateAll();
    await importOrg(ORG);
  });

  it('pages messages newest-last with after/before cursors', async () => {
    const owner = await getAgent('owner');
    const rune = await getAgent('rune');
    const ids: number[] = [];
    for (let i = 1; i <= 5; i++) ids.push((await post(rune, 'platform', `m${i}`)).id);
    const page = await pageMessages(owner, 'platform', { limit: 2 });
    expect(page.map((m) => m.body)).toEqual(['m4', 'm5']);
    const after = await pageMessages(owner, 'platform', { after: ids[2]! });
    expect(after.map((m) => m.body)).toEqual(['m4', 'm5']);
    const before = await pageMessages(owner, 'platform', { before: ids[2]!, limit: 10 });
    expect(before.map((m) => m.body)).toEqual(['m1', 'm2']);
    // Across every channel, in id order, and nothing marked read.
    await post(await getAgent('lena'), 'media', 'hello media');
    const all = await pageMessages(owner, undefined, { after: ids[4]! });
    expect(all.map((m) => m.channel_slug)).toEqual(['media']);
    expect((await unreadCounts(owner))['platform']).toBe(5);
    await markChannelRead(owner, 'platform');
    expect((await unreadCounts(owner))['platform']).toBeUndefined();
  });

  it('summarises each agent’s wakes, unread and posts in one pass', async () => {
    const rune = await getAgent('rune');
    await post(rune, 'platform', 'first');
    await addWakeup('atlas', 'routine', 'daily-standup');
    const [w] = await claimWakeups('atlas', 'run-1');
    await finishWakeups([w!.id], { run: 'run-1', exit: 0, result: 'ok' });
    await addWakeup('atlas', 'owner', 'nudge');
    const a = await agentActivity();
    // unread is rune's post only: the fallback status the finished run posted is atlas's own.
    expect(a['atlas']).toMatchObject({ wakes_today: 2, open_wakeups: 1, unread: 1, last_post: expect.any(Date) });
    expect(a['atlas']!.last_wake).toBeInstanceOf(Date);
    expect(a['lena']).toMatchObject({ wakes_today: 0, open_wakeups: 0, unread: 0, last_wake: null, last_post: null });
  });
});

describe('/api/org', () => {
  beforeEach(async () => {
    await truncateAll();
    await importOrg(ORG);
  });

  it('answers 503 until the org is imported', async () => {
    await truncateAll();
    const res = await request(app()).get('/api/org/chart').expect(503);
    expect(res.body.error.message).toMatch(/no org agent named owner/);
  });

  it('serves the chart with activity and caps from the vault', async () => {
    await addWakeup('atlas', 'routine', 'daily-standup');
    const res = await request(app()).get('/api/org/chart').expect(200);
    expect(res.body.teams.map((t: { slug: string }) => t.slug)).toEqual(['media', 'platform']);
    const atlas = res.body.agents.find((a: { name: string }) => a.name === 'atlas');
    expect(atlas).toMatchObject({ is_lead: true, team_name: 'Platform & Agents', activity: { open_wakeups: 1, wakes_today: 1 }, caps: { wakes_per_day: 6 } });
    expect(res.body.agents.find((a: { name: string }) => a.name === 'lena').caps).toBeNull();
    expect(res.body.agents[0].name).toBe('owner');
  });

  it('lists channels with unread counts and members', async () => {
    await post(await getAgent('rune'), 'platform', 'hello');
    const res = await request(app()).get('/api/org/channels').expect(200);
    const platform = res.body.channels.find((c: { slug: string }) => c.slug === 'platform');
    expect(platform).toMatchObject({ kind: 'team', unread: 1, members: 3 });
    const members = await request(app()).get('/api/org/channels/platform/members').expect(200);
    expect(members.body.members.map((m: { agent_name: string }) => m.agent_name)).toEqual(['owner', 'atlas', 'rune']);
    await request(app()).post('/api/org/channels/platform/read').expect(200);
    const again = await request(app()).get('/api/org/channels').expect(200);
    expect(again.body.channels.find((c: { slug: string }) => c.slug === 'platform').unread).toBe(0);
    await request(app()).get('/api/org/channels/nowhere/members').expect(404);
  });

  it('pages messages, threads and search', async () => {
    const rune = await getAgent('rune');
    const root = await post(rune, 'platform', 'tests pass on the droplet');
    await post(rune, 'platform', 'and again', { thread: root.id });
    const res = await request(app()).get('/api/org/messages').query({ channel: 'platform' }).expect(200);
    expect(res.body.messages.map((m: { body: string }) => m.body)).toEqual(['tests pass on the droplet', 'and again']);
    expect(res.body.cursor).toBe(root.id + 1);
    const live = await request(app()).get('/api/org/messages').query({ after: root.id }).expect(200);
    expect(live.body.messages).toHaveLength(1);
    const thread = await request(app()).get(`/api/org/thread/${root.id}`).expect(200);
    expect(thread.body.messages).toHaveLength(2);
    await request(app()).get('/api/org/thread/999').expect(404);
    const found = await request(app()).get('/api/org/search').query({ q: 'droplet' }).expect(200);
    expect(found.body.messages).toHaveLength(1);
    await request(app()).get('/api/org/messages').query({ channel: 'bad slug!' }).expect(400);
  });

  it('posts and DMs as owner, which wakes the agent', async () => {
    const posted = await request(app()).post('/api/org/post').send({ channel: 'all-hands', body: 'Ship it by Friday' }).expect(201);
    expect(posted.body).toMatchObject({ author: 'owner', channel_slug: 'all-hands', kind: 'message', run_id: 'app' });
    const reply = await request(app()).post('/api/org/post').send({ channel: 'all-hands', body: 'and test it', thread: posted.body.id }).expect(201);
    expect(reply.body.kind).toBe('reply');
    const sent = await request(app()).post('/api/org/dm').send({ to: 'lena', body: 'hold the post' }).expect(201);
    expect(sent.body).toMatchObject({ author: 'owner', channel_slug: 'dm:lena:owner', mentions: ['lena'] });
    const { rows } = await query<{ agent_name: string; reason: string }>(`SELECT agent_name, reason FROM org_wakeups WHERE done_at IS NULL`);
    expect(rows).toEqual([{ agent_name: 'lena', reason: 'owner' }]);
    const bad = await request(app()).post('/api/org/post').send({ channel: 'all-hands', body: 'x', kind: 'standup' }).expect(400);
    expect(bad.body.error.message).toMatch(/invalid request/);
    await request(app()).post('/api/org/dm').send({ to: 'nobody', body: 'x' }).expect(404);
  });

  it('builds an agent page from the board and the vault files', async () => {
    const atlas = await getAgent('atlas');
    await standup(atlas, 'shipped: the board');
    await dm(await getAgent('owner'), 'atlas', 'good');
    await addWakeup('atlas', 'routine', 'weekly-reflection');
    const res = await request(app()).get('/api/org/agents/atlas').expect(200);
    expect(res.body).toMatchObject({
      agent: { name: 'atlas', role: 'Head of Platform' },
      team: { slug: 'platform', lead: 'atlas' },
      is_lead: true,
      reports: ['rune'],
      caps: { wakes_per_day: 6 },
      memory_path: '.agents/org/memory/atlas.md',
    });
    expect(res.body.memory).toContain('learned the board');
    expect(res.body.prompt).toBe('# atlas, Head of Platform\n\n**Personality.** Calm, exact.');
    expect(res.body.open_wakeups.map((w: { reason: string }) => w.reason).sort()).toEqual(['owner', 'routine']);
    expect(res.body.runs).toHaveLength(2);
    expect(res.body.posts.map((m: { kind: string }) => m.kind)).toEqual(['standup']);
    const lena = await request(app()).get('/api/org/agents/lena').expect(200);
    expect(lena.body).toMatchObject({ memory: null, prompt: null, caps: null });
    await request(app()).get('/api/org/agents/nobody').expect(404);
  });
});
