import {join} from 'node:path';
import {beforeEach,it,expect} from 'vitest';
import {AckRequestSchema} from '@secondbrain/contracts/skills';
import {query} from '../src/db.js';
import {addDevice} from '../src/ingest/devices.js';
import {SkillsService} from '../src/addons/skills/service.js';
import {readMeta} from '../src/addons/skills/package.js';
import {recordAck,readAcks,machineStates} from '../src/addons/skills/machines.js';
import {ackPayload,inspectRoot,planViews,readCurrent,syncViews} from '../src/addons/skills/reconcile.js';
import {truncateAll} from './helpers.js';
import {skillsFixture,SETTINGS,MANAGED_POLICY,skillMd,write} from './helpers/skills.js';
beforeEach(truncateAll);
const metadata=[
 'metadata:\n  depends: report\n',
 'metadata:\n  requires:\n    bins: ffmpeg\n',
 'metadata:\n  requires:\n    env: VIDEO_KEY\n',
 'metadata:\n  depends: [1]\n',
 'metadata:\n  requires:\n    bins: [null]\n',
 'metadata:\n  requires:\n    env: [false]\n',
 'metadata: invalid\n',
 'metadata:\n  requires: [ffmpeg]\n',
];
it.each(metadata)('rejects malformed management metadata rather than dropping its checks: %s',async extra=>{
 const f=skillsFixture();write(join(f.vault,SETTINGS.policyFile),MANAGED_POLICY);
 const md=skillMd('report','Report.',extra);expect(readMeta(md,'report').errors.length).toBeGreaterThan(0);
 write(join(f.vault,'.agents/skills/report/SKILL.md'),md);
 const service=new SkillsService(f.vault,SETTINGS,{engineSkills:f.engine,db:false});
 const state=await service.current();const plan=planViews(state.catalog,state.policy,state.roster,{agents:['alpha']});
 expect(plan.views[0]!.skills.some(s=>s.name==='report')).toBe(false);
 expect(plan.views[0]!.excluded.some(s=>s.name==='report')).toBe(true);
 const report=syncViews(join(f.base,'managed'),plan);
 expect(report.views[0]!.status).toBe('failed');expect(report.views[0]!.error).toMatch(/Unresolved assignments/);
 expect(report.views[0]!.excluded?.some(e=>e.name==='report')).toBe(true);
});
it.each(['invalid','missing pin'])('keeps unresolved %s assignments visible through sync, standalone ack, storage and Machines',async kind=>{
 const f=skillsFixture();write(join(f.vault,SETTINGS.policyFile),MANAGED_POLICY);
 const service=new SkillsService(f.vault,SETTINGS,{engineSkills:f.engine,db:false});const state=await service.current();
 const root=join(f.base,'managed');syncViews(root,planViews(state.catalog,state.policy,state.roster,{agents:['alpha']}));
 const previous=readCurrent(root,'alpha','zen-agent').dir;
 if(kind==='invalid')write(join(f.vault,'.agents/skills/report/SKILL.md'),skillMd('report','Report.','metadata:\n  depends: report\n'));
 else write(join(f.vault,SETTINGS.policyFile),MANAGED_POLICY+'\npins:\n  report: "engine:missing-package"\n');
 service.invalidate();const next=await service.current();const plan=planViews(next.catalog,next.policy,next.roster,{agents:['alpha']});
 const report=syncViews(root,plan);
 expect(report.views[0]!.status).toBe('failed');expect(readCurrent(root,'alpha','zen-agent').dir).toBe(previous);
 const inspected=inspectRoot(root);expect(inspected[0]!.status).toBe('failed');expect(inspected[0]!.excluded).toEqual(report.views[0]!.excluded);
 const payload=AckRequestSchema.parse(ackPayload({policyDigest:report.policyDigest,views:inspected},null));
 const device=await addDevice('readiness-fixture',{display:'Readiness fixture',kind:'server'});
 await recordAck({id:device.id,host:'readiness-fixture'},payload);
 const data=await readAcks();expect(data.acks[0]!.excluded).toEqual(report.views[0]!.excluded);
 const hosts=machineStates(data,()=>new Map(),24,new Date(),report.policyDigest);
 const host=hosts.find(h=>h.host==='readiness-fixture')!;expect(host.status).toBe('failed');expect(host.views[0]!.excluded).toEqual(report.views[0]!.excluded);
 const cliRows=await query('SELECT status,excluded FROM skill_view_acks WHERE host=$1',['readiness-fixture']);expect(cliRows.rows[0].status).toBe('failed');
});
it('treats an intentional lifecycle revocation as a deliberate omission',async()=>{
 const f=skillsFixture();write(join(f.vault,SETTINGS.policyFile),MANAGED_POLICY+'\nlifecycle:\n  report: {status: disabled}\n');
 const service=new SkillsService(f.vault,SETTINGS,{engineSkills:f.engine,db:false});const state=await service.current();
 const plan=planViews(state.catalog,state.policy,state.roster,{agents:['alpha']});expect(plan.views[0]!.excluded).toEqual([]);
 expect(plan.views[0]!.skills.some(s=>s.name==='report')).toBe(false);expect(syncViews(join(f.base,'managed'),plan).views[0]!.status).toBe('current');
});
