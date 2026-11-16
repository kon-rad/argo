import pg from 'pg';
import { beforeEach, afterAll, it, expect } from 'vitest';
import { query } from '../src/db.js';
import { importOrg } from '../src/org.js';
import { createCard, finishCard, getCard, moveCard } from '../src/board.js';
import { truncateAll } from './helpers.js';
import { GitHub, type HostConfig, type Repository } from '../src/review/adapters.js';
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
const host = { repositories: { engine: repo }, home: '/tmp', gh: '/usr/bin/false', git: '/usr/bin/false' } as unknown as HostConfig;
const OWNER_MERGE = 'Unknown prior merge, owner reconciliation required';
const NO_REVIEW = 'Merged revision has no accepted review; reconciliation required';
const fabricated = () => JSON.stringify({ state: 'MERGED', merged: MERGE, pr: 12, repo: 'example/engine', head: HEAD });

type Facts = { state?: 'OPEN' | 'MERGED' | 'CLOSED'; merge?: string | null; onBase?: boolean; branch?: string; base?: string; crossRepository?: boolean };
/**
 * The production GitHub adapter with only its two process doors stubbed: `gh` answers `pr view` as GitHub would,
 * `git` answers the base-tip and ancestry checks. Repository, base, cross-repository and branch-to-card checks are
 * the real `GitHub.pr`.
 */
function github(facts: Facts = {}) {
  const gh: string[][] = [], calls: string[][] = [];
  return {
    gh, calls,
    connect: (r: Repository) => {
      const g = new GitHub(host, r);
      g.gh = async args => {
        gh.push(args);
        if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({
          number: Number(args[2]), body: '', headRefOid: HEAD, baseRefOid: BASE_TIP, baseRefName: facts.base ?? 'main',
          headRefName: facts.branch ?? 'card/' + current.card + '-fixture', isCrossRepository: facts.crossRepository ?? false, isDraft: false,
          mergeStateStatus: 'UNKNOWN', mergeable: 'UNKNOWN', reviewDecision: null, state: facts.state ?? 'MERGED',
          mergeCommit: facts.merge === null ? null : { oid: facts.merge ?? MERGE }, statusCheckRollup: [],
        });
        throw new Error('Unexpected GitHub call: ' + args.join(' '));
      };
      g.git = async args => {
        calls.push(args);
        if (args[0] === 'ls-remote') return BASE_TIP + '\trefs/heads/main\n';
        if (args[0] === 'merge-base' && facts.onBase === false) throw new Error('exit 1');
        return '';
      };
      return g;
    },
  };
}
/** The card the fake GitHub's default branch names. */
const current = { card: '' };

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

/** A gated card submitted for review: its job is queued, exactly as finishCard leaves it. */
async function submitted() {
  const c = await createCard('owner', { title: 'Owner merged', body: 'Acceptance: tests pass', contract: { objective: 'Fix', verification: 'tests' }, assignee: 'builder', work: 'coding', repo: 'engine' });
  current.card = c.id;
  const child = await createCard('owner', { title: 'Waits for the merge', assignee: 'builder', deps: [c.id] });
  await finishCard('builder', c.id, { outcome: 'done' });
  const j = (await query('SELECT * FROM review_jobs WHERE card=$1', [c.id])).rows[0]!;
  return { card: c.id, child: child.id, job: Number(j.id) };
}
/** A card whose PR the owner merged by hand, blocked by the worker exactly as runReview's catch block leaves it. */
async function stuck(opts: { snapshot?: boolean; error?: string } = {}) {
  const s = await submitted();
  await as(workerName, 'SELECT review_save($1,$2)', [s.job, { state: 'blocked', error: opts.error ?? OWNER_MERGE, merged: MERGE,
    ...(opts.snapshot !== false ? { snapshot: { repo: 'example/engine', pr: 12, head: HEAD, base: 'b'.repeat(40), branch: 'main', merged: MERGE } } : {}) }]);
  expect((await getCard(s.card)).card.status).toBe('blocked');
  expect((await getCard(s.child)).card.status).toBe('todo');
  return s;
}
const request = (card: string, extra: Record<string, unknown> = {}) => ({ card, pr: 12, merge: MERGE, reason: 'Owner merged PR #12 by hand', ...extra });
async function reconcile(input: unknown, gh = github(), user: string | null = null, agent?: string) {
  const client = await connect(user, agent);
  try { return await reconcileOwnerMerge(client, host, input, gh.connect); } finally { await client.end(); }
}
const receipts = async (card: string) => (await query('SELECT * FROM review_owner_merges WHERE card=$1', [card])).rows;
async function unchanged(s: { card: string; child: string }, status = 'blocked') {
  expect(await receipts(s.card)).toHaveLength(0);
  expect((await getCard(s.card)).card.status).toBe(status);
  expect((await getCard(s.child)).card.status).toBe('todo');
}

