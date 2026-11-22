// Owner-controlled review mode at the SQL boundary (migration 1756000020900, docs/automatic-review.md "Review mode").
import pg from 'pg';
import { beforeEach, afterAll, it, expect, describe } from 'vitest';
import { query } from '../src/db.js';
import { importOrg } from '../src/org.js';
import { createCard, finishCard, getCard } from '../src/board.js';
import { truncateAll } from './helpers.js';

const workerName = 'sb_review_fixture';
const url = `postgres://${process.env.PGHOST ?? 'localhost'}:${process.env.PGPORT ?? '5432'}/${process.env.SB_TEST_DB ?? 'secondbrain_test'}`;
function asUrl(user: string): string { const u = new URL(url); u.username = user; return u.toString(); }
async function as(user: string, sql: string, params: unknown[] = []): Promise<pg.QueryResult> {
  const c = new pg.Client({ connectionString: asUrl(user), options: user === 'sb_org' ? '-c org.agent=builder' : undefined });
  await c.connect(); try { return await c.query(sql, params); } finally { await c.end(); }
}
const head = 'a'.repeat(40), base = 'b'.repeat(40), merged = 'c'.repeat(40), evidence = 'e'.repeat(64);
const snapshot = (h = head) => ({ repo: 'example/engine', pr: 7, head: h, base, branch: 'main', merged: null, checks: [], sources: [] });
const auth = (over: Record<string, unknown> = {}) => ({ mode: 'builder', builder: 'builder', repo: 'example/engine', pr: 7, head, base, evidence, checks: ['test'], ...over });

beforeEach(async () => {
  await query(`UPDATE review_policy SET enabled=false,reviewer=NULL,worker_login=NULL`);
  await truncateAll();
  await importOrg({ version: 'review-mode-fixture', company: 'Example', ceo: 'owner', agents: {
    owner: { runtime: 'human', role: 'Owner' },
    builder: { runtime: 'codex', model: 'test-codex', team: 'engineering', reports_to: 'auditor', role: 'Builder', capabilities: ['code'] },
    stranger: { runtime: 'codex', model: 'test-codex', team: 'engineering', reports_to: 'auditor', role: 'Builder', capabilities: ['code'] },
    auditor: { runtime: 'codex', model: 'test-codex', team: 'engineering', reports_to: 'owner', role: 'Reviewer', capabilities: ['review'] },
  }, teams: { engineering: { name: 'Engineering', lead: 'auditor' } }, channels: {} });
  await query(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='sb_review_fixture') THEN CREATE ROLE sb_review_fixture LOGIN; END IF; END $$`);
  if (process.env.PGPASSWORD) await query(`ALTER ROLE sb_review_fixture PASSWORD '${process.env.PGPASSWORD.replace(/'/g, "''")}'`);
  await query(`GRANT sb_review_worker TO sb_review_fixture`);
  await query(`UPDATE review_policy SET enabled=true,shipping_enabled=true,boards=NULL,repositories=NULL,max_rounds=2,reviewer='auditor',worker_login=$1,
    independent_review=true,builder_merge_agents='{}'`, [workerName]);
});
afterAll(async () => { await query(`UPDATE review_policy SET enabled=false,reviewer=NULL,worker_login=NULL,independent_review=true,builder_merge_agents='{}'`); });

async function submit(assignee = 'builder') {
  const c = await createCard('owner', { title: 'Mode fixture', body: 'Acceptance: tests pass', assignee, work: 'coding', repo: 'engine' });
  await finishCard(assignee, c.id, { outcome: 'done' });
  return { card: c.id, job: (await query('SELECT * FROM review_jobs WHERE card=$1 ORDER BY id DESC LIMIT 1', [c.id])).rows[0]! };
}
const relax = (agents = ['builder']) => query(`UPDATE review_policy SET independent_review=false,builder_merge_agents=$1`, [agents]);
const row = async (id: number) => (await query('SELECT * FROM review_jobs WHERE id=$1', [id])).rows[0]!;
const mode = async (card: string, user = workerName) => (await as(user, 'SELECT review_merge_mode($1) AS m', [card])).rows[0].m;
async function shipBuilder(id: number) {
  await as(workerName, 'SELECT review_save($1,$2)', [id, { snapshot: snapshot(), state: 'approved' }]);
  await as(workerName, 'SELECT review_builder_authorize($1,$2)', [id, auth()]);
  await as(workerName, 'SELECT review_save($1,$2)', [id, { state: 'deployed', merged, deployed: merged, health: merged }]);
  await as(workerName, 'SELECT review_complete($1)', [id]);
}

