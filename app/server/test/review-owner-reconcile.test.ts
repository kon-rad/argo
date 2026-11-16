import pg from 'pg';
import { beforeEach, afterAll, it, expect } from 'vitest';
import { query } from '../src/db.js';
import { importOrg } from '../src/org.js';
import { createCard, finishCard, getCard, moveCard } from '../src/board.js';
import { truncateAll } from './helpers.js';
import type { HostConfig, Repository } from '../src/review/adapters.js';
import { parseOwnerMergeArgs, reconcileOwnerMerge } from '../src/review/reconcile.js';

const workerName = 'sb_review_fixture';
const url = `postgres://${process.env.PGHOST ?? 'localhost'}:${process.env.PGPORT ?? '5432'}/${process.env.SB_TEST_DB ?? 'secondbrain_test'}`;
function asUrl(user: string): string { const u = new URL(url); u.username = user; return u.toString(); }
async function connect(user: string | null, agent?: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: user ? asUrl(user) : url, options: agent ? `-c org.agent=${agent}` : undefined });
  await c.connect(); return c;
}
async function as(user: string, sql: string, params: unknown[] = []): Promise<pg.QueryResult> {
  const c = await connect(user, user === 'sb_org' ? 'builder' : undefined);
  try { return await c.query(sql, params); } finally { await c.end(); }
}

const HEAD = 'a'.repeat(40), MERGE = 'c'.repeat(40), BASE_TIP = 'd'.repeat(40), OTHER = 'e'.repeat(40);
const repo: Repository = { github: 'example/engine', gitDir: '/srv/review/engine.git', base: 'main', target: 'fixture', checks: ['tests'], notes: ['AGENTS.md'] };
const host = { repositories: { engine: repo } } as unknown as HostConfig;

/** A fake GitHub: the PR as GitHub reports it, and the git calls the verifier makes. */
function github(pr: { state?: 'OPEN' | 'MERGED' | 'CLOSED'; merge?: string | null; onBase?: boolean; branch?: string } = {}) {
  const calls: string[][] = [];
  return {
    calls,
    connect: () => ({
      pr: async (card: string, number?: number) => ({
        number: number!, state: pr.state ?? 'MERGED', mergeCommit: pr.merge === null ? null : { oid: pr.merge ?? MERGE },
        headRefOid: HEAD, baseRefOid: BASE_TIP, headRefName: pr.branch ?? `card/${card}-fixture`, baseRefName: 'main',
      }) as never,
      git: async (args: string[]) => {
        calls.push(args);
        if (args[0] === 'ls-remote') return `${BASE_TIP}\trefs/heads/main\n`;
        if (args[0] === 'merge-base' && pr.onBase === false) throw new Error('exit 1');
        return '';
      },
    }),
  };
}

beforeEach(async () => {
  await query(`UPDATE review_policy SET enabled=false,reviewer=NULL,worker_login=NULL`);
  await truncateAll();
  await importOrg({ version: 'review-fixture', company: 'Example', ceo: 'owner', agents: { owner: { runtime: 'human', role: 'Owner' }, builder: { runtime: 'codex', model: 'test-codex', team: 'engineering', reports_to: 'auditor', role: 'Builder', capabilities: ['code'] }, auditor: { runtime: 'codex', model: 'test-codex', team: 'engineering', reports_to: 'owner', role: 'Reviewer', capabilities: ['review'] } }, teams: { engineering: { name: 'Engineering', lead: 'auditor' } }, channels: {} });
  await query(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='sb_review_fixture') THEN CREATE ROLE sb_review_fixture LOGIN; END IF; END $$`);
  if (process.env.PGPASSWORD) await query(`ALTER ROLE sb_review_fixture PASSWORD '${process.env.PGPASSWORD.replace(/'/g, "''")}'`);
  await query(`GRANT sb_review_worker TO sb_review_fixture`);
  await query(`INSERT INTO review_policy(singleton,enabled,shipping_enabled,reviewer,worker_login) VALUES(true,true,true,'auditor',$1) ON CONFLICT(singleton) DO UPDATE SET enabled=true,shipping_enabled=true,boards=NULL,repositories=NULL,max_rounds=2,reviewer='auditor',worker_login=excluded.worker_login`, [workerName]);
});
afterAll(async () => { await query('UPDATE review_policy SET enabled=false,reviewer=NULL,worker_login=NULL'); });

