import pg from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
import { claimCard, createCard, dispatchState, getCard, pauseAgents, resumeAgents, setDispatch } from '../src/board.js';
import { agentDatabaseUrl } from '../src/cli-org.js';
import { query } from '../src/db.js';
import { importOrg } from '../src/org.js';
import { truncateAll } from './helpers.js';

/**
 * Pause and resume: the cutover's phase 1b control plane. One owner-only switch in Postgres that stops new claims
 * for one bot, a whole team or the whole board. A pause stops new work only; a run that already holds a lease keeps
 * its card, so a pause never orphans work mid-flight. Resume clears the flags and the next claim succeeds. The
 * claim-contention guarantee (two connections racing) still holds with a pause in play, which is the point of
 * putting the gate inside board_card_claim rather than in each backend's loop.
 */

const ORG = {
  version: 'board-pause-1',
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
  },
  teams: { platform: { name: 'Platform', lead: 'atlas' }, media: { name: 'Media', lead: 'juno' }, staff: { name: 'Staff', lead: 'sol' } },
  channels: { 'all-hands': { members: '*' }, leads: { members: ['owner', 'atlas', 'juno', 'sol'] } },
};

const TEST_DB = process.env.SB_TEST_DB ?? 'secondbrain_test';
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

beforeEach(async () => {
  await truncateAll();
  await importOrg(ORG);
});

