import pg from 'pg';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { query } from '../src/db.js';
import { createCard, finishCard, getCard } from '../src/board.js';
import { importOrg } from '../src/org.js';
import { acknowledgeCorrection, cancelCorrection, claimCorrection, finishCorrection, prepareCorrection, registerLaunch, retryCorrection } from '../src/review/corrections.js';
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
async function runningCorrection(runId='run-correction-stale') {
  const {card,job}=await submitted(); await save(Number(job.id),rejection(job)); const c=await client();
  const claimed=await claimCorrection(c,'worker-a',60);
  await prepareCorrection(c,claimed!.id,claimed!.leaseToken,runId,claimed!.head);
  await acknowledgeCorrection(c,claimed!.id,claimed!.leaseToken,runId,`process-${runId}`,claimed!.head);
  return {c,card,job,claimed:claimed!,runId};
}

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
    expect((await prepareCorrection(first,claimed!.id,claimed!.leaseToken,'run-correction-1',claimed!.head)).state).toBe('starting');
    expect((await prepareCorrection(first,claimed!.id,claimed!.leaseToken,'run-correction-1',claimed!.head)).state).toBe('starting');
    const running = await acknowledgeCorrection(first,claimed!.id,claimed!.leaseToken,'run-correction-1','process-1',claimed!.head);
    expect(running.state).toBe('running'); expect((await getCard(card.id)).card.status).toBe('running');
    expect((await acknowledgeCorrection(first,claimed!.id,claimed!.leaseToken,'run-correction-1','process-1',claimed!.head)).state).toBe('running');
    await finishCorrection(first,claimed!.id,'run-correction-1',claimed!.head);
    await finishCorrection(first,claimed!.id,'run-correction-1',claimed!.head);
    expect((await getCard(card.id)).card.status).toBe('review');
    expect((await query('SELECT count(*)::int n FROM review_jobs WHERE card=$1',[card.id])).rows[0]!.n).toBe(2);
  } finally { await first.end(); await second.end(); }
});

it('recovers an expired proven no-start claim once and escalates an ambiguous prepared launch', async () => {
  const {card,job} = await submitted(); await save(Number(job.id), rejection(job));
  const crashed = await client();
  const abandoned = await claimCorrection(crashed,'worker-a',60);
  await crashed.end();
  await query("UPDATE review_corrections SET lease_until=now()-interval '1 second' WHERE id=$1",[abandoned!.id]);
  const restarted = await client();
  try {
    const recovered = await claimCorrection(restarted,'worker-a',60);
    expect(recovered).toMatchObject({id:abandoned!.id,fence:abandoned!.fence+1,transientAttempts:1});
    expect((await getCard(card.id)).card.rounds).toBe(1);

    await prepareCorrection(restarted,recovered!.id,recovered!.leaseToken,'run-maybe-started',recovered!.head);
    await query("UPDATE review_corrections SET lease_until=now()-interval '1 second' WHERE id=$1",[recovered!.id]);
    expect(await claimCorrection(restarted,'worker-a',60)).toBeNull();
    expect(await claimCorrection(restarted,'worker-a',60)).toBeNull();
    expect((await query('SELECT state,run_id,transient_attempts FROM review_corrections WHERE id=$1',[recovered!.id])).rows[0]).toMatchObject({state:'blocked',run_id:'run-maybe-started',transient_attempts:1});
    expect((await getCard(card.id)).card).toMatchObject({status:'blocked',rounds:1,block_kind:'tool-error'});
  } finally { await restarted.end(); }
});

