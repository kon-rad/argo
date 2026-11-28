import pg from 'pg';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { query } from '../src/db.js';
import { createCard, finishCard, getCard, moveCard } from '../src/board.js';
import { importOrg } from '../src/org.js';
import { truncateAll } from './helpers.js';

const worker = 'sb_review_fixture';
const url = `postgres://${process.env.PGHOST ?? 'localhost'}:${process.env.PGPORT ?? '5432'}/${process.env.SB_TEST_DB ?? 'secondbrain_test'}`;
async function connection(user?: string, agent?: string): Promise<pg.Client> {
  const u = new URL(url);
  if (user) u.username = user;
  const client = new pg.Client({ connectionString: u.toString(), options: agent ? `-c org.agent=${agent}` : undefined });
  await client.connect();
  return client;
}
beforeEach(async () => {
  await query('UPDATE review_policy SET enabled=false,reviewer=NULL,worker_login=NULL');
  await truncateAll();
  await importOrg({ version: 'review-fixture', company: 'Example', ceo: 'owner', agents: {
    owner: { runtime: 'human', role: 'Owner' },
    builder: { runtime: 'codex', model: 'test-codex', team: 'engineering', reports_to: 'auditor', role: 'Builder', capabilities: ['code'] },
    auditor: { runtime: 'codex', model: 'test-codex', team: 'engineering', reports_to: 'owner', role: 'Reviewer', capabilities: ['review'] },
  }, teams: { engineering: { name: 'Engineering', lead: 'auditor' } }, channels: {} });
  await query(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='sb_review_fixture') THEN CREATE ROLE sb_review_fixture LOGIN; END IF; END $$`);
  if (process.env.PGPASSWORD) await query(`ALTER ROLE sb_review_fixture PASSWORD '${process.env.PGPASSWORD.replace(/'/g, "''")}'`);
  await query('GRANT sb_review_worker TO sb_review_fixture');
  await query(`INSERT INTO review_policy(singleton,enabled,shipping_enabled,reviewer,worker_login)
    VALUES(true,true,true,'auditor',$1) ON CONFLICT(singleton) DO UPDATE SET
    enabled=true,shipping_enabled=true,boards=NULL,repositories=NULL,reviewer='auditor',worker_login=excluded.worker_login`, [worker]);
});
afterAll(async () => { await query('UPDATE review_policy SET enabled=false,reviewer=NULL,worker_login=NULL'); });

const repo = 'example/engine';
const pr = 12;
const link = 'https://github.com/example/engine/pull/12';
const sha = 'b'.repeat(40);
const reason = 'Historical change tracked in a shared pull request';
const statement = 'SELECT * FROM review_owner_history_archive($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)';
const cutoff = async (): Promise<string> => (await query('SELECT clock_timestamp()::text AS time')).rows[0]!.time;

async function fixture(author = 'owner', comment = 'Change record: (' + link + ')') {
  const card = await createCard('owner', { title: 'Historical implementation', assignee: 'builder', work: 'coding',
    repo: 'retired-alias', body: 'Acceptance: tests pass', contract: { objective: 'Fix behavior', verification: 'tests' } });
  const child = await createCard('owner', { title: 'Dependent work', assignee: 'builder', deps: [card.id] });
  await finishCard('builder', card.id, { outcome: 'done' });
  const job: number = (await query('SELECT id FROM review_jobs WHERE card=$1', [card.id])).rows[0]!.id;
  await query('INSERT INTO card_comments(card_id,author,body) VALUES($1,$2,$3)', [card.id, author, comment]);
  // The historical builder already consumed the dispatch associated with the original assignment.
  await query("UPDATE org_wakeups SET done_at=now() WHERE reason='task' AND ref=$1", [card.id]);
  await retry(job);
  return { card: card.id, child: child.id, job, staleBefore: await cutoff() };
}
async function retry(job: number) {
  const service = await connection(worker);
  try {
    await service.query('SELECT review_save($1,$2)', [job, { state: 'blocked', error: 'Unknown or ambiguous PR' }]);
  } finally { await service.end(); }
}

