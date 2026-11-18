import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCard } from '../src/board.js';
import { main } from '../src/cli-org.js';
import { query } from '../src/db.js';
import { addWakeup, getAgent, importOrg, post } from '../src/org.js';
import { applyOrg, formatPlan, planOrgFile } from '../src/org-apply.js';
import { truncateAll } from './helpers.js';

/** `cli-org plan` and `apply`: the reviewed path for org file changes, with retirement only on --prune. */

const ORG = {
  version: 'apply-1',
  company: 'Argo',
  ceo: 'owner',
  agents: {
    owner: { runtime: 'human', role: 'CEO' },
    atlas: { role: 'Head of Platform', team: 'platform', reports_to: 'owner', model: 'opus', capabilities: ['code'] },
    rune: { role: 'Platform engineer', team: 'platform', reports_to: 'atlas', capabilities: ['code'] },
    vera: { role: 'Reviewer', team: 'platform', reports_to: 'atlas', capabilities: ['review'] },
    juno: { role: 'Head of Media', team: 'media', reports_to: 'owner', model: 'opus' },
    lena: { role: 'Writer', team: 'media', reports_to: 'juno' },
  },
  teams: {
    platform: { name: 'Platform & Agents', lead: 'atlas' },
    media: { name: 'Media & Growth', lead: 'juno' },
  },
  channels: { 'all-hands': { members: '*' } },
};

type Doc = typeof ORG;
const without = (doc: Doc, ...names: string[]): Doc => ({ ...doc, agents: Object.fromEntries(Object.entries(doc.agents).filter(([n]) => !names.includes(n))) as Doc['agents'] });
const withNova = (): Doc => ({ ...ORG, version: 'apply-2', agents: { ...ORG.agents, nova: { role: 'Engineer', team: 'platform', reports_to: 'atlas' } } as Doc['agents'] });

async function cli(args: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const code = await main(args, (s) => lines.push(s));
  return { code, out: lines.join('\n') };
}

function file(doc: unknown): string {
  const p = join(mkdtempSync(join(tmpdir(), 'org-apply-')), 'org.json');
  writeFileSync(p, JSON.stringify(doc));
  return p;
}

const applies = async () => (await query<{ git_sha: string | null; applied_by: string; plan: { version: string } }>(`SELECT git_sha, applied_by, plan FROM config_applies ORDER BY id`)).rows;

beforeEach(async () => {
  await truncateAll();
  await query(`INSERT INTO boards (slug, name) VALUES ('exo', 'Exo') ON CONFLICT DO NOTHING`);
  await importOrg(ORG);
});