it('retains distinct findings with the same code and impact while replay stays idempotent', async () => {
  const {job} = await submitted();
  const patch = rejection(job);
  patch.verdict.findings.push({code:'code-finding',severity:'high',location:'worker.ts:24',evidence:'missing fence',impact:'incorrect result',fix:'Check the fence',verification:'Run lease test'});
  await save(Number(job.id),patch); await save(Number(job.id),patch);
  const feedback = (await query('SELECT evidence, required_fix FROM review_feedback WHERE job=$1 ORDER BY id',[job.id])).rows;
  expect(feedback).toEqual(expect.arrayContaining([
    expect.objectContaining({evidence:'unsafe query',required_fix:'Bind the value'}),
    expect.objectContaining({evidence:'missing fence',required_fix:'Check the fence'}),
  ]));
  expect(feedback).toHaveLength(2);
  expect((await query('SELECT count(*)::int n FROM review_corrections WHERE card=(SELECT card FROM review_jobs WHERE id=$1)',[job.id])).rows[0]!.n).toBe(1);
});

it('cancels only its bound attempt and cannot regress a newer accepted review', async () => {
  const {card,job} = await submitted(); await save(Number(job.id), rejection(job));
  const correction = (await query('SELECT id FROM review_corrections WHERE card=$1',[card.id])).rows[0]!;
  await finishCard('builder',card.id,{outcome:'done'});
  const newer = (await query('SELECT * FROM review_jobs WHERE card=$1 ORDER BY id DESC LIMIT 1',[card.id])).rows[0]!;
  await save(Number(newer.id),{state:'approved',snapshot:{repo:'example/engine',pr:7,base:'a'.repeat(40),head:'d'.repeat(40)},verdict:{reviewer:'auditor',decision:'accept',head:'d'.repeat(40),evidence:'e'.repeat(64),findings:[]}});
  const c = await client();
  try { await cancelCorrection(c,Number(correction.id),'Stale rejected head'); }
  finally { await c.end(); }
  expect((await getCard(card.id)).card).toMatchObject({status:'review',block_kind:null,block_reason:null});
  expect((await query('SELECT state FROM review_corrections WHERE id=$1',[correction.id])).rows[0]!.state).toBe('cancelled');
});

it('closes only the cancelled correction run, not another run on the card', async () => {
  const {card,job} = await submitted(); await save(Number(job.id), rejection(job)); const c = await client();
  try {
    const claimed = await claimCorrection(c,'worker-a',60);
    await prepareCorrection(c,claimed!.id,claimed!.leaseToken,'run-old',claimed!.head);
    await acknowledgeCorrection(c,claimed!.id,claimed!.leaseToken,'run-old','process-old',claimed!.head);
    await query("UPDATE card_runs SET finished_at=now(),outcome='partial' WHERE card_id=$1 AND run_id='run-old'",[card.id]);
    await query("INSERT INTO card_runs(card_id,agent_name,runtime,run_id,lease_until) VALUES($1,'builder','codex','run-new',now()+interval '1 hour')",[card.id]);
    await cancelCorrection(c,claimed!.id,'Old correction cancelled');
    const runs = (await query('SELECT run_id,finished_at FROM card_runs WHERE card_id=$1 ORDER BY run_id',[card.id])).rows;
    expect(runs.find(r=>r.run_id==='run-old')!.finished_at).not.toBeNull();
    expect(runs.find(r=>r.run_id==='run-new')!.finished_at).toBeNull();
  } finally { await c.end(); }
});

it('cancels an old finish after a newer submission without changing the current review', async () => {
  const {c,card,claimed,runId}=await runningCorrection();
  try {
    await query("UPDATE cards SET status='review' WHERE id=$1",[card.id]);
    const newer=(await query('SELECT * FROM review_jobs WHERE card=$1 ORDER BY id DESC LIMIT 1',[card.id])).rows[0]!;
    await finishCorrection(c,claimed.id,runId,claimed.head);
    await finishCorrection(c,claimed.id,runId,claimed.head);
    expect((await getCard(card.id)).card.status).toBe('review');
    expect((await query('SELECT id,state FROM review_jobs WHERE card=$1 ORDER BY id',[card.id])).rows.at(-1)).toMatchObject({id:newer.id,state:'queued'});
    expect((await query('SELECT state,error FROM review_corrections WHERE id=$1',[claimed.id])).rows[0]).toMatchObject({state:'cancelled',error:'Correction superseded before finish'});
    expect((await query('SELECT outcome FROM card_runs WHERE card_id=$1 AND run_id=$2',[card.id,runId])).rows[0]!.outcome).toBe('partial');
  } finally { await c.end(); }
});