type Sample = Awaited<ReturnType<typeof fixture>>;
type Outcome = 'merged' | 'closed-unmerged';
function params(s: Sample, outcome: Outcome = 'merged') {
  const merged = outcome === 'merged' ? sha : null;
  return [s.card, s.job, 'engine', pr, outcome, merged, s.staleBefore, reason, {
    repoKey: 'engine', repo, pr, url: link, state: merged ? 'MERGED' : 'CLOSED', merged,
    head: 'a'.repeat(40), base: 'main', baseTip: merged ? 'c'.repeat(40) : null,
    branch: 'feat/shared', checkedAt: new Date().toISOString(),
  }] as const;
}
async function archive(s: Sample, outcome: Outcome = 'merged') {
  return (await query(statement, params(s, outcome))).rows[0]!;
}
const receipts = async (s: Sample) => (await query('SELECT * FROM review_owner_history_archives WHERE card=$1', [s.card])).rows;
const events = async (s: Sample) => (await query("SELECT payload FROM card_events WHERE card_id=$1 AND kind='owner-history-archived'", [s.card])).rows;
async function unchanged(s: Sample) {
  expect(await receipts(s)).toEqual([]);
  expect(await events(s)).toEqual([]);
  expect((await getCard(s.card)).card.status).toBe('blocked');
  expect((await getCard(s.child)).card.status).toBe('todo');
}

it.each(['merged', 'closed-unmerged'] as const)('records a %s fact and archives only the historical card', async outcome => {
  const s = await fixture();
  await retry(s.job); // A worker-only retry after the cutoff must not refresh meaningful activity.
  const r = await archive(s, outcome);
  const merged = outcome === 'merged';
  expect(r).toMatchObject({ card: s.card, job: s.job, repo_key: 'engine', repo, pr, outcome, reason,
    merge_sha: merged ? sha : null, reviewed: false, merged, deployed: false });
  expect(r.archived_by).toBeTruthy();
  expect((await getCard(s.card)).card.status).toBe('archived');
  // A later scheduler pass must also leave the dependency unresolved.
  expect((await query('SELECT board_promote($1) AS promoted', [s.child])).rows[0]!.promoted).toBe(false);
  expect((await getCard(s.child)).card.status).toBe('todo');
  expect((await query('SELECT * FROM review_jobs WHERE id=$1', [s.job])).rows[0])
    .toMatchObject({ state: 'historical-archived', verdict: null, health: null, deployed: null });
  expect(await events(s)).toMatchObject([{ payload: { receipt: r.id, job: s.job, reviewed: false, merged, deployed: false } }]);
  expect((await archive(s, outcome)).id).toBe(r.id);
  expect(await receipts(s)).toHaveLength(1);
  expect(await events(s)).toHaveLength(1);
  await expect(query('UPDATE review_owner_history_archives SET reason=$2 WHERE id=$1', [r.id, 'Edited history'])).rejects.toThrow(/immutable/);
  await expect(query('DELETE FROM review_owner_history_archives WHERE id=$1', [r.id])).rejects.toThrow(/immutable/);
  await expect(query("UPDATE review_jobs SET state='blocked' WHERE id=$1", [s.job])).rejects.toThrow();
  // Even a worker that selected the job before archival cannot revive it.
  await retry(s.job).catch(() => {});
  expect((await query('SELECT state FROM review_jobs WHERE id=$1', [s.job])).rows[0]!.state).toBe('historical-archived');
  expect((await getCard(s.card)).card.status).toBe('archived');
  await expect(archive({ ...s, staleBefore: await cutoff() }, outcome)).rejects.toThrow();
  const conflict = [...params(s, outcome)];
  conflict[7] = 'A materially different reason';
  await expect(query(statement, conflict)).rejects.toThrow();
});

it('requires an exact human link per card sharing the same PR', async () => {
  const a = await fixture();
  const b = await fixture('builder');
  await archive(a);
  await expect(archive(b)).rejects.toThrow();
  await unchanged(b);
  await query('INSERT INTO card_comments(card_id,author,body) VALUES($1,$2,$3)', [b.card, 'owner', link]);
  await archive({ ...b, staleBefore: await cutoff() });
  expect(await receipts(a)).toHaveLength(1);
  expect(await receipts(b)).toHaveLength(1);
});
it.each([link + '3', link + '/files', link.replace('/engine/', '/another/'),
  'https://example.com/redirect?url=' + link])('refuses noncanonical human evidence %s', async body => {
  const s = await fixture('owner', body);
  await expect(archive(s)).rejects.toThrow();
  await unchanged(s);
});

