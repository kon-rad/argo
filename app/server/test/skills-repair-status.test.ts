import { reviewedPlanViews as planViews } from './helpers/skills-reviewed.js';
import {chmodSync,readFileSync,rmSync,symlinkSync,writeFileSync,statSync,renameSync,readlinkSync} from 'node:fs';
import {join} from 'node:path';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {AckRequestSchema} from '@secondbrain/contracts/skills';
import {query} from '../src/db.js';
import {addDevice} from '../src/ingest/devices.js';
import {truncateAll} from './helpers.js';
import {SkillsService} from '../src/addons/skills/service.js';
import {runSkillsCli} from '../src/addons/skills/cli.js';
import {recordAck,readAcks} from '../src/addons/skills/machines.js';
import {ackPayload,inspectRoot,readCurrent,syncViews,verifyView} from '../src/addons/skills/reconcile.js';
import {skillsFixture,SETTINGS,MANAGED_POLICY,write} from './helpers/skills.js';
beforeEach(truncateAll);
afterEach(async()=>{
 for(const table of ['skill_view_acks','skill_ack_log','ingest_devices'])await query(`DELETE FROM ${table} WHERE host=$1`,['broken-view-fixture']);
 await query('DELETE FROM usage_hosts WHERE slug=$1',['broken-view-fixture']);
});
async function fixture(){
 const f=skillsFixture();write(join(f.vault,SETTINGS.policyFile),MANAGED_POLICY);
 const service=new SkillsService(f.vault,SETTINGS,{engineSkills:f.engine,db:false,observations:async()=>({acks:[],hosts:[],lastSeen:new Map()})});
 const state=await service.current();const plan=planViews(state.catalog,state.policy,state.roster,{agents:['alpha']});
 const root=join(f.base,'managed');const report=syncViews(root,plan);
 return {f,service,plan,root,report};
}
it.each(['first staging','later staging','activation'])('preserves the old readable deployment after a failed repair during %s',async phase=>{
 const {plan,root}=await fixture();const first=plan.views[0]!.skills[0]!;
 const old=readCurrent(root,'alpha','zen-agent').dir;
 const file=join(root,'store',first.digest.slice(7),'SKILL.md');chmodSync(file,0o600);writeFileSync(file,'# Owner modified deployment');
 if(phase!=='activation'){
  const failing=phase==='first staging'?first:plan.views[0]!.skills[1]!;
  if(phase==='later staging'){
   // Force the later package through staging too, after the first repair has been installed.
   const later=join(root,'store',failing.digest.slice(7),'SKILL.md');chmodSync(later,0o644);writeFileSync(later,'# Later dirty package');
  }
  const src=plan.packages.get(failing.digest)!;
  plan.packages.set(failing.digest,{files:src.files.map(f=>({...f,read:()=>{throw new Error('Source could not be staged');}}))});
 }
 const report=syncViews(root,plan,{repair:true,hooks:phase==='activation'?{beforeActivate:()=>{throw new Error('Activation refused');}}:{}});
 expect(report.views[0]!.status).toBe('failed');expect(readCurrent(root,'alpha','zen-agent').dir).toBe(old);
 expect(readFileSync(file,'utf8')).toBe('# Owner modified deployment');expect(statSync(file).mode&0o777).toBe(0o600);
 expect(readFileSync(join(old!,first.name,'SKILL.md'),'utf8')).toBe('# Owner modified deployment');
 expect(verifyView(root,'alpha','zen-agent').dirty).toContain(first.name);
});
it.each(['manifest removed','broken link','link removed','invalid manifest','views removed'])('fails status and updates acknowledgements for %s',async corruption=>{
 const {service,plan,root,report}=await fixture();
 const device=await addDevice('broken-view-fixture',{display:'Broken view fixture',kind:'server'});
 await recordAck({id:device.id,host:'broken-view-fixture'},ackPayload(report,null));
 const link=join(root,'views','alpha','zen-agent'),manifest=join(link,'manifest.json');
 if(corruption==='manifest removed')rmSync(manifest);
 if(corruption==='broken link'){rmSync(link);symlinkSync('zen-agent.missing',link);}
 if(corruption==='link removed')rmSync(link);
 if(corruption==='invalid manifest'){const m=JSON.parse(readFileSync(manifest,'utf8'));m.runtime='codex';writeFileSync(manifest,JSON.stringify(m));}
 if(corruption==='views removed')rmSync(join(root,'views'),{recursive:true,force:true});
 const lines:string[]=[];
 const io={out:(s:string)=>lines.push(s),err:(s:string)=>lines.push(s),env:{PATH:'',SB_LEDGER_TOKEN:device.token},fetch:async(_url:unknown,init?:RequestInit)=>{
  const payload=AckRequestSchema.parse(JSON.parse(String(init!.body)));expect(payload.views[0]!.status).toBe('failed');
  const result=await recordAck({id:device.id,host:'broken-view-fixture'},payload);return new Response(JSON.stringify(result),{status:200});
 }};
 expect(await runSkillsCli(['status','--root',root],service,io)).toBe(2);expect(lines.join(' ')).toMatch(/failed/);
 expect(await runSkillsCli(['ack','--root',root,'--server','https://brain.example.com'],service,io)).toBe(0);
 const observed=(await readAcks()).acks.find(a=>a.host==='broken-view-fixture')!;
 expect(observed.status).toBe('failed');expect(observed.skills).toEqual([]);
});

it('reports dirty non-skill view entries without making the acknowledgement invalid',async()=>{
 const {root}=await fixture();writeFileSync(join(root,'views','alpha','zen-agent','.DS_Store'),'Synthetic OS metadata');
 const views=inspectRoot(root);expect(views[0]!.status).toBe('dirty');expect(views[0]!.error).toContain('.DS_Store');
 expect(()=>AckRequestSchema.parse(ackPayload({policyDigest:null,views},null))).not.toThrow();
});
it('refuses an oversized per-agent view before replacing its active generation',async()=>{
 const {root,plan}=await fixture(),before=readCurrent(root,'alpha','zen-agent').dir;
 plan.views[0]!.skills=Array.from({length:501},(_,i)=>({...plan.views[0]!.skills[0]!,name:`skill-${i}`}));
 expect(()=>syncViews(root,plan)).toThrow(/at most 500 skills/);
 expect(readCurrent(root,'alpha','zen-agent').dir).toBe(before);
});

it('does not follow a dirty store root link or change outside permissions during repair rollback',async()=>{
 const {f,root,plan}=await fixture();const skill=plan.views[0]!.skills[0]!;
 const entry=join(root,'store',skill.digest.slice(7)),outside=join(f.base,'outside-package');chmodSync(entry,0o755);renameSync(entry,outside);
 chmodSync(outside,0o700);const file=join(outside,'SKILL.md');chmodSync(file,0o600);writeFileSync(file,'# External sentinel');symlinkSync(outside,entry);
 const report=syncViews(root,plan,{repair:true,hooks:{beforeActivate:()=>{throw new Error('Activation refused');}}});
 expect(report.views[0]!.status).toBe('failed');expect(readlinkSync(entry)).toBe(outside);
 expect(readFileSync(file,'utf8')).toBe('# External sentinel');expect(statSync(file).mode&0o777).toBe(0o600);expect(statSync(outside).mode&0o777).toBe(0o700);
});