it('cannot regress accepted completion or shipping receipts from an old correction finish', async () => {
  const {c,card,claimed,runId}=await runningCorrection('run-correction-accepted');
  try {
    await query("UPDATE cards SET status='review' WHERE id=$1",[card.id]);
    const newer=(await query('SELECT * FROM review_jobs WHERE card=$1 ORDER BY id DESC LIMIT 1',[card.id])).rows[0]!;
    const revision='d'.repeat(40);
    await save(Number(newer.id),{state:'deployed',merged:revision,deployed:revision,health:revision,snapshot:{repo:'example/engine',pr:7,base:'a'.repeat(40),head:revision},verdict:{reviewer:'auditor',decision:'accept',head:revision,evidence:'e'.repeat(64),findings:[]}});
    await query('UPDATE review_policy SET shipping_enabled=true');
    await c.query('SELECT review_complete($1)',[newer.id]);
    await query('UPDATE review_policy SET shipping_enabled=false');
    await finishCorrection(c,claimed.id,runId,claimed.head);
    expect((await getCard(card.id)).card.status).toBe('done');
    expect((await query('SELECT state,merged,deployed,health FROM review_jobs WHERE id=$1',[newer.id])).rows[0]).toMatchObject({state:'done',merged:revision,deployed:revision,health:revision});
    expect((await query('SELECT state FROM review_corrections WHERE id=$1',[claimed.id])).rows[0]!.state).toBe('cancelled');
  } finally { await c.end(); }
});

it('rejects a different run identity without closing the active correction', async () => {
  const {c,claimed,runId}=await runningCorrection('run-correction-current');
  try {
    await expect(finishCorrection(c,claimed.id,'run-correction-other',claimed.head)).rejects.toThrow(/stale or unknown correction run/);
    expect((await query('SELECT state FROM review_corrections WHERE id=$1',[claimed.id])).rows[0]!.state).toBe('running');
    expect((await query('SELECT finished_at FROM card_runs WHERE run_id=$1',[runId])).rows[0]!.finished_at).toBeNull();
  } finally { await c.end(); }
});

it('cancels a superseded finish without touching another current run', async () => {
  const {c,card,claimed,runId}=await runningCorrection('run-correction-old');
  try {
    await query("UPDATE card_runs SET finished_at=now(),outcome='partial' WHERE card_id=$1 AND run_id=$2",[card.id,runId]);
    await query("INSERT INTO card_runs(card_id,agent_name,runtime,run_id,lease_until) VALUES($1,'builder','codex','run-correction-new',now()+interval '1 hour')",[card.id]);
    await finishCorrection(c,claimed.id,runId,claimed.head);
    expect((await getCard(card.id)).card.status).toBe('running');
    expect((await query("SELECT finished_at FROM card_runs WHERE card_id=$1 AND run_id='run-correction-new'",[card.id])).rows[0]!.finished_at).toBeNull();
    expect((await query('SELECT state FROM review_corrections WHERE id=$1',[claimed.id])).rows[0]!.state).toBe('cancelled');
  } finally { await c.end(); }
});

it('separates transient host backoff from code rounds and rejects stale acknowledgement', async () => {
  const {card,job} = await submitted(); await save(Number(job.id), rejection(job)); const c = await client();
  try {
    const claimed = await claimCorrection(c,'worker-a',1); await retryCorrection(c,claimed!.id,claimed!.leaseToken,'host-busy',1);
    expect((await getCard(card.id)).card.rounds).toBe(1);
    await query("UPDATE review_corrections SET available_at=now()-interval '1 second' WHERE id=$1",[claimed!.id]);
    const retry = await claimCorrection(c,'worker-a',60); expect(retry!.transientAttempts).toBe(1);
    await prepareCorrection(c,retry!.id,retry!.leaseToken,'run-stale',retry!.head);
    await expect(acknowledgeCorrection(c,retry!.id,retry!.leaseToken,'run-stale','process-stale','d'.repeat(40))).rejects.toThrow(/stale/);
    await cancelCorrection(c,retry!.id,'PR head changed');
    expect((await getCard(card.id)).card.status).toBe('blocked');
  } finally { await c.end(); }
});

