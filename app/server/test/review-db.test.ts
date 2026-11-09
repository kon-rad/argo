import pg from 'pg';
import { beforeEach, afterAll, it, expect } from 'vitest';
import { query } from '../src/db.js';
import { importOrg } from '../src/org.js';
import { createCard, finishCard, moveCard, linkCards, getCard, claimCard } from '../src/board.js';
import { shipCheck } from '../src/org-powers.js';
import { truncateAll } from './helpers.js';

const workerName='sb_review_fixture';
const url=`postgres://${process.env.PGHOST ?? 'localhost'}:${process.env.PGPORT ?? '5432'}/${process.env.SB_TEST_DB ?? 'secondbrain_test'}`;
function asUrl(user:string): string { const u=new URL(url);u.username=user;return u.toString(); }
async function as(user:string,sql:string,params:unknown[]=[]):Promise<pg.QueryResult> {
  const c=new pg.Client({connectionString:asUrl(user),options:user==='sb_org'?'-c org.agent=builder':undefined});
  await c.connect();try{return await c.query(sql,params);}finally{await c.end();}
}
beforeEach(async()=>{
  await query(`UPDATE review_policy SET enabled=false,reviewer=NULL,worker_login=NULL`);
  await truncateAll();
  await importOrg({version:'review-fixture',company:'Example',ceo:'owner',agents:{owner:{runtime:'human',role:'Owner'},builder:{runtime:'codex',model:'test-codex',team:'engineering',reports_to:'auditor',role:'Builder',capabilities:['code']},auditor:{runtime:'codex',model:'test-codex',team:'engineering',reports_to:'owner',role:'Reviewer',capabilities:['review']}},teams:{engineering:{name:'Engineering',lead:'auditor'}},channels:{}});
  await query(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='sb_review_fixture') THEN CREATE ROLE sb_review_fixture LOGIN; END IF; END $$`);
  if(process.env.PGPASSWORD) await query(`ALTER ROLE sb_review_fixture PASSWORD '${process.env.PGPASSWORD.replace(/'/g,"''")}'`);
  await query(`GRANT sb_review_worker TO sb_review_fixture`);
  await query(`INSERT INTO review_policy(singleton,enabled,shipping_enabled,reviewer,worker_login) VALUES(true,true,true,'auditor',$1) ON CONFLICT(singleton) DO UPDATE SET enabled=true,shipping_enabled=true,boards=NULL,repositories=NULL,max_rounds=2,reviewer='auditor',worker_login=excluded.worker_login`,[workerName]);
});
afterAll(async()=>{await query('UPDATE review_policy SET enabled=false,reviewer=NULL,worker_login=NULL');});
async function card(work:'coding'|'writing'='coding') {return createCard('owner',{title:'Review fixture',body:'Acceptance: authorized writes',contract:{objective:'Authorized write',verification:'tests'},assignee:'builder',work,repo:'engine'});}
async function job(id:string) {return (await query('SELECT * FROM review_jobs WHERE card=$1 ORDER BY id DESC LIMIT 1',[id])).rows[0]!;}
it.each(['finish','move','runner'])('%s queues review transactionally and does not release dependencies',async path=>{
  const c=await card();const child=await createCard('owner',{title:'After deployment',assignee:'builder',deps:[c.id]});
  if(path==='finish') await as('sb_org','SELECT board_card_finish($1,$2,$3,$4,NULL,NULL,NULL,NULL,NULL)',['builder',c.id,'done','tests pass']);
  else await as('sb_org','SELECT board_card_move($1,$2,$3,NULL,NULL,NULL)',['builder',c.id,path==='runner'?'review':'done']);
  expect((await getCard(c.id)).card.status).toBe('review');expect((await getCard(child.id)).card.status).toBe('todo');
  expect((await job(c.id)).builder).toBe('builder');
  await moveCard('owner',c.id,'done');await moveCard('owner',c.id,'review');
  expect((await query('SELECT * FROM review_jobs WHERE card=$1',[c.id])).rows).toHaveLength(1);
});
it('refuses unauthorized decision, policy writes and self review at the SQL boundary',async()=>{
  const c=await card();await finishCard('builder',c.id,{outcome:'done'});const j=await job(c.id);
  await expect(as('sb_org','SELECT review_save($1,$2)',[j.id,{state:'approved'}])).rejects.toThrow(/permission denied|dedicated worker/);
  await expect(as('sb_org',"UPDATE review_policy SET reviewer='builder'")).rejects.toThrow(/permission denied/);
  await query("UPDATE org_agents SET capabilities=array_append(capabilities,'review') WHERE name='builder'");
  await query("UPDATE review_policy SET reviewer='builder'");
  await expect(as(workerName,'SELECT review_save($1,$2)',[j.id,{state:'approved'}])).rejects.toThrow(/unauthorized reviewer|self-review/);
  await query("UPDATE review_jobs SET reviewer='builder' WHERE id=$1",[j.id]);
  await expect(as(workerName,'SELECT review_save($1,$2)',[j.id,{state:'approved'}])).rejects.toThrow(/self-review/);
  await expect(as('sb_org',"SELECT review_complete($1)",[j.id])).rejects.toThrow(/permission denied|dedicated worker/);
});
it('returns same card and builder for another claimable round after rejection',async()=>{
  const c=await card();await finishCard('builder',c.id,{outcome:'done'});const j=await job(c.id);
  await as(workerName,'SELECT review_save($1,$2)',[j.id,{state:'rejected',verdict:{reviewer:'auditor',decision:'reject',head:'a'.repeat(40),evidence:'b'.repeat(64),findings:[{fix:'Check caller',verification:'Unauthorized test'}]}}]);
  const d=await getCard(c.id);expect(d.card).toMatchObject({status:'ready',assignee:'builder',rounds:1});expect(d.comments.at(-1)?.body).toContain('Check caller');
  await claimCard('builder',{agent:'builder'});await finishCard('builder',c.id,{outcome:'done'});
  expect((await job(c.id)).round).toBe(1);expect((await query('SELECT * FROM review_jobs WHERE card=$1',[c.id])).rows).toHaveLength(2);
});
it('requires merged, deployed and healthy receipts and releases dependencies only once',async()=>{
  const c=await card();const child=await createCard('owner',{title:'Waiting',assignee:'builder',deps:[c.id]});
  await finishCard('builder',c.id,{outcome:'done'});const j=await job(c.id);
  await expect(as(workerName,'SELECT review_complete($1)',[j.id])).rejects.toThrow(/receipt/);
  const revision='c'.repeat(40);
  await as(workerName,'SELECT review_save($1,$2)',[j.id,{state:'deployed',merged:revision,deployed:revision,verdict:{reviewer:'auditor',decision:'accept',head:'a'.repeat(40),evidence:'b'.repeat(64)}}]);
  await expect(as(workerName,'SELECT review_complete($1)',[j.id])).rejects.toThrow(/receipt/);
  expect((await getCard(child.id)).card.status).toBe('todo');
  await as(workerName,'SELECT review_save($1,$2)',[j.id,{health:revision}]);
  await as(workerName,'SELECT review_complete($1)',[j.id]);await as(workerName,'SELECT review_complete($1)',[j.id]);
  expect((await getCard(c.id)).card.status).toBe('done');expect((await getCard(child.id)).card.status).toBe('ready');
});
it('disabled and non-code behavior stays unchanged; ship-now cannot bypass an enabled gate',async()=>{
  const noncode=await card('writing');await finishCard('builder',noncode.id,{outcome:'done'});expect((await getCard(noncode.id)).card.status).toBe('done');
  await query('UPDATE review_policy SET enabled=false');const disabled=await card();await finishCard('builder',disabled.id,{outcome:'done'});expect((await getCard(disabled.id)).card.status).toBe('done');
  await query('UPDATE review_policy SET enabled=true');const gated=await createCard('owner',{title:'Gated',work:'coding',assignee:'builder',shipNow:true});
  expect((await shipCheck(gated.id)).ok).toBe(false);
});
it('cannot archive or relabel a submission to release its dependants',async()=>{
  const c=await card();await finishCard('builder',c.id,{outcome:'done'});
  await moveCard('owner',c.id,'archived');expect((await getCard(c.id)).card.status).toBe('review');
  await expect(query("UPDATE cards SET work_type='writing' WHERE id=$1",[c.id])).rejects.toThrow(/preserve/);
});
it('concurrent claims exclude the same job and target, then release safely after disconnect',async()=>{
  const a=new pg.Client({connectionString:asUrl(workerName)}),b=new pg.Client({connectionString:asUrl(workerName)});await a.connect();await b.connect();
  try{
    for(const key of ['review-job:1','review-target:test']){
      expect((await a.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok',[key])).rows[0].ok).toBe(true);
      expect((await b.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok',[key])).rows[0].ok).toBe(false);
    }
    await a.end();expect((await b.query("SELECT pg_try_advisory_lock(hashtextextended('review-job:1',0)) AS ok")).rows[0].ok).toBe(true);
  }finally{await a.end().catch(()=>{});await b.end();}
});

it('scopes rollout to a smoke board and independently denies shipping while reviews remain enabled',async()=>{
 await query("UPDATE review_policy SET boards=ARRAY['review-smoke'],shipping_enabled=false");
 const normal=await card();await finishCard('builder',normal.id,{outcome:'done'});expect((await getCard(normal.id)).card.status).toBe('done');
 const smoke=await createCard('owner',{title:'Smoke',assignee:'builder',work:'coding',board:'review-smoke'});
 await finishCard('builder',smoke.id,{outcome:'done'});expect((await getCard(smoke.id)).card.status).toBe('review');
 const j=await job(smoke.id);await expect(as(workerName,'SELECT review_complete($1)',[j.id])).rejects.toThrow(/shipping is disabled/);
});

it('freezes host evidence at the actual revision and refuses replacement during an active review',async()=>{
 const {stage}=await import('../src/review/stage.js');const {mkdtemp,readFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const c=await card();await finishCard('builder',c.id,{outcome:'done'});const j=await job(c.id),dir=await mkdtemp(join(tmpdir(),'review-ingest-'));
 const client=new pg.Client({connectionString:asUrl(workerName)});await client.connect();
 try{
  const a={card:c.id,head:'a'.repeat(40),result:'Checks passed',log:'npm test: 20 passed'};
  expect((await stage(client,dir,a)).staged).toBe(true);
  expect((await readFile(join(dir,c.id,'RESULT.md'),'utf8'))).toContain('Builder revision: '+a.head);
  await as(workerName,'SELECT review_save($1,$2)',[j.id,{state:'approved',snapshot:{head:a.head}}]);
  expect((await stage(client,dir,a)).staged).toBe(true);
  expect((await stage(client,dir,{...a,log:'Changed evidence'})).staged).toBe(false);
  await as(workerName,'SELECT review_save($1,$2)',[j.id,{state:'blocked',snapshot:null,verdict:null,error:'Stale head invalidated'}]);
  expect((await stage(client,dir,{...a,head:'b'.repeat(40),log:'New revision evidence'})).staged).toBe(true);
 }finally{await client.end();await rm(dir,{recursive:true,force:true});}
});

it('limits a staged rollout by registered repository while recognizing runner engine headers',async()=>{
 await query("UPDATE review_policy SET repositories=ARRAY['engine']");
 const excluded=await createCard('owner',{title:'Unrelated',assignee:'builder',work:'coding',repo:'other'});await finishCard('builder',excluded.id,{outcome:'done'});expect((await getCard(excluded.id)).card.status).toBe('done');
 const included=await createCard('owner',{title:'Engine via session',assignee:'m4',work:'coding',repo:'vault',body:'Repo: engine\nDone when: tests pass'});
 await finishCard('m4',included.id,{outcome:'done'});expect((await getCard(included.id)).card.status).toBe('review');
});

it('escalates exhausted correction rounds without approving or releasing work',async()=>{
 await query('UPDATE review_policy SET max_rounds=0');const c=await card();await finishCard('builder',c.id,{outcome:'done'});const j=await job(c.id);
 await as(workerName,'SELECT review_save($1,$2)',[j.id,{state:'rejected',verdict:{reviewer:'auditor',decision:'reject',head:'a'.repeat(40),evidence:'b'.repeat(64),findings:[{fix:'Fix authorization',verification:'Denial test'}]}}]);
 expect((await getCard(c.id)).card).toMatchObject({status:'blocked',block_kind:'review-changes'});
 expect((await as(workerName,'SELECT review_builder_retries() AS cards')).rows[0].cards).toEqual([]);
});

it.each([false,true])('a builder cannot escape review by changing repository and classification before submitting (%s)',async reclassify=>{
 await query("UPDATE review_policy SET repositories=ARRAY['engine']");const c=await card();const dependant=await createCard('owner',{title:'Wait for acceptance',assignee:'builder',deps:[c.id]});
 const change=as('sb_org',"SELECT board_card_assign('builder',$1,'builder',NULL,NULL,$2,NULL,'other')",[c.id,reclassify?'writing':null]);
 if(reclassify)await expect(change).rejects.toThrow(/classification cannot bypass/);else await change;
 await as('sb_org',"SELECT board_card_finish('builder',$1,'done','tests pass',NULL,NULL,NULL,NULL,NULL)",[c.id]);
 expect((await getCard(c.id)).card.status).toBe('review');expect((await getCard(dependant.id)).card.status).toBe('todo');expect(await job(c.id)).toBeDefined();
});
it('does not retroactively submit historical completed cards on metadata updates',async()=>{
 await query('UPDATE review_policy SET enabled=false');const c=await card();await finishCard('builder',c.id,{outcome:'done'});
 await query('UPDATE review_policy SET enabled=true');await query("UPDATE cards SET result='Historical clarification' WHERE id=$1",[c.id]);
 expect((await getCard(c.id)).card.status).toBe('done');expect((await query('SELECT * FROM review_jobs WHERE card=$1',[c.id])).rows).toHaveLength(0);
});
