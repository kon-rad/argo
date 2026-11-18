import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { expect, it } from 'vitest';
import { SkillsService } from '../src/addons/skills/service.js';
import { scanPackage } from '../src/addons/skills/package.js';
import { skillsRouter } from '../src/addons/skills/routes.js';
import { errorHandlerFor } from '../src/routes/http.js';
import { SETTINGS, sh, skillMd, skillsFixture, write } from './helpers/skills.js';

function fixture() {
  const f=skillsFixture();
  const service=new SkillsService(f.vault,SETTINGS,{engineSkills:f.engine,db:false,observations:async()=>({acks:[],hosts:[],lastSeen:new Map()})});
  const app=express();app.use(express.json());app.use('/api/skills',skillsRouter(service));app.use(errorHandlerFor(false));
  return {f,service,app};
}

it.each([
  'metadata:\n  depends: report\n',
  'metadata:\n  requires:\n    bins: node\n',
  'metadata:\n  requires:\n    env: PROGRAM_KEY\n',
])('validates historical rollback metadata before preview, export and apply: %s', async metadata=>{
  const {f,service}=fixture();
  const initial=sh(f.vault,'rev-parse','HEAD');
  const path=join(f.vault,'.agents','skills','report','SKILL.md');
  const malformed=skillMd('report','Invalid historical package.',metadata);
  write(path,malformed);sh(f.vault,'commit','-qam','historical invalid metadata');
  const invalid=sh(f.vault,'rev-parse','HEAD');
  const current=skillMd('report','Current valid package.');
  write(path,current);sh(f.vault,'commit','-qam','current valid metadata');service.invalidate();
  const preview=await service.preview({kind:'rollback',skill:'report',revision:invalid});
  expect(preview.validation.valid).toBe(false);
  expect(preview.validation.errors.join(' ')).toMatch(/depends|requires|bins|env/);
  expect(preview.blocked.join(' ')).toMatch(/historical package does not validate/);
  await expect(service.propose({kind:'rollback',skill:'report',revision:invalid})).rejects.toThrow(/does not validate/);
  // A stored export with a forged matching digest must still pass actual package/metadata validation.
  const exported=await service.propose({kind:'rollback',skill:'report',revision:initial});
  const dir=join(f.vault,SETTINGS.changesDir,exported.id);
  write(join(dir,'package','SKILL.md'),malformed);
  const scan=scanPackage(join(dir,'package'));expect(scan.ok).toBe(true);
  const stored=JSON.parse(readFileSync(join(dir,'change.json'),'utf8'));
  stored.preview.targetDigest=scan.ok?scan.digest:null;stored.preview.validation={valid:true,errors:[],warnings:[]};
  writeFileSync(join(dir,'change.json'),JSON.stringify(stored));
  await expect(service.apply(exported.id)).rejects.toThrow(/stored package.*(?:depends|requires|bins|env)/);
  expect(readFileSync(path,'utf8')).toBe(current);
  expect(sh(f.vault,'branch','--list',`skills/${exported.id}`)).toBe('');
});

it('rejects a stale owner save with409 and preserves the first save until an explicit refreshed merge', async()=>{
  const {f,service,app}=fixture();await service.createDraft('report','report');
  const url='/api/skills/drafts/report/file';
  const first=await request(app).get(url).query({path:'SKILL.md'});
  const second=await request(app).get(url).query({path:'SKILL.md'});
  expect(first.status).toBe(200);expect(first.body.version).toMatch(/^[0-9a-f]{64}$/);expect(second.body.version).toBe(first.body.version);
  const winner=skillMd('report','First owner save.');
  expect((await request(app).put(url).send({path:'SKILL.md',content:winner,expectedVersion:first.body.version})).status).toBe(200);
  const stale=await request(app).put(url).send({path:'SKILL.md',content:skillMd('report','Stale owner save.'),expectedVersion:second.body.version});
  expect(stale.status).toBe(409);expect(stale.body.error.message).toMatch(/changed since you loaded/);
  const file=join(f.vault,SETTINGS.draftsDir,'report','SKILL.md');expect(readFileSync(file,'utf8')).toBe(winner);
  expect((await request(app).put(url).send({path:'SKILL.md',content:'Missing precondition'})).status).toBe(400);
  await expect(service.writeDraftFile('report','SKILL.md','Missing token')).rejects.toMatchObject({status:428});
  expect(readFileSync(file,'utf8')).toBe(winner);
  const refreshed=await request(app).get(url).query({path:'SKILL.md'});
  expect(refreshed.body.content).toBe(winner);expect(refreshed.body.version).not.toBe(first.body.version);
  const merged=skillMd('report','Explicitly reviewed merge.');
  expect((await request(app).put(url).send({path:'SKILL.md',content:merged,expectedVersion:refreshed.body.version})).status).toBe(200);
  expect(readFileSync(file,'utf8')).toBe(merged);
});

it('uses null only as an absent-file precondition and refuses a racing second creation', async()=>{
  const {service,app}=fixture();await service.createDraft('report','report');
  const url='/api/skills/drafts/report/file', path='references/new.md';
  expect((await request(app).put(url).send({path,content:'First creation',expectedVersion:null})).status).toBe(200);
  expect((await request(app).put(url).send({path,content:'Second creation',expectedVersion:null})).status).toBe(409);
  expect((await service.readDraftFile('report',path)).content).toBe('First creation');
});

it('can match a proposal through an uncommitted local edit without establishing a merge',async()=>{
  const {f,service}=fixture();await service.createDraft('report','report');
  const next=skillMd('report','Uncommitted catalog match.');
  await service.writeDraftFile('report','SKILL.md',next,undefined,(await service.readDraftFile('report','SKILL.md')).version);
  const proposed=await service.propose({kind:'update',skill:'report',draft:'report'});
  write(join(f.vault,'.agents','skills','report','SKILL.md'),next);service.invalidate();
  expect((await service.changes()).find(x=>x.id===proposed.id)!.status).toBe('pending');
  expect(sh(f.vault,'status','--porcelain','--','.agents/skills/report')).toContain('SKILL.md');
  expect(proposed.commit).toBeNull();
});

it('rejects an exec-only stale save even when file bytes and their sha256 are unchanged',async()=>{
  const {service,app}=fixture();await service.createDraft('report','report');
  const url='/api/skills/drafts/report/file';
  const loaded=(await request(app).get(url).query({path:'SKILL.md'})).body;
  expect(loaded.exec).toBe(false);
  const first=await request(app).put(url).send({path:'SKILL.md',content:loaded.content,exec:true,expectedVersion:loaded.version});
  expect(first.status).toBe(200);
  const current=(await request(app).get(url).query({path:'SKILL.md'})).body;
  expect(current.sha256).toBe(loaded.sha256);expect(current.version).not.toBe(loaded.version);expect(current.exec).toBe(true);
  expect(first.body.draft.files.find((f:{path:string})=>f.path==='SKILL.md').version).toBe(current.version);
  const stale=await request(app).put(url).send({path:'SKILL.md',content:loaded.content,exec:false,expectedVersion:loaded.version});
  expect(stale.status).toBe(409);
  const preserved=await service.readDraftFile('report','SKILL.md');
  expect(preserved.content).toBe(loaded.content);expect(preserved.exec).toBe(true);expect(preserved.version).toBe(current.version);
});
