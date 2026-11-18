import { existsSync,lstatSync,readFileSync,rmSync,symlinkSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { expect,it } from 'vitest';
import { SkillsService } from '../src/addons/skills/service.js';
import { skillsRouter } from '../src/addons/skills/routes.js';
import { errorHandlerFor } from '../src/routes/http.js';
import { MANAGED_POLICY,SETTINGS,sh,skillsFixture,write } from './helpers/skills.js';
function fixture(){
 const f=skillsFixture();write(join(f.vault,SETTINGS.policyFile),MANAGED_POLICY);sh(f.vault,'add','-A');sh(f.vault,'commit','-qm','managed policy');
 const make=(policyFile=SETTINGS.policyFile)=>new SkillsService(f.vault,{...SETTINGS,policyFile},{engineSkills:f.engine,db:false,observations:async()=>({acks:[],hosts:[],lastSeen:new Map()})});
 const service=make();const app=express();app.use(express.json());app.use('/api/skills',skillsRouter(service));app.use(errorHandlerFor(false));return{f,make,service,app};
}
it.each(['external','linked','directory'] as const)('refuses %s policy destinations before propose/apply and preserves external files',async kind=>{
 const {f,make,service}=fixture();const change=await service.propose({kind:'disable',skill:'video'});
 const outside=join(f.outside,'policy','skills.yaml');write(outside,MANAGED_POLICY,0o600);
 const configured=kind==='external'?outside:kind==='linked'?'.agents/policy-link/skills.yaml':'.agents/policy-dir';
 if(kind==='linked')symlinkSync(join(f.outside,'policy'),join(f.vault,'.agents','policy-link'));
 if(kind==='directory')write(join(f.vault,configured,'child.md'),'sentinel');
 const unsafe=make(configured);const before=readFileSync(outside),mode=lstatSync(outside).mode;
 await expect(unsafe.preview({kind:'disable',skill:'video'})).rejects.toThrow(/policy|linked|regular|EISDIR/);
 await expect(unsafe.propose({kind:'disable',skill:'video'})).rejects.toThrow(/policy|linked|regular|EISDIR/);
 await expect(unsafe.apply(change.id)).rejects.toThrow(/policy|linked|regular|EISDIR/);
 expect(readFileSync(outside)).toEqual(before);expect(lstatSync(outside).mode).toBe(mode);
 expect(sh(f.vault,'branch','--list',`skills/${change.id}`)).toBe('');
});
it('refuses a policy parent linked in Git when the current checkout parent is regular',async()=>{
 const {f,make}=fixture();const rel='.agents/policies/skills.yaml',parent=join(f.vault,'.agents','policies');
 write(join(f.vault,rel),MANAGED_POLICY);sh(f.vault,'add',rel);sh(f.vault,'commit','-qm','regular policy');
 const service=make(rel),change=await service.propose({kind:'disable',skill:'video'});
 const outside=join(f.outside,'policy','skills.yaml');write(outside,MANAGED_POLICY,0o600);
 rmSync(parent,{recursive:true});symlinkSync(join(f.outside,'policy'),parent);sh(f.vault,'add','-A','--','.agents/policies');sh(f.vault,'commit','-qm','linked parent');
 rmSync(parent);write(join(f.vault,rel),MANAGED_POLICY);service.invalidate();
 await expect(service.apply(change.id)).rejects.toThrow(/policy.*linked|ancestor.*linked/);
 expect(readFileSync(outside,'utf8')).toBe(MANAGED_POLICY);expect(lstatSync(outside).mode&0o777).toBe(0o600);
});
it('requires a loaded removal version and preserves a racing save until refreshed deletion',async()=>{
 const {service,app}=fixture();await service.createDraft('report','report');const path='references/note.md',url='/api/skills/drafts/report/file';
 await service.writeDraftFile('report',path,'Original',false,null);const loaded=(await request(app).get(url).query({path})).body;
 expect((await request(app).delete(url).query({path}).send({})).status).toBe(400);
 await expect(service.deleteDraftFile('report',path)).rejects.toMatchObject({status:428});
 expect((await request(app).delete(url).query({path}).send({expectedVersion:null})).status).toBe(400);
 await service.writeDraftFile('report',path,'Winner',true,loaded.version);
 expect((await request(app).delete(url).query({path}).send({expectedVersion:loaded.version})).status).toBe(409);
 const current=await service.readDraftFile('report',path);expect(current.content).toBe('Winner');expect(current.exec).toBe(true);
 expect((await request(app).delete(url).query({path}).send({expectedVersion:current.version})).status).toBe(200);
 await expect(service.readDraftFile('report',path)).rejects.toMatchObject({status:404});
});
it('serializes removal with saves and rejects exec-only stale removal',async()=>{
 const {f,service}=fixture();await service.createDraft('report','report');const path='references/note.md';
 await service.writeDraftFile('report',path,'Same bytes',false,null);const loaded=await service.readDraftFile('report',path);
 await service.writeDraftFile('report',path,'Same bytes',true,loaded.version);
 await expect(service.deleteDraftFile('report',path,loaded.version)).rejects.toMatchObject({status:409});
 const current=await service.readDraftFile('report',path);expect(current.sha256).toBe(loaded.sha256);expect(current.exec).toBe(true);
 const lock=join(f.vault,SETTINGS.draftsDir,'report.write.lock');write(lock,'active');
 try{await expect(service.deleteDraftFile('report',path,current.version)).rejects.toMatchObject({status:409});await expect(service.writeDraftFile('report',path,'New',false,current.version)).rejects.toMatchObject({status:409});expect(existsSync(join(f.vault,SETTINGS.draftsDir,'report',path))).toBe(true);}finally{rmSync(lock);}
 expect((await service.readDraftFile('report',path)).content).toBe('Same bytes');
});
