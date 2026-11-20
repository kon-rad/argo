import { existsSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createAuth } from '../src/auth/router.js';
import { hashPassword } from '../src/auth/password.js';
import { codeAt, currentStep, generateSecret } from '../src/auth/totp.js';
import { query } from '../src/db.js';
import { addDevice } from '../src/ingest/devices.js';
import { errorHandler } from '../src/routes/http.js';
import { authorizeRouter, skillsRouter } from '../src/addons/skills/routes.js';
import { runSkillsCli, type CliIo } from '../src/addons/skills/cli.js';
import { planFingerprint, proposeViews, type Plan } from '../src/addons/skills/reconcile.js';
import { SkillsService } from '../src/addons/skills/service.js';
import type { PolicyProvenance } from '../src/addons/skills/policy-review.js';
import { SETTINGS, sh, skillsFixture, write } from './helpers/skills.js';

const HOST='skills-policy-auth';
const ORIGIN='https://skills.example.test';
const PASSWORD='fixture owner passphrase for tests only';
const AGENT='skills-policy-authorization-test';
let passwordHash:string, clock=Date.now();
beforeAll(async()=>{passwordHash=await hashPassword(PASSWORD);});
afterEach(async()=>{
  await query('DELETE FROM ingest_devices WHERE host=$1',[HOST]);
  await query('DELETE FROM usage_hosts WHERE slug=$1',[HOST]);
  await query('DELETE FROM auth_sessions WHERE user_agent=$1',[AGENT]);
  vi.restoreAllMocks();
});

async function fixture() {
  const f=skillsFixture();
  const text='version: 1\nmode: managed\norg: {grant: [report]}\n';
  write(join(f.vault,SETTINGS.policyFile),text);
  sh(f.vault,'add',SETTINGS.policyFile);sh(f.vault,'commit','-qm','Committed policy');
  sh(f.vault,'remote','add','origin','https://github.com/example/policy-vault.git');
  const revision=sh(f.vault,'rev-parse','HEAD');
  sh(f.vault,'update-ref','refs/remotes/origin/main',revision);
  sh(f.vault,'symbolic-ref','refs/remotes/origin/HEAD','refs/remotes/origin/main');
  let latest:PolicyProvenance|null=null;
  const writes:PolicyProvenance[]=[];
  // A trusted test-only approval provider isolates HTTP authority from DB ACL tests.
  // Production uses the operational table; separate service tests exercise its role grants.
  const service=new SkillsService(f.vault,{...SETTINGS,authorityOrigin:ORIGIN},{engineSkills:f.engine,db:false,reviewReceipts:async()=>[],policyApprovals:{
    read:async()=>latest?[latest]:[],write:async receipt=>{latest=receipt;writes.push(receipt);},
  }});
  const state=await service.current();
  const body={digest:state.policy.digest!,revision,source:'Owner decision fixture'};
  const secret=generateSecret();
  const auth=createAuth({passwordHash,totpSecret:secret,publicOrigin:ORIGIN,secureCookie:false,now:()=>clock});
  const app=express();
  app.use('/api/skills/authorize',authorizeRouter(service));
  app.use(express.json());app.use('/api',auth.checkOrigin);app.use('/api/auth',auth.router);app.use('/api',auth.requireSession);
  app.use('/api/skills',skillsRouter(service,'fixture-owner'));app.use(errorHandler);
  const device=await addDevice(HOST,{display:'Skills authorization fixture',kind:'server'});
  const owner=async()=>{
    clock+=30_000;
    const result=await request(app).post('/api/auth/login').set('Origin',ORIGIN).set('User-Agent',AGENT).send({password:PASSWORD,code:codeAt(secret,currentStep(clock))});
    expect(result.status,result.text).toBe(200);
    return result.headers['set-cookie'][0]!.split(';')[0]! as string;
  };
  const approve=()=>service.approvePolicy({...body,approvedBy:'fixture-owner'});
  const proposal=async(agents=['alpha'],runtime:'zen-agent'|'codex'='zen-agent')=>{
    const current=await service.current(true);
    return proposeViews(current.catalog,current.policy,current.roster,{agents,runtime});
  };
  const bridge=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=new URL(String(input));
    const result=await request(app).post(url.pathname).set(Object.fromEntries(new Headers(init?.headers).entries())).send(init?.body as string);
    return new Response(JSON.stringify(result.body),{status:result.status,headers:{'Content-Type':'application/json'}});
  }) as unknown as typeof fetch;
  const io=():CliIo=>({out:vi.fn(),err:vi.fn(),env:{PATH:process.env.PATH??'',SB_LEDGER_TOKEN:device.token,SECONDBRAIN_SERVER:ORIGIN},fetch:bridge});
  return{f,service,app,body,device,owner,approve,proposal,bridge,io,writes,text,revoke:()=>{latest=null;}};
}
const authorization=(plan:Plan)=>({policyDigest:plan.policyDigest,fingerprint:planFingerprint(plan),views:plan.views.map(({agent,runtime})=>({agent,runtime}))});