it.each([OWNER_MERGE, NO_REVIEW])('reconciles a merged PR blocked with "%s" to done with a receipt, an owner-reconciled event and released dependants', async error => {
  const s = await stuck({ error });
  const gh = github();
  const receipt = await reconcile(request(s.card), gh);
  expect(receipt).toMatchObject({ card: s.card, job: s.job, repo: 'example/engine', pr: 12, merged: MERGE, reason: 'Owner merged PR #12 by hand' });
  expect(receipt.reconciled_by).toBeTruthy();
  // The PR is read from the registered repository, never from anything the caller passes.
  expect(gh.gh).toEqual([expect.arrayContaining(['pr', 'view', '12', '--repo', 'example/engine'])]);
  expect(gh.calls.map(c => c[0])).toEqual(['ls-remote', 'fetch', 'merge-base']);
  const [row] = await receipts(s.card);
  expect(row.attestation).toMatchObject({ state: 'MERGED', merged: MERGE, head: HEAD, base: 'main', baseTip: BASE_TIP, branch: `card/${s.card}-fixture` });
  const j = (await query('SELECT * FROM review_jobs WHERE id=$1', [s.job])).rows[0]!;
  expect(j).toMatchObject({ state: 'done', merged: MERGE, error: null, verdict: null, deployed: null, health: null });
  expect((await getCard(s.card)).card.status).toBe('done');
  const kinds = (await query('SELECT kind,payload FROM card_events WHERE card_id=$1 ORDER BY id', [s.card])).rows;
  expect(kinds.map(k => k.kind)).toContain('owner-reconciled');
  expect(kinds.map(k => k.kind)).not.toContain('review-shipped');
  expect(kinds.find(k => k.kind === 'owner-reconciled')!.payload).toMatchObject({ pr: 12, merged: MERGE, job: s.job, reason: 'Owner merged PR #12 by hand' });
  expect((await getCard(s.child)).card.status).toBe('ready');
  // Repeating the same reconciliation is a no-op that returns the same receipt.
  expect((await reconcile(request(s.card))).id).toBe(receipt.id);
  expect(await receipts(s.card)).toHaveLength(1);
});

it('refuses an unmerged or closed PR and leaves the card stuck', async () => {
  const s = await stuck();
  await expect(reconcile(request(s.card), github({ state: 'OPEN', merge: null }))).rejects.toThrow(/not merged/);
  await expect(reconcile(request(s.card), github({ state: 'CLOSED', merge: null }))).rejects.toThrow(/closed, unrelated or targets an unregistered base/);
  await unchanged(s);
});

it.each([
  ['an unrelated branch', { branch: 'card/t_0ther99-fixture' }],
  ['a branch that does not name the card', { branch: 'feat/fixture' }],
  ['another base', { base: 'release' }],
  ['another repository (cross-repository PR)', { crossRepository: true }],
] as const)('refuses a PR from %s through the real GitHub.pr validation', async (_label, facts) => {
  const s = await stuck();
  await expect(reconcile(request(s.card), github(facts))).rejects.toThrow(/closed, unrelated or targets an unregistered base/);
  await unchanged(s);
});

it('refuses a card whose repository is not registered in the host policy', async () => {
  const s = await stuck();
  const client = await connect(null);
  try {
    await expect(reconcileOwnerMerge(client, { ...host, repositories: { other: { ...repo, github: 'example/other' } } } as HostConfig, request(s.card), github().connect))
      .rejects.toThrow(/no repository registered/);
  } finally { await client.end(); }
  await unchanged(s);
});

