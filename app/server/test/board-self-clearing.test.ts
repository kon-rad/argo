import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { blockCard, claimCard, commentCard, createCard, createToken, finishCard, getCard, recordRunOutput, reclaim, type Card } from '../src/board.js';
import { formatCard, main } from '../src/cli-board.js';
import { query } from '../src/db.js';
import { importOrg } from '../src/org.js';
import { ALL_MODULES, truncateAll } from './helpers.js';

/**
 * Blocks that clear themselves (board module, migration 1756000018800): dependency blocks are links released by
 * the last dependency's finish or by reclaim, host-down blocks retry on host-up at most 3 times, running cards whose
 * run already ended are reconciled, and none of it ever moves a done or archived card.
 */

const ORG = {
  version: 'board-self-clearing-1',
  company: 'Argo',
  ceo: 'owner',
  agents: {
    owner: { runtime: 'human', role: 'CEO', channels: ['*'] },
    atlas: { role: 'Head of Platform', team: 'platform', reports_to: 'owner', capabilities: ['review', 'merge'] },
    rune: { runtime: 'zen-agent', role: 'Platform engineer', team: 'platform', reports_to: 'atlas', capabilities: ['code'] },
  },
  teams: { platform: { name: 'Platform', lead: 'atlas' } },
  channels: { 'all-hands': { members: '*' } },
};

const run = async (argv: string[]): Promise<{ code: number; lines: string[] }> => {
  const lines: string[] = [];
  const code = await main(argv, (s) => lines.push(s), { ...process.env, BOARD_URL: undefined, BOARD_TOKEN: undefined, ORG_AGENT: undefined });
  return { code, lines };
};

const card = async (id: string): Promise<Card> => (await getCard(id)).card;
const events = async (id: string, kind: string): Promise<Record<string, unknown>[]> =>
  (await getCard(id)).events.filter((e) => e.kind === kind).map((e) => e.payload ?? {});
const eventCount = async (id: string): Promise<number> => (await getCard(id)).events.length;

beforeEach(async () => {
  await truncateAll();
  await importOrg(ORG);
});