/** A gated card whose PR the owner merged by hand: the worker blocked it exactly as gate.ts does in production. */
async function stuck(snapshot = true) {
  const c = await createCard('owner', { title: 'Owner merged', body: 'Acceptance: tests pass', contract: { objective: 'Fix', verification: 'tests' }, assignee: 'builder', work: 'coding', repo: 'engine' });
  const child = await createCard('owner', { title: 'Waits for the merge', assignee: 'builder', deps: [c.id] });
  await finishCard('builder', c.id, { outcome: 'done' });
  const j = (await query('SELECT * FROM review_jobs WHERE card=$1', [c.id])).rows[0]!;
  await as(workerName, 'SELECT review_save($1,$2)', [j.id, { state: 'blocked', error: 'Unknown prior merge, owner reconciliation required',
    ...(snapshot ? { snapshot: { repo: 'example/engine', pr: 12, head: HEAD, base: 'b'.repeat(40), branch: 'main', merged: MERGE } } : {}) }]);
  expect((await getCard(c.id)).card.status).toBe('blocked');
  expect((await getCard(child.id)).card.status).toBe('todo');
  return { card: c.id, child: child.id, job: Number(j.id) };
}
const request = (card: string, extra: Record<string, unknown> = {}) => ({ card, pr: 12, merge: MERGE, reason: 'Owner merged PR #12 by hand', ...extra });
async function reconcile(input: unknown, gh = github(), user: string | null = null, agent?: string) {
  const client = await connect(user, agent);
  try { return await reconcileOwnerMerge(client, host, input, gh.connect); } finally { await client.end(); }
}
const receipts = async (card: string) => (await query('SELECT * FROM review_owner_merges WHERE card=$1', [card])).rows;

it('reconciles a merged PR to done with an attested receipt, an owner-reconciled event and released dependants', async () => {
  const s = await stuck();
  const gh = github();
  const receipt = await reconcile(request(s.card), gh);
  expect(receipt).toMatchObject({ card: s.card, job: s.job, repo: 'example/engine', pr: 12, merged: MERGE, reason: 'Owner merged PR #12 by hand' });
  expect(receipt.reconciled_by).toBeTruthy();
  expect(gh.calls.map(c => c[0])).toEqual(['ls-remote', 'fetch', 'merge-base']);
  const [row] = await receipts(s.card);
  expect(row.attestation).toMatchObject({ state: 'MERGED', merged: MERGE, head: HEAD, base: 'main', baseTip: BASE_TIP, branch: `card/${s.card}-fixture` });
  const j = (await query('SELECT * FROM review_jobs WHERE id=$1', [s.job])).rows[0]!;
  expect(j).toMatchObject({ state: 'done', merged: MERGE, error: null, verdict: null, deployed: null, health: null });
  const d = await getCard(s.card);
  expect(d.card.status).toBe('done');
  const kinds = (await query('SELECT kind,payload FROM card_events WHERE card_id=$1 ORDER BY id', [s.card])).rows;
  expect(kinds.map(k => k.kind)).toContain('owner-reconciled');
  expect(kinds.map(k => k.kind)).not.toContain('review-shipped');
  expect(kinds.find(k => k.kind === 'owner-reconciled')!.payload).toMatchObject({ pr: 12, merged: MERGE, job: s.job, reason: 'Owner merged PR #12 by hand' });
  expect((await getCard(s.child)).card.status).toBe('ready');
  // Repeating the same reconciliation is a no-op that returns the same receipt.
  expect((await reconcile(request(s.card))).id).toBe(receipt.id);
  expect(await receipts(s.card)).toHaveLength(1);
});

it('refuses an unmerged PR and leaves the card stuck', async () => {
  const s = await stuck();
  await expect(reconcile(request(s.card), github({ state: 'OPEN', merge: null }))).rejects.toThrow(/not merged/);
  expect(await receipts(s.card)).toHaveLength(0);
  expect((await getCard(s.card)).card.status).toBe('blocked');
  expect((await getCard(s.child)).card.status).toBe('todo');
});

