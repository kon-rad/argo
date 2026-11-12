import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createCard, finishCard, getCard } from '../src/board.js';
import { query } from '../src/db.js';
import { truncateAll } from './helpers.js';

const workerName = 'sb_review_execution_fixture';
const databaseUrl = `postgres://${process.env.PGHOST ?? 'localhost'}:${process.env.PGPORT ?? '5432'}/${process.env.SB_TEST_DB ?? 'secondbrain_test'}`;
const head = 'b'.repeat(40), base = 'a'.repeat(40), evidence = 'c'.repeat(64);

function workerUrl(): string { const parsed = new URL(databaseUrl); parsed.username = workerName; return parsed.toString(); }
async function worker(): Promise<pg.Client> { const client = new pg.Client({ connectionString: workerUrl() }); await client.connect(); return client; }
async function asWorker(sql: string, values: unknown[] = []): Promise<pg.QueryResult> {
  const client = await worker(); try { return await client.query(sql, values); } finally { await client.end(); }
}

beforeEach(async () => {
  await query('UPDATE review_policy SET enabled=false,corrections_enabled=false,reviewer=NULL,worker_login=NULL');
  await truncateAll();
  await query("INSERT INTO teams(slug,name,lead,members) VALUES('engineering','Engineering','auditor',ARRAY['builder','auditor'])");
  await query(`INSERT INTO org_agents(name,team_slug,runtime,role,reports_to,model,org_version,work,capabilities) VALUES
    ('owner',NULL,'human','Owner',NULL,NULL,'execution-fixture',NULL,'{}'),
    ('auditor','engineering','codex','Reviewer','owner','test-model','execution-fixture','coding',ARRAY['review']),
    ('builder','engineering','codex','Builder','auditor','test-model','execution-fixture','coding',ARRAY['code'])`);
  await query(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='${workerName}') THEN CREATE ROLE ${workerName} LOGIN; END IF; END $$`);
  if (process.env.PGPASSWORD) await query(`ALTER ROLE ${workerName} PASSWORD '${process.env.PGPASSWORD.replace(/'/g, "''")}'`);
  await query(`GRANT sb_review_worker TO ${workerName}`);
  await query(`UPDATE review_policy SET enabled=true,corrections_enabled=false,shipping_enabled=false,max_rounds=2,reviewer='auditor',worker_login=$1`, [workerName]);
});
afterAll(async () => { await query('UPDATE review_policy SET enabled=false,corrections_enabled=false,reviewer=NULL,worker_login=NULL'); });

async function submitted() {
  const card = await createCard('owner', { title:'Reviewer execution fixture', body:'Done when: execution tests pass', contract:{objective:'Review safely',verification:'tests'}, assignee:'builder', work:'coding', repo:'engine' });
  await finishCard('builder', card.id, { outcome:'done' });
  const job = (await query('SELECT * FROM review_jobs WHERE card=$1', [card.id])).rows[0]!;
  return { card, job };
}
function snapshot() { return { repo:'example/engine',pr:7,base,head,branch:'main',merged:null,checks:[{name:'test',state:'pass'}],sources:[{ref:'ticket',revision:'1',text:'Done when: execution tests pass',essential:true,missing:false,truncated:false}] }; }
function rejected(code='scope-capacity') { return { reviewer:'auditor',decision:'reject',repo:'example/engine',pr:7,base,head,evidence,categories:{},findings:[{code,severity:'high',location:'scope',evidence:'capacity exceeded',impact:'review cannot continue',fix:'split the change',verification:'rerun scope'}] }; }
async function save(job: number, patch: unknown, origin?: 'reviewer'|'coordinator') {
  await asWorker(origin ? 'SELECT review_save($1,$2,$3)' : 'SELECT review_save($1,$2)', origin ? [job,patch,origin] : [job,patch]);
}
async function reserve(job: number, maxAttempts=3, maxElapsedSeconds=3600) {
  return (await asWorker('SELECT * FROM review_execution_reserve($1,$2,$3,$4,$5)',[job,head,evidence,maxAttempts,maxElapsedSeconds])).rows[0] ?? null;
}
async function fail(job: number, generation: number, kind: string, retrySeconds=1) {
  return (await asWorker('SELECT * FROM review_execution_fail($1,$2,$3,$4,$5,$6)',[job,head,evidence,generation,kind,retrySeconds])).rows[0];
}