it('rejects ordinary board archival and preserves the two existing owner transitions', async () => {
  const s = await fixture('owner', 'Cancelled by owner: ' + link);
  await expect(query('SELECT review_owner_supersede($1,$2,$3)', [s.card, s.child, reason])).rejects.toThrow(/references a PR/);
  await expect(query('SELECT review_owner_merge_check($1)', [s.card])).rejects.toThrow(/no owner-merge problem/);
  await unchanged(s);
  await moveCard('owner', s.card, 'archived');
  expect((await getCard(s.card)).card.status).toBe('review');
  expect(await receipts(s)).toEqual([]);
});

it('rejects database service logins and tagged owner connections', async () => {
  const s = await fixture();
  for (const [login, agent] of [[worker], ['sb_org', 'builder'], [undefined, 'builder']]) {
    const client = await connection(login, agent);
    try { await expect(client.query(statement, [...params(s)])).rejects.toThrow(/permission denied|org identity/); }
    finally { await client.end(); }
  }
  await unchanged(s);
});

it.each(['job','content'])('refuses a worker-held %s lock', async kind => {
  const s = await fixture();
  const client = await connection(worker);
  try {
    const key = kind === 'job' ? 'review-job:' + s.job : 'review-content:' + s.card;
    await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [key]);
    await expect(archive(s)).rejects.toThrow();
  } finally { await client.end(); }
  await unchanged(s);
});

it.each(['queued','reviewing','approved','merging','merged','deploying','deployed','rejected','done'])('refuses a %s job', async state => {
  const s = await fixture();
  await query('UPDATE review_jobs SET state=$2 WHERE id=$1', [s.job, state]);
  await expect(archive(s)).rejects.toThrow();
  await unchanged(s);
});

it('refuses a mismatched job and future stale cutoff', async () => {
  const s = await fixture();
  await expect(archive({ ...s, job: s.job + 1 })).rejects.toThrow();
  await expect(archive({ ...s, staleBefore: new Date(Date.now() + 86400000).toISOString() })).rejects.toThrow();
  await unchanged(s);
});

const insertLaunch = `INSERT INTO review_launches(card,builder,persona,runtime,model,host,repo,branch,
  worktree,common_dir,original_run_id,registered_by) VALUES($1,'builder','builder','codex','fixture',
  'fixture','engine','feat/shared','/tmp/worktree','/tmp/repo','fixture-run','fixture')`;
async function insertCorrection(s: Sample, state: string) {
  await query(insertLaunch, [s.card]);
  const hash = 'e'.repeat(64);
  await query(`INSERT INTO review_feedback(id,job,card,repo,pr,base,head,evidence_hash,finding_hash,code,
    severity,reason,evidence,required_fix,verification,producer_kind,producer)
    VALUES($1,$2,$3,$4,$5,$6,$6,$1,$1,'issue','low','reason','evidence','fix','tests','reviewer','auditor')`,
  [hash, s.job, s.card, repo, pr, sha]);
  await query(`INSERT INTO review_corrections(feedback_id,card,launch_card,head,base,pr,evidence_hash,state)
    VALUES($1,$2,$2,$3,$3,$4,$1,$5)`, [hash, s.card, sha, pr, state]);
}

it.each(['queued','claimed','starting','running','retry'])('refuses a %s correction even before the cutoff', async state => {
  const s = await fixture();
  await insertCorrection(s, state);
  await expect(archive({ ...s, staleBefore: await cutoff() })).rejects.toThrow();
  await unchanged(s);
});

it.each([
  ['card edit', "UPDATE cards SET title='Updated scope' WHERE id=$1"],
  ['comment exactly at the cutoff', "INSERT INTO card_comments(card_id,author,body,created_at) VALUES($1,'owner','Still working',$2)"],
  ['board event', "INSERT INTO card_events(card_id,kind,actor) VALUES($1,'edited','owner')"],
  ['finished builder run', "INSERT INTO card_runs(card_id,agent_name,runtime,lease_until,finished_at,outcome) VALUES($1,'builder','codex',now(),now(),'partial')"],
  ['builder launch', insertLaunch],
])('refuses a recent %s after a worker retry', async (_kind, sql) => {
  const s = await fixture();
  await query(sql, sql.includes('$2') ? [s.card, s.staleBefore] : [s.card]);
  await retry(s.job);
  await expect(archive(s)).rejects.toThrow();
  await unchanged(s);
});

