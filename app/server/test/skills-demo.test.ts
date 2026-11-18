import {spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {query} from '../src/db.js';
import {truncateAll} from './helpers.js';
import {SkillsService} from '../src/addons/skills/service.js';
import express from 'express';
import request from 'supertest';
import {skillsRouter} from '../src/addons/skills/routes.js';
import {SETTINGS} from './helpers/skills.js';
const parent=()=>mkdtempSync(join(tmpdir(),'skills-demo-safe-'));
const app=resolve(import.meta.dirname,'../..');
const run=(dir:string,db=false)=>spawnSync(process.execPath,['--import','tsx','server/test/helpers/skills-demo.ts',dir,...(db?['--db']:[])],{cwd:app,env:process.env,encoding:'utf8',timeout:20000});
beforeEach(truncateAll);
afterEach(async()=>{
 for(const table of ['skill_view_acks','skill_ack_log','ingest_devices'])await query(`DELETE FROM ${table} WHERE host=ANY($1)`,[['demo-current','demo-drift','demo-never','demo-not-ready']]);
 await query('DELETE FROM usage_hosts WHERE slug=ANY($1)',[['demo-current','demo-drift','demo-never','demo-not-ready']]);
});
it('refuses an existing target without touching a sentinel, and creates a fresh target',()=>{
 const dir=parent(),file=join(dir,'sentinel.txt');writeFileSync(file,'Preserve this directory');
 const refused=run(dir);expect(refused.status).not.toBe(0);expect(refused.stderr).toMatch(/already exists/);expect(readFileSync(file,'utf8')).toBe('Preserve this directory');
 const fresh=join(parent(),'new-fixture');const created=run(fresh);expect(created.status,created.stderr).toBe(0);expect(existsSync(join(fresh,'full/vault/secondbrain.json'))).toBe(true);
});
it('produces current, drifted, not-ready and never-seen machine states from the generated demo',async()=>{
 const dir=join(parent(),'new-fixture');const result=run(dir,true);expect(result.status,result.stderr).toBe(0);
 const vault=join(dir,'full/vault');
 const service=new SkillsService(vault,{...SETTINGS,externalRoots:[{id:'demo-engine',path:join(dir,'full/engine/skills')}]});
 const app=express();app.use('/api/skills',skillsRouter(service));
 const response=await request(app).get('/api/skills/machines');expect(response.status,response.text).toBe(200);
 const states=Object.fromEntries(response.body.hosts.map((h:{host:string;status:string})=>[h.host,h.status]));
 expect(states).toMatchObject({'demo-current':'current','demo-drift':'drift','demo-never':'never','demo-not-ready':'not-ready'});
});