describe('defaults', () => {
  it('a stranger gets independent review: the columns default on and no builder is listed', async () => {
    const p = (await query('SELECT independent_review,builder_merge_agents FROM review_policy')).rows[0]!;
    expect((await query(`SELECT column_default FROM information_schema.columns WHERE table_name='review_policy' AND column_name='independent_review'`)).rows[0]!.column_default).toBe('true');
    expect(p).toEqual({ independent_review: true, builder_merge_agents: [] });
    const { card, job } = await submit();
    expect(job.mode).toBe('independent');
    expect(await mode(card)).toMatchObject({ gated: true, independent_review: true, builder_authorized: false, mode: 'independent', submission_mode: 'independent' });
  });
  it('turning independent review off without listing a builder still requires review', async () => {
    await relax([]); const { job } = await submit(); expect(job.mode).toBe('independent');
    await expect(as(workerName, 'SELECT review_builder_authorize($1,$2)', [job.id, auth()])).rejects.toThrow(/requires independent review/);
  });
});

describe('builder mode', () => {
  it('an authorized builder submission ships on an exact-head authorization with an honest receipt', async () => {
    await relax(); const { card, job } = await submit(); expect(job.mode).toBe('builder');
    expect(await mode(card, 'sb_org')).toMatchObject({ mode: 'builder', builder_authorized: true, merge_authorized: false });
    await shipBuilder(job.id);
    const done = await row(job.id);
    expect(done).toMatchObject({ state: 'done', mode: 'builder', verdict: null, merged });
    expect(done.merge_authorization).toMatchObject({ mode: 'builder', head, authorized_by: workerName });
    expect((await getCard(card)).card.status).toBe('done');
    const events = (await query(`SELECT kind,payload FROM card_events WHERE card_id=$1 AND kind IN ('review-shipped','builder-shipped','review-builder-authorized') ORDER BY id`, [card])).rows;
    expect(events.map(e => e.kind)).toEqual(['review-builder-authorized', 'builder-shipped']);
    expect(events[1]!.payload).toMatchObject({ mode: 'builder', independent_review: false, head });
  });
  it('an unlisted builder is not authorized even with review off', async () => {
    await relax(['builder']); const { card, job } = await submit('stranger');
    expect(job.mode).toBe('independent'); expect(await mode(card)).toMatchObject({ mode: 'independent', builder_authorized: false });
    await as(workerName, 'SELECT review_save($1,$2)', [job.id, { snapshot: snapshot() }]);
    await expect(as(workerName, 'SELECT review_builder_authorize($1,$2)', [job.id, auth({ builder: 'stranger' })])).rejects.toThrow(/requires independent review/);
  });
  it('builders and the board login cannot authorize, withdraw or write mode directly', async () => {
    await relax(); const { job } = await submit();
    await as(workerName, 'SELECT review_save($1,$2)', [job.id, { snapshot: snapshot() }]);
    await expect(as('sb_org', 'SELECT review_builder_authorize($1,$2)', [job.id, auth()])).rejects.toThrow(/permission denied/);
    await expect(as('sb_org', 'SELECT review_builder_withdraw($1,$2)', [job.id, 'x'])).rejects.toThrow(/permission denied/);
    await expect(as('sb_org', `UPDATE review_jobs SET merge_authorization='{}' WHERE id=$1`, [job.id])).rejects.toThrow(/permission denied/);
    await expect(as(workerName, `UPDATE review_jobs SET mode='builder' WHERE id=$1`, [job.id])).rejects.toThrow(/permission denied/);
    // review_save never writes the authorization, even if a patch names it.
    await as(workerName, 'SELECT review_save($1,$2)', [job.id, { merge_authorization: auth() }]);
    expect((await row(job.id)).merge_authorization).toBeNull();
  });
  it.each([
    ['another head', { head: 'd'.repeat(40) }], ['another base', { base: 'd'.repeat(40) }], ['another PR', { pr: 8 }], ['another repo', { repo: 'example/other' }],
    ['another builder', { builder: 'stranger' }], ['no evidence', { evidence: 'short' }], ['a verdict mode', { mode: 'independent' }],
  ] as const)('refuses an authorization bound to %s', async (_, change) => {
    await relax(); const { job } = await submit();
    await as(workerName, 'SELECT review_save($1,$2)', [job.id, { snapshot: snapshot() }]);
    await expect(as(workerName, 'SELECT review_builder_authorize($1,$2)', [job.id, auth(change)])).rejects.toThrow(/exact recorded head/);
  });
  it('a new head drops the authorization, and completion without one is refused', async () => {
    await relax(); const { job } = await submit();
    await as(workerName, 'SELECT review_save($1,$2)', [job.id, { snapshot: snapshot(), state: 'approved' }]);
    await as(workerName, 'SELECT review_builder_authorize($1,$2)', [job.id, auth()]);
    await as(workerName, 'SELECT review_save($1,$2)', [job.id, { snapshot: snapshot('d'.repeat(40)) }]);
    expect((await row(job.id)).merge_authorization).toBeNull();
    await as(workerName, 'SELECT review_save($1,$2)', [job.id, { state: 'deployed', merged, deployed: merged, health: merged }]);
    await expect(as(workerName, 'SELECT review_complete($1)', [job.id])).rejects.toThrow(/no deployment receipt/);
  });
  it('refuses builder authorization once a review verdict exists (no mixing a verdict with a waiver)', async () => {
    await relax(); const { job } = await submit();
    await as(workerName, 'SELECT review_save($1,$2)', [job.id, { snapshot: snapshot(), verdict: { reviewer: 'auditor', decision: 'accept', head, evidence } }]);
    await expect(as(workerName, 'SELECT review_builder_authorize($1,$2)', [job.id, auth()])).rejects.toThrow(/verdict is recorded/);
  });
});