it('refuses a merge sha that does not match GitHub, the job, or the protected base', async () => {
  const s = await stuck();
  await expect(reconcile(request(s.card), github({ merge: OTHER }))).rejects.toThrow(new RegExp(`merged as ${OTHER}, not ${MERGE}`));
  await expect(reconcile(request(s.card), github({ onBase: false }))).rejects.toThrow(/not on the protected base main/);
  await expect(reconcile(request(s.card, { pr: 13 }))).rejects.toThrow(/PR #12, not #13/);
  await expect(reconcile(request(s.card, { merge: 'abc123' }))).rejects.toThrow(/40 character/);
  // The worker recorded the merge it saw; only that merge reconciles, even if the caller skips the precheck.
  await expect(reconcile(request(s.card, { merge: OTHER }), github({ merge: OTHER }))).rejects.toThrow(new RegExp(`recorded merge ${MERGE}`));
  await expect(query('SELECT review_owner_reconcile($1,12,$2,$3,$4::jsonb)', [s.card, OTHER, 'Owner merged by hand', JSON.stringify({ state: 'MERGED', merged: OTHER, pr: 12, repo: 'example/engine', head: HEAD })])).rejects.toThrow(/recorded merge/);
  await unchanged(s);
});

it('refuses a bot, builder, model or worker caller, even with a fabricated attestation', async () => {
  const s = await stuck();
  const args = [s.card, 12, MERGE, 'Owner merged PR #12 by hand', JSON.stringify({ state: 'MERGED', merged: MERGE, pr: 12, repo: 'example/engine', head: HEAD })];
  await expect(as('sb_org', 'SELECT review_owner_reconcile($1,$2,$3,$4,$5::jsonb)', args)).rejects.toThrow(/permission denied/);
  await expect(as('sb_org', 'SELECT review_owner_merge_check($1)', [s.card])).rejects.toThrow(/permission denied/);
  // The owner's own login carrying an org identity is a model door: refused.
  await expect(reconcile(request(s.card), github(), null, 'builder')).rejects.toThrow(/refused for org identity builder/);
  const owner = await connect(null, 'builder');
  try { await expect(owner.query('SELECT review_owner_reconcile($1,$2,$3,$4,$5::jsonb)', args)).rejects.toThrow(/org identity/); } finally { await owner.end(); }
  // The configured worker login cannot skip the GitHub check by calling the SQL write path with made-up facts.
  await expect(as(workerName, 'SELECT review_owner_reconcile($1,$2,$3,$4,$5::jsonb)', args)).rejects.toThrow(/permission denied/);
  await expect(as(workerName, 'SELECT review_owner_merge_check($1)', [s.card])).rejects.toThrow(/permission denied/);
  const worker = await connect(workerName);
  try { await expect(reconcileOwnerMerge(worker, host, request(s.card), github().connect)).rejects.toThrow(/permission denied/); } finally { await worker.end(); }
  await unchanged(s);
});

it('refuses ordinary review work that has no owner-merge problem', async () => {
  // Queued: submitted and waiting for the worker.
  const queued = await submitted();
  await expect(reconcile(request(queued.card))).rejects.toThrow(/is queued \(no error\); no owner-merge problem/);
  await expect(query('SELECT review_owner_reconcile($1,12,$2,$3,$4::jsonb)', [queued.card, MERGE, 'Owner merged by hand', fabricated()])).rejects.toThrow(/no owner-merge problem/);
  await unchanged(queued, 'review');
  // Rejected: the reviewer asked for changes.
  const rejected = await submitted();
  await query(`UPDATE review_jobs SET state='rejected' WHERE id=$1`, [rejected.job]);
  await expect(reconcile(request(rejected.card))).rejects.toThrow(/is rejected .*no owner-merge problem/);
  expect(await receipts(rejected.card)).toHaveLength(0);
  expect((await getCard(rejected.child)).card.status).toBe('todo');
  // Blocked for another reason, even with a merge recorded.
  const other = await stuck({ error: 'Approval evidence changed after merge; deployment blocked' });
  await expect(reconcile(request(other.card))).rejects.toThrow(/is blocked \(Approval evidence changed after merge; deployment blocked\); no owner-merge problem/);
  await unchanged(other);
  // An assigned gated card with no job yet: submit it for review instead.
  const assigned = await createCard('owner', { title: 'Assigned', body: 'Acceptance: tests pass', assignee: 'builder', work: 'coding', repo: 'engine' });
  await expect(reconcile(request(assigned.id))).rejects.toThrow(/has no review job and is assigned to builder/);
});

it('handles an unassigned running card the gate refused with "original builder required"', async () => {
  const c = await createCard('owner', { title: 'Unassigned', body: 'Acceptance: tests pass', work: 'coding', repo: 'engine' });
  current.card = c.id;
  const child = await createCard('owner', { title: 'After it', assignee: 'builder', deps: [c.id] });
  await query(`UPDATE cards SET status='running' WHERE id=$1`, [c.id]);
  await expect(moveCard('owner', c.id, 'done')).rejects.toThrow(/original builder required/);
  const receipt = await reconcile({ card: c.id, pr: 178, merge: MERGE, reason: 'Unassigned card, owner merged #178' });
  expect(receipt).toMatchObject({ card: c.id, job: null, pr: 178 });
  expect((await getCard(c.id)).card).toMatchObject({ status: 'done', assignee: null });
  expect((await query('SELECT * FROM review_jobs WHERE card=$1', [c.id])).rows).toHaveLength(0);
  expect((await query(`SELECT payload FROM card_events WHERE card_id=$1 AND kind='owner-reconciled'`, [c.id])).rows[0]!.payload).toMatchObject({ job: null, pr: 178, assignee: null });
  expect((await getCard(child.id)).card.status).toBe('ready');
});

it('refuses a card with no gate, an already done card, and does not let a later finish skip review', async () => {
  const plain = await createCard('owner', { title: 'Writing', assignee: 'builder', work: 'writing' });
  await expect(reconcile(request(plain.id))).rejects.toThrow(/has no review gate/);
  const s = await stuck({ snapshot: false });
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
  await unchanged(s);
});

it('parses the command line', () => {
  expect(parseOwnerMergeArgs(['t_70c44306', '--pr', '165', '--merge', MERGE, '--reason', 'Owner merged by hand'])).toEqual({ card: 't_70c44306', pr: 165, merge: MERGE, reason: 'Owner merged by hand' });
  expect(() => parseOwnerMergeArgs(['t_70c44306', '--pr', '165', '--merge', MERGE])).toThrow(/reason/);
  expect(() => parseOwnerMergeArgs(['t_70c44306', '--force', 'x'])).toThrow(/Unexpected argument/);
});