it('treats an inactive correction update after the cutoff as meaningful activity', async () => {
  const s = await fixture();
  await insertCorrection(s, 'blocked');
  s.staleBefore = await cutoff();
  await query("UPDATE review_corrections SET state='cancelled',updated_at=now() WHERE card=$1", [s.card]);
  await retry(s.job);
  await expect(archive(s)).rejects.toThrow();
  await unchanged(s);
});

it.each([
  ['queued dispatch', "INSERT INTO org_wakeups(agent_name,reason,ref) VALUES('builder','task',$1)"],
  ['unfinished builder run', "INSERT INTO card_runs(card_id,agent_name,runtime,lease_until) VALUES($1,'builder','codex',now()-interval '1 hour')"],
])('refuses an old %s', async (_kind, sql) => {
  const s = await fixture();
  await query(sql, [s.card]);
  await expect(archive({ ...s, staleBefore: await cutoff() })).rejects.toThrow();
  await unchanged(s);
});

it('rolls back the receipt, event and terminal state together on an interrupted transaction', async () => {
  const s = await fixture();
  const client = await connection();
  try {
    await client.query('BEGIN');
    const result = await client.query(statement, [...params(s)]);
    expect(result.rows[0]).toMatchObject({ card: s.card, job: s.job });
    await client.query('ROLLBACK');
  } finally { await client.end(); }
  await unchanged(s);
  expect((await query('SELECT state FROM review_jobs WHERE id=$1', [s.job])).rows[0]!.state).toBe('blocked');
  await archive(s);
});

it('keeps its receipt bound to the archived round when reopened', async () => {
  const s = await fixture();
  await archive(s);
  await query("UPDATE cards SET status='ready' WHERE id=$1", [s.card]);
  await query("UPDATE cards SET status='review' WHERE id=$1", [s.card]);
  expect((await query('SELECT round,state FROM review_jobs WHERE card=$1 ORDER BY round', [s.card])).rows)
    .toEqual([{ round: 0, state: 'historical-archived' }, { round: 1, state: 'queued' }]);
  await expect(archive(s)).rejects.toThrow();
  expect(await receipts(s)).toHaveLength(1);
});

it.each([
  ['merged', 'OPEN', null], ['merged', 'CLOSED', null],
  ['closed-unmerged', 'MERGED', sha], ['closed-unmerged', 'CLOSED', sha],
] as const)('refuses %s receipt for incompatible %s facts (%s)', async (outcome, state, merged) => {
  const s = await fixture();
  const request = params(s, outcome);
  const args = [...request.slice(0, 8), { ...request[8], state, merged }];
  await expect(query(statement, args)).rejects.toThrow();
  await unchanged(s);
});

it('cancels an old inactive correction when archiving', async () => {
  const s = await fixture();
  await insertCorrection(s, 'blocked');
  await archive({ ...s, staleBefore: await cutoff() });
  expect((await query('SELECT state FROM review_corrections WHERE card=$1', [s.card])).rows)
    .toEqual([{ state: 'cancelled' }]);
});

it('preserves an ambiguous blocked correction that carries process evidence', async () => {
  const s = await fixture();
  await insertCorrection(s, 'blocked');
  await query("UPDATE review_corrections SET process_id='fixture-process' WHERE card=$1", [s.card]);
  await expect(archive({ ...s, staleBefore: await cutoff() })).rejects.toThrow(/correction/);
  expect((await query('SELECT state,process_id FROM review_corrections WHERE card=$1', [s.card])).rows)
    .toEqual([{ state: 'blocked', process_id: 'fixture-process' }]);
  await unchanged(s);
});

it('allows metadata edits on an archived card without resubmitting it', async () => {
  const s = await fixture();
  await archive(s);
  await query("UPDATE cards SET title='Revised historical title' WHERE id=$1", [s.card]);
  expect((await getCard(s.card)).card).toMatchObject({ title: 'Revised historical title', status: 'archived' });
  expect((await query('SELECT id,state FROM review_jobs WHERE card=$1', [s.card])).rows)
    .toEqual([{ id: s.job, state: 'historical-archived' }]);
  await expect(moveCard('owner', s.card, 'done')).rejects.toThrow();
});

it('refuses a closed-unmerged archive when the job snapshot already records a merge', async () => {
  const s = await fixture();
  await query('UPDATE review_jobs SET snapshot=$2 WHERE id=$1', [s.job, { repo, pr, merged: sha }]);
  await expect(archive(s, 'closed-unmerged')).rejects.toThrow(/conflicts/);
  await unchanged(s);
});
