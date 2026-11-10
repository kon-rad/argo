import pg from 'pg';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { query } from '../src/db.js';
import { createCard, finishCard, getCard } from '../src/board.js';
import { importOrg } from '../src/org.js';
import { acknowledgeCorrection, cancelCorrection, claimCorrection, finishCorrection, registerLaunch, retryCorrection } from '../src/review/corrections.js';
import { truncateAll } from './helpers.js';

const workerName = 'sb_review_correction_fixture';
const url = `postgres://${process.env.PGHOST ?? 'localhost'}:${process.env.PGPORT ?? '5432'}/${process.env.SB_TEST_DB ?? 'secondbrain_test'}`;
function workerUrl(): string { const parsed = new URL(url); parsed.username = workerName; return parsed.toString(); }
async function client(): Promise<pg.Client> { const result = new pg.Client({ connectionString: workerUrl() }); await result.connect(); return result; }
async function save(job: number, patch: unknown): Promise<void> { const c = await client(); try { await c.query('SELECT review_save($1,$2)', [job, patch]); } finally { await c.end(); } }

beforeEach(async () => {
  await query('UPDATE review_policy SET enabled=false,corrections_enabled=false,reviewer=NULL,worker_login=NULL');
  await truncateAll();
  await importOrg({ version:'correction-fixture', company:'Example', ceo:'owner', agents:{ owner:{runtime:'human',role:'Owner'}, builder:{runtime:'codex',model:'test-model',team:'engineering',reports_to:'auditor',role:'Builder',capabilities:['code']}, auditor:{runtime:'codex',model:'test-model',team:'engineering',reports_to:'owner',role:'Reviewer',capabilities:['review']} }, teams:{engineering:{name:'Engineering',lead:'auditor'}}, channels:{} });
  await query(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='${workerName}') THEN CREATE ROLE ${workerName} LOGIN; END IF; END $$`);
  if (process.env.PGPASSWORD) await query(`ALTER ROLE ${workerName} PASSWORD '${process.env.PGPASSWORD.replace(/'/g, "''")}'`);
  await query(`GRANT sb_review_worker TO ${workerName}`);
  await query(`UPDATE review_policy SET enabled=true,corrections_enabled=true,shipping_enabled=false,max_rounds=2,reviewer='auditor',worker_login=$1`, [workerName]);
});
afterAll(async () => { await query('UPDATE review_policy SET enabled=false,corrections_enabled=false,reviewer=NULL,worker_login=NULL'); });

async function submitted() {
  const card = await createCard('owner', { title:'Correction fixture', body:'Done when: correction tests pass', contract:{objective:'Repair',verification:'tests'}, assignee:'builder', work:'coding', repo:'engine' });
  const c = await client();
  try { await registerLaunch(c, { card:card.id,builder:'builder',persona:'engineer',runtime:'codex',model:'test-model',host:'worker-a',repo:'engine',branch:`card/${card.id}`,worktree:`/srv/worktrees/${card.id}`,commonDir:'/srv/git/engine',originalRunId:'run-original',stage:'build' }); }
  finally { await c.end(); }
  await finishCard('builder', card.id, { outcome:'done' });
  const job = (await query('SELECT * FROM review_jobs WHERE card=$1', [card.id])).rows[0]!;
  return { card, job };
}
function rejection(job: Record<string, unknown>) { return { state:'rejected', snapshot:{repo:'example/engine',pr:7,base:'a'.repeat(40),head:'b'.repeat(40)}, verdict:{reviewer:'auditor',decision:'reject',head:'b'.repeat(40),base:'a'.repeat(40),evidence:'c'.repeat(64),findings:[{code:'code-finding',severity:'high',location:'server.ts:12',evidence:'unsafe query',impact:'incorrect result',fix:'Bind the value',verification:'Run correction test'}]} }; }

it('atomically retains assignment and queues one revision-bound correction exactly once', async () => {
  const {card,job} = await submitted(); await save(Number(job.id), rejection(job)); await save(Number(job.id), rejection(job));
  expect((await getCard(card.id)).card).toMatchObject({ status:'ready', assignee:'builder', rounds:1 });
  expect((await query('SELECT * FROM review_feedback WHERE job=$1',[job.id])).rows).toHaveLength(1);
  expect((await query('SELECT * FROM review_corrections WHERE card=$1',[card.id])).rows).toHaveLength(1);
});

it('proves ready -> claimed -> acknowledged running -> review without double claim or counter increments', async () => {
  const {card,job} = await submitted(); await save(Number(job.id), rejection(job));
  const first = await client(), second = await client();
  try {
    const claimed = await claimCorrection(first,'worker-a',60); expect(claimed?.builder).toBe('builder');
    expect(await claimCorrection(second,'worker-a',60)).toBeNull();
    const running = await acknowledgeCorrection(first,claimed!.id,claimed!.leaseToken,'run-correction-1','process-1',claimed!.head);
    expect(running.state).toBe('running'); expect((await getCard(card.id)).card.status).toBe('running');
    expect((await acknowledgeCorrection(first,claimed!.id,claimed!.leaseToken,'run-correction-1','process-1',claimed!.head)).state).toBe('running');
    await finishCorrection(first,claimed!.id,'run-correction-1',claimed!.head);
    expect((await getCard(card.id)).card.status).toBe('review');
    expect((await query('SELECT count(*)::int n FROM review_jobs WHERE card=$1',[card.id])).rows[0]!.n).toBe(2);
  } finally { await first.end(); await second.end(); }
});

it('separates transient host backoff from code rounds and rejects stale acknowledgement', async () => {
  const {card,job} = await submitted(); await save(Number(job.id), rejection(job)); const c = await client();
  try {
    const claimed = await claimCorrection(c,'worker-a',1); await retryCorrection(c,claimed!.id,claimed!.leaseToken,'host-busy',1);
    expect((await getCard(card.id)).card.rounds).toBe(1);
    await query("UPDATE review_corrections SET available_at=now()-interval '1 second' WHERE id=$1",[claimed!.id]);
    const retry = await claimCorrection(c,'worker-a',60); expect(retry!.transientAttempts).toBe(1);
    await expect(acknowledgeCorrection(c,retry!.id,retry!.leaseToken,'run-stale','process-stale','d'.repeat(40))).rejects.toThrow(/stale/);
    await cancelCorrection(c,retry!.id,'PR head changed');
    expect((await getCard(card.id)).card.status).toBe('blocked');
  } finally { await c.end(); }
});