describe('toggling and historical jobs', () => {
  it('relaxing policy never downgrades an active independent submission; the next round gets builder mode', async () => {
    const { card, job } = await submit(); await relax();
    expect((await row(job.id)).mode).toBe('independent');
    expect(await mode(card)).toMatchObject({ mode: 'independent', submission_mode: 'independent', builder_authorized: true });
    await as(workerName, 'SELECT review_save($1,$2)', [job.id, { snapshot: snapshot() }]);
    await expect(as(workerName, 'SELECT review_builder_authorize($1,$2)', [job.id, auth()])).rejects.toThrow(/requires independent review/);
    await as(workerName, 'SELECT review_save($1,$2)', [job.id, { state: 'rejected', snapshot: snapshot(), verdict: { reviewer: 'auditor', decision: 'reject', head, evidence, findings: [{ severity: 'critical', fix: 'Fix it', verification: 'Test it' }] } }]);
    await finishCard('builder', card, { outcome: 'done' });
    const next = (await query('SELECT * FROM review_jobs WHERE card=$1 ORDER BY round DESC LIMIT 1', [card])).rows[0]!;
    expect(next).toMatchObject({ round: 1, mode: 'builder' });
  });
  it.each([
    ['review turned back on', `UPDATE review_policy SET independent_review=true`],
    ['the builder removed from the list', `UPDATE review_policy SET builder_merge_agents='{}'`],
    ['the builder retired', `UPDATE org_agents SET retired_at=now() WHERE name='builder'`],
  ])('tightening (%s) applies at once to an unmerged builder submission and stays tightened', async (_, tighten) => {
    await relax(); const { card, job } = await submit();
    await as(workerName, 'SELECT review_save($1,$2)', [job.id, { snapshot: snapshot(), state: 'approved' }]);
    await as(workerName, 'SELECT review_builder_authorize($1,$2)', [job.id, auth()]);
    await query(tighten);
    expect(await mode(card)).toMatchObject({ mode: 'independent', submission_mode: 'builder', merge_authorized: true });
    // The worker (gate.ts) sees the effective mode before any merge write and moves the job to independent review.
    await as(workerName, 'SELECT review_builder_withdraw($1,$2)', [job.id, 'Owner policy requires independent review']);
    expect(await row(job.id)).toMatchObject({ mode: 'independent', merge_authorization: null });
    expect((await query(`SELECT 1 FROM card_events WHERE card_id=$1 AND kind='review-mode-tightened'`, [card])).rows).toHaveLength(1);
    // Relaxing again does not restore builder mode to this submission.
    await relax();
    expect(await mode(card)).toMatchObject({ mode: 'independent', submission_mode: 'independent' });
    await expect(as(workerName, 'SELECT review_builder_authorize($1,$2)', [job.id, auth()])).rejects.toThrow(/requires independent review/);
  });
  it('withdraw refuses while policy still allows builder merge', async () => {
    await relax(); const { job } = await submit();
    await expect(as(workerName, 'SELECT review_builder_withdraw($1,$2)', [job.id, 'x'])).rejects.toThrow(/still allows/);
  });
  it('a builder merge already recorded keeps its history: mode and authorization are immutable after merge, and it can complete', async () => {
    await relax(); const { card, job } = await submit();
    await as(workerName, 'SELECT review_save($1,$2)', [job.id, { snapshot: snapshot(), state: 'approved' }]);
    await as(workerName, 'SELECT review_builder_authorize($1,$2)', [job.id, auth()]);
    await as(workerName, 'SELECT review_save($1,$2)', [job.id, { state: 'merged', merged }]);
    await query(`UPDATE review_policy SET independent_review=true`);
    await expect(as(workerName, 'SELECT review_builder_withdraw($1,$2)', [job.id, 'x'])).rejects.toThrow(/keeps its history/);
    await expect(query(`UPDATE review_jobs SET mode='independent' WHERE id=$1`, [job.id])).rejects.toThrow(/only tighten/);
    await expect(query(`UPDATE review_jobs SET merge_authorization=NULL WHERE id=$1`, [job.id])).rejects.toThrow(/part of the merge receipt/);
    await as(workerName, 'SELECT review_save($1,$2)', [job.id, { state: 'deployed', deployed: merged, health: merged }]);
    await as(workerName, 'SELECT review_complete($1)', [job.id]);
    expect((await getCard(card)).card.status).toBe('done');
    expect(await row(job.id)).toMatchObject({ mode: 'builder', verdict: null });
  });
  it('historical independent jobs keep completing on their verdict and report review-shipped', async () => {
    const { card, job } = await submit(); await relax();
    await as(workerName, 'SELECT review_save($1,$2)', [job.id, { state: 'deployed', snapshot: snapshot(), merged, deployed: merged, health: merged, verdict: { reviewer: 'auditor', decision: 'accept', head, evidence } }]);
    await as(workerName, 'SELECT review_complete($1)', [job.id]);
    const events = (await query(`SELECT kind,payload FROM card_events WHERE card_id=$1 AND kind IN ('review-shipped','builder-shipped')`, [card])).rows;
    expect(events).toEqual([{ kind: 'review-shipped', payload: expect.objectContaining({ mode: 'independent', independent_review: true }) }]);
  });
  it('a direct done write still cannot bypass the gate in builder mode', async () => {
    await relax(); const { card } = await submit();
    await expect(as('sb_org', "SELECT board_card_move('builder',$1,'done',NULL,NULL,NULL)", [card])).resolves.toBeDefined();
    expect((await getCard(card)).card.status).toBe('review');
  });
});
