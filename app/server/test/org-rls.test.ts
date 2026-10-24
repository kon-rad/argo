import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agentDatabaseUrl, main } from '../src/cli-org.js';
import { pool, query, setDatabaseUrl } from '../src/db.js';
import { dm, getAgent, importOrg, post, readMessages } from '../src/org.js';
import { truncateAll } from './helpers.js';

/**
 * Phase 6: the sb_org role sees only the caller's channels, whatever SQL it
 * runs. The test database is on a trust-auth local Postgres, so sb_org (created
 * by the migration when missing) logs in without a password.
 */

const ORG = {
  version: 'rls-1',
  company: 'Argo',
  ceo: 'owner',
  agents: {
    owner: { runtime: 'human', role: 'CEO', channels: ['*'] },
    atlas: { role: 'Head of Platform', team: 'platform', reports_to: 'owner' },
    rune: { role: 'Platform engineer', team: 'platform', reports_to: 'atlas' },
    juno: { role: 'Head of Media', team: 'media', reports_to: 'owner' },
    lena: { role: 'Writer', team: 'media', reports_to: 'juno' },
  },
  teams: { platform: { name: 'Platform', lead: 'atlas' }, media: { name: 'Media', lead: 'juno' } },
  channels: { 'all-hands': { members: '*' }, leads: { members: ['owner', 'atlas', 'juno'] } },
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

describe('row-level security for sb_org', () => {
  beforeEach(async () => {
    await truncateAll();
    await importOrg(ORG);
    await post(await getAgent('rune'), 'platform', 'platform secret');
    await post(await getAgent('lena'), 'media', 'media note');
    await post(await getAgent('owner'), 'all-hands', 'hello everyone');
  });

  it('puts the agent name in the connection options', () => {
    expect(agentDatabaseUrl('postgres://sb_org:pw@127.0.0.1:5432/secondbrain', 'lena')).toBe('postgres://sb_org:pw@127.0.0.1:5432/secondbrain?options=-c+org.agent%3Dlena');
  });

  it('an agent reading with raw SQL sees only its channels, messages and memberships', async () => {
    const channels = await sql<{ slug: string }>(asAgent('lena'), `SELECT slug FROM org_channels ORDER BY slug`);
    expect(channels.map((c) => c.slug)).toEqual(['all-hands', 'media', 'media-standup']);
    const messages = await sql<{ body: string }>(asAgent('lena'), `SELECT body FROM org_messages ORDER BY id`);
    expect(messages.map((m) => m.body)).toEqual(['media note', 'hello everyone']);
    const members = await sql<{ channel_slug: string }>(asAgent('lena'), `SELECT DISTINCT channel_slug FROM org_channel_members ORDER BY 1`);
    expect(members.map((m) => m.channel_slug)).toEqual(['all-hands', 'media', 'media-standup']);
    // The roster stays readable: who reports to whom is not a secret inside the company.
    // Five from the org file plus the vault session row the import makes (runtime session).
    const agents = await sql<{ n: number }>(asAgent('lena'), `SELECT count(*)::int AS n FROM org_agents`);
    expect(agents[0]!.n).toBe(6);
    // Nothing without a name.
    const anon = await sql<{ n: number }>(`postgres://sb_org@${process.env.PGHOST ?? 'localhost'}:${process.env.PGPORT ?? '5432'}/${TEST_DB}`, `SELECT count(*)::int AS n FROM org_messages`);
    expect(anon[0]!.n).toBe(0);
  });

  it('the human sees everything through the same role', async () => {
    const rows = await sql<{ n: number }>(asAgent('owner'), `SELECT count(*)::int AS n FROM org_messages`);
    expect(rows[0]!.n).toBe(3);
  });

  it('an agent can post only as itself and only where it belongs; the trigger still wakes', async () => {
    await expect(sql(asAgent('lena'), `INSERT INTO org_messages (channel_slug, author, kind, body) VALUES ('media', 'juno', 'message', 'forged')`)).rejects.toThrow(/row-level security/);
    await expect(sql(asAgent('lena'), `INSERT INTO org_messages (channel_slug, author, kind, body) VALUES ('platform', 'lena', 'message', 'wrong room')`)).rejects.toThrow(/row-level security/);
    await sql(asAgent('lena'), `INSERT INTO org_messages (channel_slug, author, kind, body, mentions) VALUES ('media', 'lena', 'message', '@juno look', '{juno}')`);
    const { rows } = await query<{ agent_name: string; reason: string }>(`SELECT agent_name, reason FROM org_wakeups WHERE done_at IS NULL`);
    expect(rows).toEqual([{ agent_name: 'juno', reason: 'mention' }]);
    // Its own wakeups only; nothing else's.
    expect(await sql(asAgent('lena'), `SELECT id FROM org_wakeups`)).toEqual([]);
    expect(await sql(asAgent('juno'), `SELECT agent_name FROM org_wakeups`)).toEqual([{ agent_name: 'juno' }]);
    await expect(sql(asAgent('lena'), `UPDATE org_messages SET body = 'x'`)).rejects.toThrow(/permission denied/);
    await expect(sql(asAgent('lena'), `DELETE FROM org_wakeups`)).rejects.toThrow(/permission denied/);
  });

  it('DM channels come from the definer function and must include the caller', async () => {
    await expect(sql(asAgent('lena'), `SELECT org_dm_channel('atlas', 'juno')`)).rejects.toThrow(/must include the caller/);
    const [{ org_dm_channel: slug }] = await sql<{ org_dm_channel: string }>(asAgent('lena'), `SELECT org_dm_channel('lena', 'juno')`);
    expect(slug).toBe('dm:juno:lena');
    const seen = await sql<{ slug: string }>(asAgent('lena'), `SELECT slug FROM org_channels WHERE kind = 'dm'`);
    expect(seen).toEqual([{ slug: 'dm:juno:lena' }]);
    expect(await sql(asAgent('rune'), `SELECT slug FROM org_channels WHERE kind = 'dm'`)).toEqual([]);
    // The owner path (app, dispatcher) still works through dm().
    const m = await dm(await getAgent('juno'), 'lena', 'hi');
    expect(m.channel_slug).toBe('dm:juno:lena');
  });

  it('read cursors are private to the agent', async () => {
    await sql(asAgent('lena'), `INSERT INTO org_reads (agent_name, channel_slug, last_read_id) VALUES ('lena', 'media', 1)`);
    await expect(sql(asAgent('lena'), `INSERT INTO org_reads (agent_name, channel_slug, last_read_id) VALUES ('juno', 'media', 1)`)).rejects.toThrow(/row-level security/);
    expect(await sql(asAgent('juno'), `SELECT agent_name FROM org_reads`)).toEqual([]);
  });
});

describe('cli-org as an agent', () => {
  beforeEach(async () => {
    await truncateAll();
    await importOrg(ORG);
    await post(await getAgent('rune'), 'platform', 'platform secret');
    await post(await getAgent('juno'), 'media', 'for the writers');
  });
  afterAll(async () => {
    await pool.end();
  });

  it('switches to the sb_org connection and the policies hold underneath the membership checks', async () => {
    process.env.ORG_AGENT = 'lena';
    process.env.SB_ORG_DB_URL = `postgres://sb_org@${process.env.PGHOST ?? 'localhost'}:${process.env.PGPORT ?? '5432'}/${TEST_DB}`;
    const lines: string[] = [];
    try {
      expect(await main(['read', '--all', '--json'], (s) => lines.push(s))).toBe(0);
      const got = JSON.parse(lines.join('')) as { body: string }[];
      expect(got.map((m) => m.body)).toEqual(['for the writers']);
      // Under the policy a channel the agent is not in does not even exist for it.
      await expect(main(['post', 'platform', 'hi'])).rejects.toThrow('no channel #platform');
      expect(await main(['post', 'media', 'done: draft', '--kind', 'status'], (s) => lines.push(s))).toBe(0);
      const { rows: who } = await query<{ current_user: string; me: string }>(`SELECT current_user, org_me() AS me`);
      expect(who[0]).toEqual({ current_user: 'sb_org', me: 'lena' });
      const lena = await getAgent('lena');
      expect((await readMessages(lena, { unreadOnly: false })).map((m) => m.author)).toEqual(['juno', 'lena']);
    } finally {
      delete process.env.ORG_AGENT;
      delete process.env.SB_ORG_DB_URL;
      setDatabaseUrl(`postgres://${process.env.PGHOST ?? 'localhost'}:${process.env.PGPORT ?? '5432'}/${TEST_DB}`);
    }
  });
});