describe('cli-org plan', () => {
  it('reports nothing for the file the tables already hold', async () => {
    expect(formatPlan(await planOrgFile(ORG))).toBe('org apply-1: no changes');
  });

  it('shows a new bot, field changes and channel seats, and writes nothing', async () => {
    const doc = withNova();
    doc.agents.rune = { ...doc.agents.rune, model: 'sonnet', capabilities: ['code', 'review'] };
    const p = await planOrgFile(doc);
    expect(p.agents.add).toEqual(['nova']);
    expect(p.agents.change).toEqual([{ name: 'rune', changes: [
      { field: 'model', from: null, to: 'sonnet' },
      { field: 'capabilities', from: ['code'], to: ['code', 'review'] },
    ] }]);
    expect(p.channels.members).toEqual([{ slug: 'platform', add: ['nova'], remove: [] }, { slug: 'platform-standup', add: ['nova'], remove: [] }, { slug: 'all-hands', add: ['nova'], remove: [] }]);
    const r = await cli(['plan', file(doc)]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('+ agent nova');
    expect(r.out).toContain('~ agent rune: model - -> sonnet; capabilities [code] -> [code, review]');
    expect((await query(`SELECT 1 FROM org_agents WHERE name = 'nova'`)).rowCount).toBe(0);
    expect(JSON.parse((await cli(['plan', file(doc), '--json'])).out).agents.add).toEqual(['nova']);
  });
});

describe('cli-org apply', () => {
  it('adds a bot and records the apply', async () => {
    const r = await cli(['apply', file(withNova()), '--sha', 'abc123', '--by', 'owner']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/applied as config_applies #\d+/);
    expect((await getAgent('nova')).team_slug).toBe('platform');
    const rows = await applies();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ git_sha: 'abc123', applied_by: 'owner', plan: { version: 'apply-2' } });
    expect(formatPlan(await planOrgFile(withNova()))).toBe('org apply-2: no changes');
  });

  it('keeps a bot the file dropped unless --prune', async () => {
    await applyOrg(withNova());
    const r = await cli(['apply', file({ ...ORG, version: 'apply-3' })]);
    expect(r.out).toContain('would retire nova (pass --prune)');
    expect((await getAgent('nova')).retired_at).toBeNull();
    // It keeps its seats too: nothing about it changed.
    expect((await query(`SELECT 1 FROM org_channel_members WHERE agent_name = 'nova' AND channel_slug = 'platform'`)).rowCount).toBe(1);
    expect((await query(`SELECT members FROM teams WHERE slug = 'platform'`)).rows[0].members).toContain('nova');
  });

  it('--prune drains and retires the bot and keeps its history', async () => {
    await post(await getAgent('vera'), 'platform', 'reviewed the PR');
    const wake = await addWakeup('vera', 'owner', 'nudge');
    const open = await createCard('owner', { title: 'Review the router', assignee: 'vera' });
    const needsReview = await createCard('owner', { title: 'Review the docs', assignee: 'vera', needs: 'review' });
    const done = await createCard('owner', { title: 'Old review', assignee: 'vera' });
    await query(`UPDATE cards SET status = 'done' WHERE id = $1`, [done.id]);

    const doc = { ...without(ORG, 'vera'), version: 'apply-4' };
    const plan = await planOrgFile(doc, { prune: true });
    expect(plan.agents.retire).toEqual([{ name: 'vera', to: 'atlas', open_cards: [open.id, needsReview.id].sort(), pending_wakeups: 4, in_flight: [] }]); // the nudge and one task wake per card

    const r = await applyOrg(doc, { prune: true, sha: 'def456' });
    expect(r.retired).toEqual(['vera']);
    expect(r.cancelled_wakeups).toBe(4);
    const vera = (await query<{ retired_at: Date | null; capabilities: string[] }>(`SELECT retired_at, capabilities FROM org_agents WHERE name = 'vera'`)).rows[0]!;
    expect(vera.retired_at).not.toBeNull();
    expect(vera.capabilities).toEqual([]);
    expect((await query(`SELECT done_at, result FROM org_wakeups WHERE id = $1`, [wake])).rows[0]).toMatchObject({ result: 'cancelled: vera retired by cli-org apply' });

    // The open card goes to the lead with a comment; one needing a power the lead lacks waits unassigned for the owner.
    const cards = Object.fromEntries((await query<{ id: string; assignee: string | null }>(`SELECT id, assignee FROM cards`)).rows.map((c) => [c.id, c.assignee]));
    expect(cards).toEqual({ [open.id]: 'atlas', [needsReview.id]: null, [done.id]: 'vera' });
    const comments = (await query<{ card_id: string; author: string; body: string }>(`SELECT card_id, author, body FROM card_comments ORDER BY id`)).rows;
    expect(comments.find((c) => c.card_id === open.id)).toMatchObject({ author: 'owner', body: 'vera was retired by cli-org apply (org apply-4); card reassigned to atlas, its lead.' });
    expect(comments.find((c) => c.card_id === needsReview.id)?.body).toMatch(/unassigned for the owner to triage \(atlas lacks the review capability\)/);

    // History stays: the message, the done card, the row itself.
    expect((await query(`SELECT 1 FROM org_messages WHERE author = 'vera'`)).rowCount).toBe(1);
    expect((await query(`SELECT 1 FROM org_channel_members WHERE agent_name = 'vera'`)).rowCount).toBe(0);
    const rows = await applies();
    expect(rows.at(-1)).toMatchObject({ git_sha: 'def456', applied_by: 'owner' });

    // Re-adding the bot un-retires it.
    expect((await planOrgFile(ORG)).agents.unretire).toEqual(['vera']);
    await applyOrg(ORG);
    expect((await getAgent('vera')).capabilities).toEqual(['review']);
  });

  it('defers the retirement of a bot with a run in flight and leaves the run alone', async () => {
    const wake = await addWakeup('rune', 'owner', 'nudge');
    await query(`UPDATE org_wakeups SET claimed_at = now(), claimed_by = 'dispatcher' WHERE id = $1`, [wake]);
    const r = await applyOrg({ ...without(ORG, 'rune'), version: 'apply-5' }, { prune: true });
    expect(r.deferred).toEqual(['rune']);
    expect(r.retired).toEqual([]);
    expect((await getAgent('rune')).retired_at).toBeNull();
    expect((await query(`SELECT done_at FROM org_wakeups WHERE id = $1`, [wake])).rows[0].done_at).toBeNull();
    await query(`UPDATE org_wakeups SET done_at = now() WHERE id = $1`, [wake]);
    expect((await applyOrg({ ...without(ORG, 'rune'), version: 'apply-6' }, { prune: true })).retired).toEqual(['rune']);
  });

  it('refuses to drop a team that still has members, and applies nothing', async () => {
    const noMedia = { ...without(withNova(), 'juno', 'lena'), version: 'apply-7', teams: { platform: ORG.teams.platform } };
    const p = await planOrgFile(noMedia);
    expect(p.teams.remove).toEqual([{ slug: 'media', members: ['juno', 'lena'], open_cards: [] }]);
    expect(formatPlan(p)).toContain('- team media: REFUSED while it has members juno, lena');
    await expect(applyOrg(noMedia)).rejects.toThrow(/refused, nothing applied: team media still has members juno, lena/);
    expect((await query(`SELECT 1 FROM org_agents WHERE name = 'nova'`)).rowCount).toBe(0);
    expect(await applies()).toHaveLength(0);

    // With --prune its members retire, and the empty team and its channels are archived, not deleted.
    const r = await applyOrg(noMedia, { prune: true });
    expect(r.retired).toEqual(['juno', 'lena']);
    expect((await query(`SELECT archived_at, lead FROM teams WHERE slug = 'media'`)).rows[0]).toMatchObject({ lead: null });
    expect((await query(`SELECT archived_at FROM teams WHERE slug = 'media'`)).rows[0].archived_at).not.toBeNull();
    expect((await query(`SELECT slug FROM org_channels WHERE archived_at IS NOT NULL ORDER BY slug`)).rows.map((c) => c.slug)).toEqual(['media', 'media-standup']);
    expect(formatPlan(await planOrgFile(noMedia))).toBe('org apply-7: no changes');
  });

  it('refuses to drop a team whose board has open cards', async () => {
    await query(`INSERT INTO boards (slug, name, team_slug) VALUES ('media-board', 'Media', 'media')`);
    const c = await createCard('owner', { title: 'Write the post', board: 'media-board' });
    const noMedia = { ...without(ORG, 'juno', 'lena'), version: 'apply-8', teams: { platform: ORG.teams.platform } };
    await expect(applyOrg(noMedia, { prune: true })).rejects.toThrow(new RegExp(`open cards ${c.id}`));
  });
});