describe('board pause and resume', () => {
  it('a paused agent cannot claim; resume releases it; the card is still ready and waits for the next wake', async () => {
    const c = await createCard('owner', { title: 'Rune work', assignee: 'rune' });
    expect(await pauseAgents('owner', 'rune', true, 'budget day')).toBe(1);
    expect((await query<{ paused: boolean; paused_reason: string }>(`SELECT paused, paused_reason FROM org_agents WHERE name = 'rune'`)).rows[0]).toMatchObject({ paused: true, paused_reason: 'budget day' });
    // A claim for rune returns null and takes nothing: the card stays ready for a later wake.
    expect(await claimCard(null, { agent: 'rune' })).toBeNull();
    expect((await getCard(c.id)).card.status).toBe('ready');
    // Resume clears the flag; the same claim now succeeds.
    expect(await resumeAgents('owner', 'rune')).toBe(1);
    const got = await claimCard(null, { agent: 'rune' });
    expect(got!.id).toBe(c.id);
  });

  it('a pause does not take a card a run already holds: the lease survives and the run can finish it', async () => {
    const c = await createCard('owner', { title: 'In flight', assignee: 'rune' });
    const claimed = await claimCard(null, { agent: 'rune' });
    expect(claimed!.id).toBe(c.id);
    await pauseAgents('owner', 'rune', true, 'deploy window');
    // The card is running, not bounced to ready by the pause.
    expect((await getCard(c.id)).card.status).toBe('running');
  });

  it('pausing a team pauses its members and not other teams; resume clears each', async () => {
    await createCard('owner', { title: 'Rune', assignee: 'rune' });
    await createCard('owner', { title: 'Lena', assignee: 'lena' });
    const n = await pauseAgents('owner', 'platform', true, 'platform freeze');
    expect(n).toBeGreaterThanOrEqual(2); // rune and vera, the two platform bots
    expect(await claimCard(null, { agent: 'rune' })).toBeNull();
    expect((await claimCard(null, { agent: 'lena' }))!.title).toBe('Lena');
    const paused = await query<{ name: string }>(`SELECT name FROM org_agents WHERE paused ORDER BY name`);
    expect(paused.rows.map((r) => r.name).sort()).toEqual(['atlas', 'rune', 'vera']);
    expect(await resumeAgents('owner', 'platform')).toBeGreaterThanOrEqual(2);
    expect((await query(`SELECT 1 FROM org_agents WHERE paused`)).rows).toHaveLength(0);
  });

  it('pausing all covers every bot on the board and leaves a human untouched', async () => {
    await createCard('owner', { title: 'Rune', assignee: 'rune' });
    const n = await pauseAgents('owner', 'all', true, 'board freeze');
    expect(n).toBeGreaterThanOrEqual(6);
    expect(await claimCard(null, { runtime: 'zen-agent' })).toBeNull();
    expect(await claimCard(null, { runtime: 'hermes' })).toBeNull();
    const human = await query<{ paused: boolean }>(`SELECT paused FROM org_agents WHERE name = 'owner'`);
    expect(human.rows[0]!.paused).toBe(false);
  });

  it('a disabled board refuses every claim; enabling it lets claims through again', async () => {
    const c = await createCard('owner', { title: 'Anything', assignee: 'rune' });
    await setDispatch('owner', false, 'cutover rehearsal');
    expect(await claimCard(null, { agent: 'rune' })).toBeNull();
    expect(await claimCard(null, { runtime: 'zen-agent' })).toBeNull();
    expect((await getCard(c.id)).card.status).toBe('ready');
    await setDispatch('owner', true);
    expect((await claimCard(null, { agent: 'rune' }))!.id).toBe(c.id);
  });

  it('only the owner or a dispatch bot may pause or resume; a normal bot cannot', async () => {
    await expect(pauseAgents('rune', 'rune', true, 'self-pause')).rejects.toThrow(/may not pause or resume/);
    await expect(setDispatch('rune', false, 'nope')).rejects.toThrow(/may not change dispatch/);
    expect(await pauseAgents('sol', 'rune', true, 'dispatch bot pauses a colleague')).toBe(1);
  });

  it('a pause needs a reason, and a disabled board needs one too', async () => {
    await expect(pauseAgents('owner', 'rune', true, '  ')).rejects.toThrow(/needs a reason/);
    await expect(setDispatch('owner', false)).rejects.toThrow(/needs a reason/);
  });

  it('a pause leaves an audit line on #platform, so the owners and leads see it', async () => {
    // card_events.card_id is NOT NULL by design (a card-scoped log), and a pause has no card, so the control-plane
    // audit line goes to #platform as a status message authored by whoever acted.
    await pauseAgents('owner', 'rune', true, 'audit');
    const m = await query<{ channel_slug: string; author: string; kind: string; body: string }>(`SELECT channel_slug, author, kind, body FROM org_messages ORDER BY id DESC LIMIT 1`);
    expect(m.rows[0]).toMatchObject({ channel_slug: 'platform', author: 'owner', kind: 'status' });
    expect(m.rows[0]!.body).toContain('paused: rune');
    expect(m.rows[0]!.body).toContain('audit');
    await resumeAgents('owner', 'rune');
    const m2 = await query<{ body: string }>(`SELECT body FROM org_messages ORDER BY id DESC LIMIT 1`);
    expect(m2.rows[0]!.body).toContain('resumed: rune');
  });

  it('claim contention with two connections still holds with a pause on another agent', async () => {
    const a = await createCard('owner', { title: 'A', assignee: 'rune', priority: 1 });
    const b = await createCard('owner', { title: 'B', assignee: 'rune', priority: 3 });
    await pauseAgents('owner', 'lena', true, 'unrelated');
    // Two separate sb_org connections claim at the same time; each gets a different card and neither double-claims.
    const [x, y] = await Promise.all([
      sql<{ id: string }>(asAgent('rune'), `SELECT * FROM board_card_claim($1,$2,$3,$4,$5,$6,$7)`, ['rune', null, 'rune', 60, null, null, null]),
      sql<{ id: string }>(asAgent('rune'), `SELECT * FROM board_card_claim($1,$2,$3,$4,$5,$6,$7)`, ['rune', null, 'rune', 60, null, null, null]),
    ]);
    const got = [x[0]?.id, y[0]?.id].filter(Boolean).sort();
    expect(got).toEqual([a.id, b.id].sort());
    expect((await getCard(a.id)).card.status).toBe('running');
    expect((await getCard(b.id)).card.status).toBe('running');
  });

  it('resume of an agent that was never paused is a no-op and returns 0', async () => {
    // A resume writes the flag to false for a matching row; when nothing matched, 0 rows changed.
    expect(await resumeAgents('owner', 'rune')).toBe(1); // rune's row exists, just not paused
    await expect(resumeAgents('owner', 'nobody')).rejects.toThrow(/no agent or team named/);
  });
});