it('refuses a merge sha that does not match GitHub, the job, or the protected base', async () => {
  const s = await stuck();
  await expect(reconcile(request(s.card), github({ merge: OTHER }))).rejects.toThrow(new RegExp(`merged as ${OTHER}, not ${MERGE}`));
  await expect(reconcile(request(s.card), github({ onBase: false }))).rejects.toThrow(/not on the protected base main/);
  await expect(reconcile(request(s.card, { pr: 13 }))).rejects.toThrow(/PR #12, not #13/);
  await expect(reconcile(request(s.card, { merge: 'abc123' }))).rejects.toThrow(/40 character/);
  // A job that recorded its own merge only reconciles that merge, even if the caller skips the precheck.
  await query('UPDATE review_jobs SET merged=$2 WHERE id=$1', [s.job, OTHER]);
  await expect(reconcile(request(s.card))).rejects.toThrow(new RegExp(`recorded merge ${OTHER}`));
  await expect(query('SELECT review_owner_reconcile($1,12,$2,$3,$4::jsonb)', [s.card, MERGE, 'Owner merged by hand', JSON.stringify({ state: 'MERGED', merged: MERGE, pr: 12, repo: 'example/engine', head: HEAD })])).rejects.toThrow(/recorded merge/);
  expect(await receipts(s.card)).toHaveLength(0);
  expect((await getCard(s.card)).card.status).toBe('blocked');
});

it('refuses a bot, builder or model caller and a login that is neither owner nor worker', async () => {
  const s = await stuck();
  const args = [s.card, 12, MERGE, 'Owner merged PR #12 by hand', JSON.stringify({ state: 'MERGED', merged: MERGE, pr: 12, repo: 'example/engine', head: HEAD })];
  await expect(as('sb_org', 'SELECT review_owner_reconcile($1,$2,$3,$4,$5::jsonb)', args)).rejects.toThrow(/permission denied/);
  await expect(as('sb_org', 'SELECT review_owner_merge_check($1)', [s.card])).rejects.toThrow(/permission denied/);
  // The owner's own login carrying an org identity is a model door: refused.
  await expect(reconcile(request(s.card), github(), null, 'builder')).rejects.toThrow(/refused for org identity builder/);
  const owner = await connect(null, 'builder');
  try { await expect(owner.query('SELECT review_owner_reconcile($1,$2,$3,$4,$5::jsonb)', args)).rejects.toThrow(/org identity/); } finally { await owner.end(); }
  // A worker-role member that is not the configured worker login is refused too.
  await query('UPDATE review_policy SET worker_login=$1', ['sb_review_other']);
  await expect(as(workerName, 'SELECT review_owner_reconcile($1,$2,$3,$4,$5::jsonb)', args)).rejects.toThrow(/requires the database owner or the review worker login/);
  expect(await receipts(s.card)).toHaveLength(0);
  expect((await getCard(s.card)).card.status).toBe('blocked');
  // The configured worker login is trusted.
  await query('UPDATE review_policy SET worker_login=$1', [workerName]);
  const client = await connect(workerName);
  try { expect((await reconcileOwnerMerge(client, host, request(s.card), github().connect)).reconciled_by).toBe(workerName); } finally { await client.end(); }
  expect((await getCard(s.card)).card.status).toBe('done');
});

it('handles an unassigned running card the gate refused with "original builder required"', async () => {
  const c = await createCard('owner', { title: 'Unassigned', body: 'Acceptance: tests pass', work: 'coding', repo: 'engine' });
  const child = await createCard('owner', { title: 'After it', assignee: 'builder', deps: [c.id] });
  await query(`UPDATE cards SET status='running' WHERE id=$1`, [c.id]);
  await expect(moveCard('owner', c.id, 'done')).rejects.toThrow(/original builder required/);
  const receipt = await reconcile({ card: c.id, pr: 178, merge: MERGE, reason: 'Unassigned card, owner merged #178' });
  expect(receipt).toMatchObject({ card: c.id, job: null, pr: 178 });
  const d = await getCard(c.id);
  expect(d.card).toMatchObject({ status: 'done', assignee: null });
  expect((await query('SELECT * FROM review_jobs WHERE card=$1', [c.id])).rows).toHaveLength(0);
  expect((await getCard(child.id)).card.status).toBe('ready');
});

it('refuses a card with no gate job problem, and the receipt does not let a later finish skip review', async () => {
  const plain = await createCard('owner', { title: 'Writing', assignee: 'builder', work: 'writing' });
  await expect(reconcile(request(plain.id))).rejects.toThrow(/has no review gate/);
  const s = await stuck(false);
  await reconcile(request(s.card));
  await expect(reconcile(request(s.card, { merge: OTHER }))).rejects.toThrow(/already done; nothing to reconcile/);
  // Reopened and finished again: the receipt was for one transaction, so the gate treats it like any closed job.
  await moveCard('owner', s.card, 'ready');
  await expect(finishCard('builder', s.card, { outcome: 'done' })).rejects.toThrow(/only worker finalizes shipping/);
  expect((await getCard(s.card)).card.status).toBe('ready');
});

it('refuses while the review worker holds the job', async () => {
  const s = await stuck();
  const worker = await connect(workerName);
  try {
    await worker.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [`review-job:${s.job}`]);
    await expect(reconcile(request(s.card))).rejects.toThrow(/worker is processing job/);
  } finally { await worker.end(); }
  expect((await getCard(s.card)).card.status).toBe('blocked');
});

it('parses the command line', () => {
  expect(parseOwnerMergeArgs(['t_70c44306', '--pr', '165', '--merge', MERGE, '--reason', 'Owner merged by hand'])).toEqual({ card: 't_70c44306', pr: 165, merge: MERGE, reason: 'Owner merged by hand' });
  expect(() => parseOwnerMergeArgs(['t_70c44306', '--pr', '165', '--merge', MERGE])).toThrow(/reason/);
  expect(() => parseOwnerMergeArgs(['t_70c44306', '--force', 'x'])).toThrow(/Unexpected argument/);
});