describe('durable trusted verdict producer', () => {
  it('keeps a genuine coordinator origin across a separate default rejection save and worker restart', async () => {
    const { job } = await submitted();
    await save(Number(job.id), { state:'reviewing',snapshot:snapshot(),verdict:rejected() }, 'coordinator');
    await save(Number(job.id), { state:'rejected' });
    expect((await query('SELECT code,producer_kind,producer FROM review_feedback WHERE job=$1',[job.id])).rows).toEqual([
      expect.objectContaining({code:'scope-capacity',producer_kind:'coordinator',producer:workerName}),
    ]);
  });

  it('defaults model codes to reviewer and clears stale origin on replacement, clear, or revision reset', async () => {
    const malicious = await submitted();
    await save(Number(malicious.job.id), {state:'rejected',snapshot:snapshot(),verdict:rejected('ci-failure')});
    expect((await query('SELECT producer_kind FROM review_feedback WHERE job=$1',[malicious.job.id])).rows[0]).toMatchObject({producer_kind:'reviewer'});

    const current = await submitted();
    await save(Number(current.job.id), {state:'reviewing',snapshot:snapshot(),verdict:rejected()}, 'coordinator');
    expect((await query('SELECT verdict_origin FROM review_jobs WHERE id=$1',[current.job.id])).rows[0]).toMatchObject({verdict_origin:'coordinator'});
    await save(Number(current.job.id), {verdict:{...rejected(),findings:[{...rejected().findings[0],location:'new scope'}]}});
    expect((await query('SELECT verdict_origin FROM review_jobs WHERE id=$1',[current.job.id])).rows[0]).toMatchObject({verdict_origin:'reviewer'});
    await save(Number(current.job.id), {verdict:null});
    expect((await query('SELECT verdict_origin FROM review_jobs WHERE id=$1',[current.job.id])).rows[0]).toMatchObject({verdict_origin:null});
    await save(Number(current.job.id), {snapshot:null,verdict:null});
    expect((await query('SELECT verdict_origin FROM review_jobs WHERE id=$1',[current.job.id])).rows[0]).toMatchObject({verdict_origin:null});
  });
});

