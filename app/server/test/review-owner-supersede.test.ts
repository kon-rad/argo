import pg from 'pg';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { query } from '../src/db.js';
import { createCard, finishCard, getCard } from '../src/board.js';
import { importOrg } from '../src/org.js';
import { truncateAll } from './helpers.js';
import { parseOwnerSupersedeArgs, supersedeOwner } from '../src/review/supersede.js';

const worker = 'sb_review_fixture';
const url = `postgres://${process.env.PGHOST ?? 'localhost'}:${process.env.PGPORT ?? '5432'}/${process.env.SB_TEST_DB ?? 'secondbrain_test'}`;
async function connection(user?: string, agent?: string): Promise<pg.Client> {
  const u = new URL(url);
  if (user) u.username = user;
  const client = new pg.Client({ connectionString: u.toString(), options: agent ? `-c org.agent=${agent}` : undefined });
  await client.connect();
  return client;
}
async function submit() {
  const card = await createCard('owner', { title: 'Cancelled code', body: 'Acceptance: tests pass',
    contract: { objective: 'Build feature', verification: 'tests' }, assignee: 'builder', work: 'coding', repo: 'engine' });
  const successor = await createCard('owner', { title: 'Replacement', assignee: 'builder' });
  await finishCard('builder', card.id, { outcome: 'done' });
  const job = (await query('SELECT id FROM review_jobs WHERE card=$1', [card.id])).rows[0]!.id as number;
  await query('INSERT INTO card_comments(card_id,author,body) VALUES($1,$2,$3)',
    [card.id, 'owner', 'Superseded before work started. No code or PR. Use the replacement card.']);
  const service = await connection(worker);
  try { await service.query('SELECT review_save($1,$2)', [job, { state: 'blocked', error: 'Unknown or ambiguous PR' }]); }
  finally { await service.end(); }
  return { card: card.id, successor: successor.id, job };
}
async function supersede(card: string, successor: string, reason = 'Owner cancelled unbuilt work') {
  const client = await connection();
  try { return await supersedeOwner(client, { card, successor, reason }); }
  finally { await client.end(); }
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

it('archives a cancelled no-PR job with a distinct immutable receipt and no shipping claim', async () => {
  const s = await submit();
  const receipt = await supersede(s.card, s.successor);
  expect(receipt).toMatchObject({ card: s.card, job: s.job, successor: s.successor, reason: 'Owner cancelled unbuilt work' });
  expect(receipt.superseded_by).toBeTruthy();
  expect((await getCard(s.card)).card.status).toBe('archived');
  expect((await query('SELECT state,verdict,merged,deployed,health FROM review_jobs WHERE id=$1', [s.job])).rows[0])
    .toMatchObject({ state: 'superseded', verdict: null, merged: null, deployed: null, health: null });
  expect((await query(`SELECT kind,payload FROM card_events WHERE card_id=$1 AND kind='owner-superseded'`, [s.card])).rows[0]!.payload)
    .toMatchObject({ successor: s.successor, reviewed: false, merged: false, deployed: false });
  expect((await query('SELECT count(*)::integer AS count FROM review_owner_merges WHERE card=$1', [s.card])).rows[0]!.count).toBe(0);
  expect((await supersede(s.card, s.successor)).id).toBe(receipt.id);
  await expect(query('UPDATE review_owner_supersedes SET reason=$2 WHERE id=$1', [receipt.id, 'Altered reason']))
    .rejects.toThrow();
  await expect(query('UPDATE review_jobs SET state=$2 WHERE id=$1', [s.job, 'blocked']))
    .rejects.toThrow(/superseded job is immutable/);
});

it('allows reopening, then creates a new review round on the next submission', async () => {
  const s = await submit();
  await supersede(s.card, s.successor);
  await query('UPDATE cards SET status=$2 WHERE id=$1', [s.card, 'ready']);
  await query('UPDATE cards SET status=$2 WHERE id=$1', [s.card, 'review']);
  const jobs = (await query('SELECT state,round FROM review_jobs WHERE card=$1 ORDER BY round', [s.card])).rows;
  expect(jobs).toMatchObject([{ state: 'superseded', round: 0 }, { state: 'queued', round: 1 }]);
});

it('refuses a PR reference, a snapshot, missing successor and a conflicting repeat', async () => {
  const a = await submit();
  await expect(supersede(a.card, a.card)).rejects.toThrow(/successor must differ/);
  await expect(supersede(a.card, 't_deadbeef')).rejects.toThrow(/no successor/);
  await query('INSERT INTO card_comments(card_id,author,body) VALUES($1,$2,$3)',
    [a.card, 'owner', 'PR https://github.com/example/engine/pull/12 exists']);
  await expect(supersede(a.card, a.successor)).rejects.toThrow(/references a PR/);
  await query('DELETE FROM card_comments WHERE card_id=$1 AND body LIKE $2', [a.card, 'PR https:%']);
  await query('UPDATE review_jobs SET snapshot=$2 WHERE id=$1', [a.job, { repo: 'example/engine', pr: 12 }]);
  await expect(supersede(a.card, a.successor)).rejects.toThrow(/without PR/);
  await query('UPDATE review_jobs SET snapshot=NULL WHERE id=$1', [a.job]);
  const receipt = await supersede(a.card, a.successor);
  const other = await createCard('owner', { title: 'Different replacement', assignee: 'builder' });
  await expect(supersede(a.card, other.id)).rejects.toThrow(/already has a supersede receipt/);
  expect(receipt.id).toBeTruthy();
});

it('requires a human cancellation and refuses any builder run', async () => {
  const s = await submit();
  await query('DELETE FROM card_comments WHERE card_id=$1', [s.card]);
  await expect(supersede(s.card, s.successor)).rejects.toThrow(/human cancellation comment/);
  await query('INSERT INTO card_comments(card_id,author,body) VALUES($1,$2,$3)',
    [s.card, 'owner', 'Cancelled before launch; use the replacement.']);
  await query('INSERT INTO card_runs(card_id,agent_name,runtime,lease_until,finished_at,outcome) VALUES($1,$2,$3,now(),now(),$4)',
    [s.card, 'builder', 'codex', 'partial']);
  await expect(supersede(s.card, s.successor)).rejects.toThrow(/builder launch/);
  expect((await getCard(s.card)).card.status).toBe('blocked');
});

it('refuses the worker and an owner connection carrying an org identity', async () => {
  const s = await submit();
  const service = await connection(worker);
  try { await expect(supersedeOwner(service, { card: s.card, successor: s.successor, reason: 'Owner cancelled unbuilt work' }))
    .rejects.toThrow(/permission denied/); }
  finally { await service.end(); }
  const servicePatch = await connection(worker);
  try { await expect(servicePatch.query('SELECT review_save($1,$2)', [s.job, { state: 'superseded' }]))
    .rejects.toThrow(/owner supersede receipt required/); }
  finally { await servicePatch.end(); }
  const impersonated = await connection(undefined, 'builder');
  try { await expect(supersedeOwner(impersonated, { card: s.card, successor: s.successor, reason: 'Owner cancelled unbuilt work' }))
    .rejects.toThrow(/org identity/); }
  finally { await impersonated.end(); }
  expect((await getCard(s.card)).card.status).toBe('blocked');
});

it('parses only a complete owner command', () => {
  expect(parseOwnerSupersedeArgs(['t_123abc', '--by', 't_456def', '--reason', 'Superseded by approved scope']))
    .toMatchObject({ card: 't_123abc', successor: 't_456def' });
  expect(() => parseOwnerSupersedeArgs(['t_123abc', '--by', 't_456def'])).toThrow();
});