it('cancels a prepared stale acknowledgement after a newer submission without creating a run', async () => {
  const {card,job}=await submitted(); await save(Number(job.id),rejection(job)); const c=await client();
  try {
    const claimed=await claimCorrection(c,'worker-a',60);
    await prepareCorrection(c,claimed!.id,claimed!.leaseToken,'run-old-ack',claimed!.head);
    await finishCard('builder',card.id,{outcome:'done'});
    expect((await acknowledgeCorrection(c,claimed!.id,claimed!.leaseToken,'run-old-ack','process-old-ack',claimed!.head)).state).toBe('cancelled');
    expect((await getCard(card.id)).card.status).toBe('review');
    expect((await query("SELECT count(*)::int n FROM card_runs WHERE card_id=$1 AND run_id='run-old-ack'",[card.id])).rows[0]!.n).toBe(0);
  } finally { await c.end(); }
});

it('cancels stale retry exhaustion without regressing a newer accepted completion', async () => {
  const {card,job}=await submitted(); await save(Number(job.id),rejection(job)); const c=await client();
  try {
    const claimed=await claimCorrection(c,'worker-a',60);
    await query('UPDATE review_corrections SET transient_attempts=9 WHERE id=$1',[claimed!.id]);
    await finishCard('builder',card.id,{outcome:'done'});
    const newer=(await query('SELECT * FROM review_jobs WHERE card=$1 ORDER BY id DESC LIMIT 1',[card.id])).rows[0]!;
    const revision='e'.repeat(40);
    await save(Number(newer.id),{state:'deployed',merged:revision,deployed:revision,health:revision,snapshot:{repo:'example/engine',pr:7,base:'a'.repeat(40),head:revision},verdict:{reviewer:'auditor',decision:'accept',head:revision,evidence:'f'.repeat(64),findings:[]}});
    await query('UPDATE review_policy SET shipping_enabled=true');
    await c.query('SELECT review_complete($1)',[newer.id]);
    await query('UPDATE review_policy SET shipping_enabled=false');
    await retryCorrection(c,claimed!.id,claimed!.leaseToken,'host-offline',1);
    expect((await getCard(card.id)).card.status).toBe('done');
    expect((await query('SELECT state FROM review_corrections WHERE id=$1',[claimed!.id])).rows[0]!.state).toBe('cancelled');
    expect((await query('SELECT state,merged,deployed,health FROM review_jobs WHERE id=$1',[newer.id])).rows[0]).toMatchObject({state:'done',merged:revision,deployed:revision,health:revision});
  } finally { await c.end(); }
});

it('blocks only the current correction when live host retries are exhausted', async () => {
  const {card,job}=await submitted(); await save(Number(job.id),rejection(job)); const c=await client();
  try {
    const claimed=await claimCorrection(c,'worker-a',60);
    await query('UPDATE review_corrections SET transient_attempts=9 WHERE id=$1',[claimed!.id]);
    await retryCorrection(c,claimed!.id,claimed!.leaseToken,'host-offline',1);
    await retryCorrection(c,claimed!.id,claimed!.leaseToken,'duplicate-poll',1);
    expect((await getCard(card.id)).card).toMatchObject({status:'blocked',block_kind:'tool-error'});
    expect((await query('SELECT state FROM review_corrections WHERE id=$1',[claimed!.id])).rows[0]!.state).toBe('blocked');
  } finally { await c.end(); }
});