it('authenticates authorization before parsing and bounds its device-only request',async()=>{
  const x=await fixture(),plan=await x.proposal(),body=authorization(plan);
  const check=vi.spyOn(x.service,'reviewedPolicy');
  expect((await request(x.app).post('/api/skills/authorize').set('Content-Type','application/json').send('{')).status).toBe(401);
  expect((await request(x.app).post('/api/skills/authorize').set('Content-Type','application/json').send('x'.repeat(40*1024))).status).toBe(401);
  expect(check).not.toHaveBeenCalled();
  const bearer={Authorization:`Bearer ${x.device.token}`};
  expect((await request(x.app).post('/api/skills/authorize').set(bearer).send({...body,extra:'x'.repeat(40*1024)})).status).toBe(413);
  expect((await request(x.app).post('/api/skills/authorize').set(bearer).send({...body,reviewed:true})).status).toBe(400);
  expect((await request(x.app).post('/api/skills/authorize').set(bearer).send({...body,views:[]})).status).toBe(400);
  expect((await request(x.app).post('/api/skills/authorize').set(bearer).send({...body,views:[body.views[0],body.views[0]]})).status).toBe(422);
  expect(check).not.toHaveBeenCalled();
  await query('UPDATE ingest_devices SET revoked_at=now() WHERE id=$1',[x.device.id]);
  expect((await request(x.app).post('/api/skills/authorize').set(bearer).send(body)).status).toBe(401);
});

it('requires owner session approval and derives the approving identity from trusted owner configuration',async()=>{
  const x=await fixture(),plan=await x.proposal(),bearer={Authorization:`Bearer ${x.device.token}`};
  expect((await request(x.app).post('/api/skills/authorize').set(bearer).send(authorization(plan))).status).toBe(409);
  expect((await request(x.app).post('/api/skills/policy/approve').set('Origin',ORIGIN).set(bearer).send(x.body)).status).toBe(401);
  expect(x.writes).toHaveLength(0);
  const cookie=await x.owner();
  expect((await request(x.app).post('/api/skills/policy/approve').set('Origin',ORIGIN).set('Cookie',cookie).send({...x.body,source:'x'.repeat(201)})).status).toBe(400);
  expect((await request(x.app).post('/api/skills/policy/approve').set('Origin',ORIGIN).set('Cookie',cookie).send({...x.body,approvedBy:'other-reviewer'})).status).toBe(400);
  const approved=await request(x.app).post('/api/skills/policy/approve').set('Origin',ORIGIN).set('Cookie',cookie).send(x.body);
  expect(approved.status,approved.text).toBe(201);expect(approved.body.approval.approvedBy).toBe('fixture-owner');expect(x.writes).toHaveLength(1);
  const authorized=await request(x.app).post('/api/skills/authorize').set(bearer).send(authorization(plan));
  expect(authorized.status,authorized.text).toBe(200);expect(authorized.body).toEqual({policyDigest:plan.policyDigest,fingerprint:planFingerprint(plan)});
  expect(readFileSync(join(x.f.vault,SETTINGS.policyFile),'utf8')).toBe(x.text);
});