describe('bounded reviewer invocation state', () => {
  it('persists temporary failure then success while corrections are disabled and consumes no code round or effect', async () => {
    const {card,job}=await submitted(); await save(Number(job.id),{state:'reviewing',snapshot:snapshot(),verdict:null});
    const first=await reserve(Number(job.id)); expect(first).toMatchObject({attempt:1,generation:0});
    expect(await fail(Number(job.id),Number(first.generation),'temporary')).toMatchObject({outcome:'retry',failure_kind:'temporary'});
    expect(await reserve(Number(job.id))).toBeNull();
    await query("UPDATE review_executions SET retry_after=now()-interval '1 second' WHERE job=$1",[job.id]);
    const second=await reserve(Number(job.id)); expect(second).toMatchObject({attempt:2,generation:0});
    await asWorker('SELECT review_execution_succeed($1,$2,$3,$4)',[job.id,head,evidence,second.generation]);
    expect((await query('SELECT outcome,attempts,first_failure_at FROM review_executions WHERE job=$1',[job.id])).rows[0]).toMatchObject({outcome:'succeeded',attempts:2});
    expect((await getCard(card.id)).card).toMatchObject({status:'review',rounds:0});
    expect((await query('SELECT verdict,merged,deployed,health FROM review_jobs WHERE id=$1',[job.id])).rows[0]).toMatchObject({verdict:null,merged:null,deployed:null,health:null});
    expect((await query('SELECT count(*)::int n FROM review_feedback WHERE job=$1',[job.id])).rows[0].n).toBe(0);
    expect((await query('SELECT count(*)::int n FROM review_corrections WHERE card=$1',[card.id])).rows[0].n).toBe(0);
  });

  it('exhausts finite attempts and elapsed time across fresh worker connections', async () => {
    const attempts=await submitted(); await save(Number(attempts.job.id),{state:'reviewing',snapshot:snapshot(),verdict:null});
    for(let n=1;n<=3;n+=1){const claim=await reserve(Number(attempts.job.id),3,3600);expect(claim.attempt).toBe(n);const result=await fail(Number(attempts.job.id),Number(claim.generation),'temporary');if(n<3)await query("UPDATE review_executions SET retry_after=now()-interval '1 second' WHERE job=$1",[attempts.job.id]);else expect(result).toMatchObject({outcome:'exhausted',failure_kind:'temporary'});}
    expect(await reserve(Number(attempts.job.id),3,3600)).toBeNull();

    const elapsed=await submitted(); await save(Number(elapsed.job.id),{state:'reviewing',snapshot:snapshot(),verdict:null});
    const claim=await reserve(Number(elapsed.job.id),9,60); await fail(Number(elapsed.job.id),Number(claim.generation),'temporary');
    await query("UPDATE review_executions SET first_failure_at=now()-interval '61 seconds',retry_after=now()-interval '1 second' WHERE job=$1",[elapsed.job.id]);
    expect(await reserve(Number(elapsed.job.id),9,60)).toBeNull();
    expect((await query('SELECT outcome,failure_kind FROM review_executions WHERE job=$1',[elapsed.job.id])).rows[0]).toMatchObject({outcome:'exhausted',failure_kind:'temporary'});
  });

  it.each(['authentication','identity','unknown','schema'])('fails closed for %s without storing raw adapter detail', async kind => {
    const {card,job}=await submitted(); await save(Number(job.id),{state:'reviewing',snapshot:snapshot(),verdict:null});
    const claim=await reserve(Number(job.id)); const result=await fail(Number(job.id),Number(claim.generation),kind);
    expect(result).toMatchObject({outcome:'exhausted',failure_kind:kind});
    const row=(await query('SELECT * FROM review_executions WHERE job=$1',[job.id])).rows[0];
    expect(JSON.stringify(row)).not.toContain('fixture-secret');
    expect((await getCard(card.id)).card).toMatchObject({status:'review',rounds:0});
  });
});

describe('fenced operator recovery', () => {
  it('resets only an exact exhausted reservation and denies stale, replayed, newer-job, and shipping-state recovery', async () => {
    const {card,job}=await submitted(); await save(Number(job.id),{state:'reviewing',snapshot:snapshot(),verdict:null});
    const claim=await reserve(Number(job.id)); await fail(Number(job.id),Number(claim.generation),'identity');
    const recover=(values:unknown[])=>asWorker('SELECT * FROM review_execution_recover($1,$2,$3,$4,$5)',values);
    await expect(recover([job.id,'d'.repeat(40),evidence,0,'identity repaired'])).rejects.toThrow(/stale|binding/);
    await expect(recover([job.id,head,'d'.repeat(64),0,'identity repaired'])).rejects.toThrow(/stale|binding/);
    const recovered=(await recover([job.id,head,evidence,0,'identity repaired'])).rows[0]; expect(recovered).toMatchObject({recovery_generation:1,outcome:'retry'});
    await expect(recover([job.id,head,evidence,0,'replay'])).rejects.toThrow(/generation|replay/);

    await finishCard('builder',card.id,{outcome:'done'}); // creates a newer review job for the same card
    await expect(recover([job.id,head,evidence,1,'stale older job'])).rejects.toThrow(/newer|stale/);
    await query("UPDATE review_jobs SET merged=$2,state='merged' WHERE id=$1",[job.id,'e'.repeat(40)]);
    await expect(recover([job.id,head,evidence,1,'shipping started'])).rejects.toThrow(/shipping|state/);
    expect((await query("SELECT count(*)::int n FROM card_events WHERE card_id=$1 AND kind='review-execution-recovered'",[card.id])).rows[0].n).toBe(1);
  });
});