describe('dependency blocks are links', () => {
  it('the last dependency finishing done releases its waiter in the same transaction; a waiter with another open dependency stays blocked', async () => {
    const specA = await createCard('owner', { title: 'Spec A', assignee: 'atlas', kind: 'spec' });
    const specB = await createCard('owner', { title: 'Spec B', assignee: 'atlas', kind: 'spec' });
    const one = await createCard('owner', { title: 'Build one', assignee: 'rune' });
    const two = await createCard('owner', { title: 'Build two', assignee: 'rune' });

    // The CLI form records the link: `move <card> blocked --after <t_x>`.
    const moved = await run(['move', one.id, 'blocked', '--after', specA.id, 'waits for spec A']);
    expect(moved.code).toBe(0);
    expect(moved.lines[0]).toBe(`${one.id} is blocked (dependency)`);
    await blockCard('owner', two.id, { after: [specA.id, specB.id], reason: 'waits for both specs' });
    expect(await card(one.id)).toMatchObject({ status: 'blocked', block_kind: 'dependency', block_reason: 'waits for spec A' });
    expect((await getCard(one.id)).depends_on.map((d) => d.id)).toEqual([specA.id]);
    expect((await getCard(two.id)).depends_on.map((d) => d.id).sort()).toEqual([specA.id, specB.id].sort());

    // Spec A finishes: one is ready the moment the finish returns, with an event naming spec A; two still waits for B.
    await finishCard('atlas', specA.id, { outcome: 'done', result: 'written' });
    expect(await card(one.id)).toMatchObject({ status: 'ready', block_kind: null, block_reason: null });
    expect(await events(one.id, 'released')).toEqual([{ by: specA.id, by_status: 'done', from: 'blocked' }]);
    expect(await card(two.id)).toMatchObject({ status: 'blocked', block_kind: 'dependency' });
    expect(await events(two.id, 'released')).toEqual([]);
    // The released card woke its bot.
    expect((await query<{ ref: string }>(`SELECT ref FROM org_wakeups WHERE agent_name = 'rune' AND done_at IS NULL`)).rows.map((r) => r.ref)).toContain(one.id);

    await finishCard('atlas', specB.id, { outcome: 'done', result: 'written' });
    expect((await card(two.id)).status).toBe('ready');
    expect(await events(two.id, 'released')).toEqual([{ by: specB.id, by_status: 'done', from: 'blocked' }]);
  });

  it('blocking on cards that are already done releases at once; host and after are checked against the kind', async () => {
    const spec = await createCard('owner', { title: 'Spec', assignee: 'atlas' });
    await finishCard('atlas', spec.id, { outcome: 'done', result: 'ok' });
    const build = await createCard('owner', { title: 'Build', assignee: 'rune' });
    const c = await blockCard('owner', build.id, { after: [spec.id] });
    expect(c.status).toBe('ready');
    expect(await events(build.id, 'released')).toEqual([{ by: null, why: 'every dependency had already finished' }]);
    // A dependency block with no link and no --after is refused: it could never clear itself.
    const loose = await createCard('owner', { title: 'Loose', assignee: 'rune' });
    await expect(blockCard('owner', loose.id, { kind: 'dependency' })).rejects.toThrow(/names the card it waits for/);
    await expect(blockCard('owner', build.id, { kind: 'other', host: 'gpu-box' })).rejects.toThrow(/--host goes with block kind host-down/);
    await expect(blockCard('owner', build.id, { kind: 'host-down' })).rejects.toThrow(/names its host/);
    await expect(run(['move', build.id, 'ready', '--after', spec.id])).rejects.toThrow(/go with: move <card> blocked/);
    // A bot blocks only its own card, as with a move.
    const other = await createCard('owner', { title: 'Not rune\'s', assignee: 'atlas' });
    await expect(blockCard('rune', other.id, { host: 'gpu-box' })).rejects.toThrow(/can't move/);
  });

  it('reclaim clears a stale dependency block: one with links, and an older one that named its card only in the reason', async () => {
    const spec = await createCard('owner', { title: 'Spec', assignee: 'atlas' });
    const open = await createCard('owner', { title: 'Still open', assignee: 'atlas' });
    await finishCard('atlas', spec.id, { outcome: 'done', result: 'ok' });
    const linked = await createCard('owner', { title: 'Linked waiter', assignee: 'rune' });
    const legacy = await createCard('owner', { title: 'Legacy waiter', assignee: 'rune' });
    const waitsOpen = await createCard('owner', { title: 'Waits for an open card', assignee: 'rune' });
    const vague = await createCard('owner', { title: 'Names no card', assignee: 'rune' });
    // The state the board was left in before this change: blocked on a card that has since finished.
    await query(`INSERT INTO card_deps (card_id, depends_on) VALUES ($1, $2)`, [linked.id, spec.id]);
    await query(`UPDATE cards SET status = 'blocked', block_kind = 'dependency', block_reason = 'waits for the spec' WHERE id = $1`, [linked.id]);
    await query(`UPDATE cards SET status = 'blocked', block_kind = 'dependency', block_reason = $2 WHERE id = $1`, [legacy.id, `waits for ${spec.id} to land`]);
    await query(`UPDATE cards SET status = 'blocked', block_kind = 'dependency', block_reason = $2 WHERE id = $1`, [waitsOpen.id, `after ${open.id}`]);
    await query(`UPDATE cards SET status = 'blocked', block_kind = 'dependency', block_reason = 'waits for the vendor' WHERE id = $1`, [vague.id]);

    expect(await reclaim()).toBe(2);
    expect(await card(linked.id)).toMatchObject({ status: 'ready', block_kind: null });
    expect(await events(linked.id, 'released')).toEqual([{ by: spec.id, from: 'blocked', via: 'reclaim' }]);
    expect(await card(legacy.id)).toMatchObject({ status: 'ready', block_kind: null });
    expect((await getCard(legacy.id)).depends_on.map((d) => d.id)).toEqual([spec.id]);
    expect(await events(legacy.id, 'linked')).toEqual([{ depends_on: spec.id, why: 'named in the block reason' }]);
    // The one naming an open card is now a real link and stays blocked until that card is done; the vague one is left alone.
    expect(await card(waitsOpen.id)).toMatchObject({ status: 'blocked', block_kind: 'dependency' });
    expect((await getCard(waitsOpen.id)).depends_on.map((d) => d.id)).toEqual([open.id]);
    expect(await card(vague.id)).toMatchObject({ status: 'blocked', block_kind: 'dependency' });
    await finishCard('atlas', open.id, { outcome: 'done', result: 'ok' });
    expect((await card(waitsOpen.id)).status).toBe('ready');
    // A second sweep has nothing left to do.
    expect(await reclaim()).toBe(0);
  });
});

describe('host-down blocks retry on host-up', () => {
  it('host-up re-queues a host-down card, and stops after 3 automatic retries with the count shown', async () => {
    const c = await createCard('owner', { title: 'Render on the GPU box', assignee: 'rune' });
    const other = await createCard('owner', { title: 'Render on the build box', assignee: 'rune' });
    const blocked = await run(['move', c.id, 'blocked', '--host', 'gpu-box', 'ollama not answering']);
    expect(blocked.lines[0]).toBe(`${c.id} is blocked (host-down gpu-box, retries 0/3)`);
    await blockCard('owner', other.id, { host: 'build-box', reason: 'asleep' });
    expect(await card(c.id)).toMatchObject({ status: 'blocked', block_kind: 'host-down', block_host: 'gpu-box', host_retries: 0 });

    // The timer alone, or another host coming up, does not touch it.
    expect(await reclaim()).toBe(0);
    expect(await reclaim(['build-box'])).toBe(1);
    expect((await card(c.id)).status).toBe('blocked');
    expect((await card(other.id)).status).toBe('ready');

    for (let i = 1; i <= 3; i++) {
      const up = await run(['host-up', 'GPU-BOX']);
      expect(up.lines[0]).toBe('1 card(s) moved');
      expect(await card(c.id)).toMatchObject({ status: 'ready', block_kind: null, block_host: null, host_retries: i });
      await blockCard('owner', c.id, { host: 'gpu-box', reason: 'down again' });
    }
    expect((await events(c.id, 'host-retry')).map((e) => e.retry)).toEqual([1, 2, 3]);
    // The fourth report leaves it blocked, with the count on the card.
    expect((await run(['host-up', 'gpu-box'])).lines[0]).toBe('0 card(s) moved');
    const last = await card(c.id);
    expect(last).toMatchObject({ status: 'blocked', block_kind: 'host-down', block_host: 'gpu-box', host_retries: 3 });
    expect(formatCard(last)).toContain('(blocked: host-down gpu-box, retries 3/3 (no more automatic retries))');
    expect((await run(['reclaim', '--host-up', 'gpu-box'])).lines[0]).toBe('0 card(s) moved');
    // A move to another kind drops the host.
    await blockCard('owner', c.id, { kind: 'needs-owner', reason: 'look at the GPU box' });
    expect(await card(c.id)).toMatchObject({ block_kind: 'needs-owner', block_host: null });
  });

  it('any token holder may report a host up over HTTP; the block route takes after and host', async () => {
    const a = createApp({ modules: ALL_MODULES, board: { owner: 'owner' } });
    const rune = (await createToken('rune', 'rune box')).token;
    const c = await createCard('owner', { title: 'Needs the GPU box', assignee: 'rune' });
    const blocked = await request(a).post(`/api/board/cards/${c.id}/block`).set('Authorization', `Bearer ${rune}`).send({ host: 'gpu-box', note: 'down' }).expect(200);
    expect(blocked.body.card).toMatchObject({ status: 'blocked', block_kind: 'host-down', block_host: 'gpu-box' });
    await request(a).post('/api/board/host-up').set('Authorization', `Bearer ${rune}`).send({ hosts: ['bad host'] }).expect(400);
    expect((await request(a).post('/api/board/host-up').set('Authorization', `Bearer ${rune}`).send({ hosts: ['gpu-box'] }).expect(200)).body).toEqual({ reclaimed: 1 });
    expect((await card(c.id)).status).toBe('ready');
    // The owner-only sweep stays owner-only.
    await request(a).post('/api/board/reclaim').set('Authorization', `Bearer ${rune}`).expect(403);
  });
});

describe('running cards whose run already ended reconcile', () => {
  const claimed = async (title: string): Promise<{ id: string; runId: number }> => {
    const c = await createCard('owner', { title, assignee: 'rune' });
    const got = await claimCard(null, { taskId: c.id, agent: 'rune' });
    expect(got?.id).toBe(c.id);
    return { id: c.id, runId: (await getCard(c.id)).runs[0]!.id };
  };
  // The stale state: the run was closed (a finish that half-landed, a runner that died after closing it) but the card still says running.
  const endRun = (id: string): Promise<unknown> => query(`UPDATE card_runs SET finished_at = now(), outcome = 'partial' WHERE card_id = $1 AND finished_at IS NULL`, [id]);

  it('a running card with a finished run and a PR moves to review; without one to ready; a live lease is left alone', async () => {
    const withPr = await claimed('Has a PR');
    await recordRunOutput('rune', withPr.id, { branch: 'card/x-fix', pr: 'https://example.com/acme/engine/pull/7' });
    await endRun(withPr.id);
    const fromComment = await claimed('PR only in a comment');
    await commentCard('rune', fromComment.id, 'opened https://example.com/acme/engine/pull/8 for review');
    await endRun(fromComment.id);
    const bare = await claimed('Left nothing');
    await endRun(bare.id);
    const live = await claimed('Still working');

    expect(await reclaim()).toBe(3);
    expect((await card(withPr.id)).status).toBe('review');
    expect(await events(withPr.id, 'reconciled')).toEqual([
      { run: withPr.runId, run_id: null, outcome: 'partial', to: 'review', branch: 'card/x-fix', pr: 'https://example.com/acme/engine/pull/7' },
    ]);
    expect((await card(fromComment.id)).status).toBe('review');
    expect((await events(fromComment.id, 'reconciled'))[0]).toMatchObject({ to: 'review', pr: 'https://example.com/acme/engine/pull/8' });
    expect((await card(bare.id)).status).toBe('ready');
    expect((await events(bare.id, 'reconciled'))[0]).toMatchObject({ run: bare.runId, to: 'ready', branch: null, pr: null });
    expect((await card(live.id)).status).toBe('running');
    expect(await reclaim()).toBe(0);
  });

  it('heartbeat --branch/--pr records what the run left, shown on the card', async () => {
    const c = await claimed('Branch via the CLI');
    const hb = await run(['heartbeat', c.id, '--branch', 'card/y', '--pr', 'https://example.com/acme/engine/pull/9']);
    expect(hb.code).toBe(0);
    expect((await getCard(c.id)).runs[0]).toMatchObject({ branch: 'card/y', pr: 'https://example.com/acme/engine/pull/9' });
    expect((await run(['show', c.id])).lines[0]).toContain('branch card/y · https://example.com/acme/engine/pull/9');
  });
});

describe('a done or archived card is never moved', () => {
  it('is untouched by dependency release, dependency re-test, host-up and run reconcile', async () => {
    const spec = await createCard('owner', { title: 'Spec', assignee: 'atlas' });
    // Done card waiting on spec (a link left over from before it was finished).
    const doneWaiter = await createCard('owner', { title: 'Done waiter', assignee: 'rune' });
    await query(`INSERT INTO card_deps (card_id, depends_on) VALUES ($1, $2)`, [doneWaiter.id, spec.id]);
    await finishCard('rune', doneWaiter.id, { outcome: 'done', result: 'shipped anyway' });
    // Done and archived cards still carrying an old block (as cards closed by hand do).
    const doneDep = await createCard('owner', { title: 'Done, old dependency block', assignee: 'rune' });
    const doneHost = await createCard('owner', { title: 'Done, old host block', assignee: 'rune' });
    const archivedHost = await createCard('owner', { title: 'Archived, old host block', assignee: 'rune' });
    await query(`UPDATE cards SET status = 'done', block_kind = 'dependency', block_reason = $2 WHERE id = $1`, [doneDep.id, `after ${spec.id}`]);
    await query(`UPDATE cards SET status = 'done', block_kind = 'host-down', block_host = 'gpu-box' WHERE id = $1`, [doneHost.id]);
    await query(`UPDATE cards SET status = 'archived', block_kind = 'host-down', block_host = 'gpu-box' WHERE id = $1`, [archivedHost.id]);
    // Done and archived cards with a finished run that left a PR.
    const donePr = await createCard('owner', { title: 'Done with PR', assignee: 'rune' });
    await claimCard(null, { taskId: donePr.id, agent: 'rune' });
    await recordRunOutput('rune', donePr.id, { pr: 'https://example.com/acme/engine/pull/10' });
    await finishCard('rune', donePr.id, { outcome: 'done', result: 'merged' });
    const archivedPr = await createCard('owner', { title: 'Archived with PR', assignee: 'rune' });
    await claimCard(null, { taskId: archivedPr.id, agent: 'rune' });
    await recordRunOutput('rune', archivedPr.id, { pr: 'https://example.com/acme/engine/pull/11' });
    await query(`UPDATE card_runs SET finished_at = now(), outcome = 'partial' WHERE card_id = $1`, [archivedPr.id]);
    await query(`UPDATE cards SET status = 'archived' WHERE id = $1`, [archivedPr.id]);

    const all = [doneWaiter, doneDep, doneHost, archivedHost, donePr, archivedPr].map((c) => c.id);
    const before = await Promise.all(all.map(async (id) => ({ id, status: (await card(id)).status, events: await eventCount(id) })));
    expect(before.map((b) => b.status)).toEqual(['done', 'done', 'done', 'archived', 'done', 'archived']);

    await finishCard('atlas', spec.id, { outcome: 'done', result: 'ok' });   // the dependency path
    expect(await reclaim(['gpu-box'])).toBe(0);                                 // re-test, host-up and reconcile
    expect((await run(['host-up', 'gpu-box'])).lines[0]).toBe('0 card(s) moved');
    const after = await Promise.all(all.map(async (id) => ({ id, status: (await card(id)).status, events: await eventCount(id) })));
    expect(after).toEqual(before);
    await expect(blockCard('owner', doneWaiter.id, { host: 'gpu-box' })).rejects.toThrow(/already done/);
  });
});