it('requires online canonical authorization for CLI pack/sync and filters bundle selections before verification',async()=>{
  const x=await fixture(),root=join(x.f.base,'managed'),output=join(x.f.base,'bundle.json');await x.approve();
  const offline=x.io();delete offline.env.SECONDBRAIN_SERVER;
  expect(await runSkillsCli(['sync','--agents','alpha','--root',root,'--skip'],x.service,offline)).toBe(1);expect(existsSync(root)).toBe(false);
  expect(await runSkillsCli(['pack','--agents','alpha','--out',output],x.service,offline)).toBe(1);expect(existsSync(output)).toBe(false);
  expect(await runSkillsCli(['sync','--agents','alpha','--dry-run','--root',root],x.service,offline)).toBe(1);expect(existsSync(root)).toBe(false);
  const noToken=x.io();delete noToken.env.SB_LEDGER_TOKEN;expect(await runSkillsCli(['sync','--agents','alpha','--root',root],x.service,noToken)).toBe(1);
  expect(x.bridge).not.toHaveBeenCalled();
  const io=x.io();expect(await runSkillsCli(['pack','--agents','alpha,beta','--runtime','codex','--out',output],x.service,io)).toBe(0);
  expect(statSync(output).mode&0o777).toBe(0o600);
  expect(await runSkillsCli(['sync','--bundle',output,'--agents','alpha','--runtime','codex','--root',root],x.service,io)).toBe(0);
  const calls=(x.bridge as ReturnType<typeof vi.fn>).mock.calls;
  const body=JSON.parse(calls.at(-1)![1].body);
  expect(body.views).toEqual([{agent:'alpha',runtime:'codex'}]);
  expect(existsSync(join(root,'views','alpha','codex'))).toBe(true);expect(existsSync(join(root,'views','beta'))).toBe(false);
  const callsBefore=calls.length;
  expect(await runSkillsCli(['sync','--bundle',output,'--agents','unknown','--root',join(x.f.base,'empty')],x.service,io)).toBe(1);
  expect((io.err as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]).toMatch(/No agent\/runtime views/);
  expect((x.bridge as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(callsBefore);
});

it('refuses tampered bundles, dirty policy and revoked approval without switching installed views',async()=>{
  const x=await fixture(),root=join(x.f.base,'managed'),output=join(x.f.base,'bundle.json');await x.approve();const io=x.io();
  expect(await runSkillsCli(['sync','--agents','alpha','--root',root],x.service,io)).toBe(0);
  const active=join(root,'views','alpha','zen-agent'),before=readlinkSync(active);
  expect(await runSkillsCli(['pack','--agents','alpha','--out',output],x.service,io)).toBe(0);
  const tampered=JSON.parse(readFileSync(output,'utf8'));tampered.authorized=true;tampered.reviewed=true;tampered.views[0].skills[0].description='Unreviewed replacement metadata';
  const changed=join(x.f.base,'tampered.json');writeFileSync(changed,JSON.stringify(tampered));
  expect(await runSkillsCli(['sync','--bundle',changed,'--root',root],x.service,io)).toBe(1);expect(readlinkSync(active)).toBe(before);
  write(join(x.f.vault,SETTINGS.policyFile),x.text+'# uncommitted policy edit\n');
  expect(await runSkillsCli(['sync','--agents','alpha','--root',root],x.service,io)).toBe(1);expect(readlinkSync(active)).toBe(before);
  write(join(x.f.vault,SETTINGS.policyFile),x.text);x.revoke();
  expect(await runSkillsCli(['sync','--bundle',output,'--root',root],x.service,io)).toBe(1);expect(readlinkSync(active)).toBe(before);
});

it('maps explicit CLI owner approval and refuses device-only approval without owner database authority',async()=>{
  const x=await fixture(),io=x.io();
  const args=['approve-policy','--digest',x.body.digest,'--revision',x.body.revision,'--source','Owner CLI decision','--reviewer','operator'];
  expect(await runSkillsCli(args,x.service,io)).toBe(0);expect(x.writes[0]).toMatchObject({source:'Owner CLI decision',approvedBy:'operator'});
  const unprivileged=new SkillsService(x.f.vault,SETTINGS,{engineSkills:x.f.engine,db:false,reviewReceipts:async()=>[]});
  expect(await runSkillsCli(args,unprivileged,io)).toBe(1);
  expect((io.err as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]).toMatch(/database/);
  expect(await runSkillsCli(['approve-policy','--digest',x.body.digest],x.service,io)).toBe(1);
});
