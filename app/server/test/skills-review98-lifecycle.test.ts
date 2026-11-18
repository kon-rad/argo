import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { expect,it } from 'vitest';
import type { ReviewReceipt } from '../src/addons/skills/lifecycle.js';
import { SkillsService } from '../src/addons/skills/service.js';
import { MANAGED_POLICY,SETTINGS,sh,skillMd,skillsFixture,write } from './helpers/skills.js';
function fixture(){
 const f=skillsFixture();write(join(f.vault,SETTINGS.policyFile),MANAGED_POLICY);sh(f.vault,'add','-A');sh(f.vault,'commit','-qm','policy');
 const receipts: ReviewReceipt[]=[];
 const make=(privateRoot=SETTINGS.privateRoot)=>new SkillsService(f.vault,{...SETTINGS,privateRoot},{engineSkills:f.engine,db:false,reviewReceipts:async()=>receipts,observations:async()=>({acks:[],hosts:[],lastSeen:new Map()})});
 return {f,make,receipts,service:make()};
}
it.each(['invalid','unpreviewed','forged-digest'] as const)('refuses %s exported policy before creating a review branch',async kind=>{
 const {f,service}=fixture();const change=await service.propose({kind:'disable',skill:'video'});
 expect(change.preview.targetPolicyDigest).toMatch(/^sha256:/);
 const dir=join(f.vault,SETTINGS.changesDir,change.id),file=join(dir,'policy.yaml');
 const modified=kind==='invalid'?'version: nope\n':readFileSync(file,'utf8').replace('grant:','deny:');write(file,modified);
 if(kind==='forged-digest'){
  const stored=JSON.parse(readFileSync(join(dir,'change.json'),'utf8'));stored.preview.targetPolicyDigest=`sha256:${createHash('sha256').update(modified).digest('hex')}`;
  write(join(dir,'change.json'),JSON.stringify(stored));
 }
 await expect(service.apply(change.id)).rejects.toThrow(/stored policy.*(?:validate|previewed)/);
 expect(sh(f.vault,'branch','--list',`skills/${change.id}`)).toBe('');expect(readFileSync(join(f.vault,SETTINGS.policyFile),'utf8')).toBe(MANAGED_POLICY);
});
it('keeps matching local bytes pending until the recorded apply commit reaches the default tracking branch',async()=>{
 const {f,service,receipts}=fixture();sh(f.vault,'remote','add','origin','https://github.com/fixture-org/fixture-vault.git');await service.createDraft('report','report');
 const target=skillMd('report','Reviewed target.');const loaded=await service.readDraftFile('report','SKILL.md');
 await service.writeDraftFile('report','SKILL.md',target,false,loaded.version);const change=await service.propose({kind:'update',skill:'report',draft:'report'});
 const status=async()=>{service.invalidate();return(await service.changes()).find(c=>c.id===change.id)!.status;};
 const path=join(f.vault,SETTINGS.privateRoot,'report','SKILL.md'),original=readFileSync(path,'utf8');
 write(path,target);expect(await status()).toBe('pending');
 write(path,original);const applied=await service.apply(change.id);expect(await status()).toBe('branch');
 // Merely checking out the review branch is not a verified merge.
 sh(f.vault,'checkout','-q',applied.branch);expect(await status()).toBe('pending');sh(f.vault,'checkout','-q','main');
 sh(f.vault,'update-ref','refs/remotes/origin/main','HEAD');sh(f.vault,'symbolic-ref','refs/remotes/origin/HEAD','refs/remotes/origin/main');
 sh(f.vault,'merge','-q','--ff-only',applied.branch);expect(await status()).toBe('pending');
 sh(f.vault,'update-ref','refs/remotes/origin/main',applied.commit);expect(await status()).toBe('pending');
 receipts.push({repo:'wrong-org/wrong-repo',head:applied.commit,merged:applied.commit,branch:'main'});expect(await status()).toBe('pending');
 receipts.push({repo:'fixture-org/fixture-vault',head:applied.commit,merged:applied.commit,branch:'main'});expect(await status()).toBe('live');
 // Missing default tracking evidence remains conservative even with a receipt.
 sh(f.vault,'update-ref','-d','refs/remotes/origin/main');expect(await status()).toBe('pending');
});
it('rejects an absolute external privateRoot during create preview and export',async()=>{
 const {f,make}=fixture();const external=join(f.outside,'skills'),service=make(external);
 await service.createDraft('new-skill',undefined,'A valid new skill.');
 await expect(service.preview({kind:'create',skill:'new-skill',draft:'new-skill'})).rejects.toThrow(/privateRoot.*inside.*vault Git tree/);
 await expect(service.propose({kind:'create',skill:'new-skill',draft:'new-skill'})).rejects.toThrow(/privateRoot.*inside.*vault Git tree/);
 expect(await service.changes()).toEqual([]);expect(existsSync(join(external,'new-skill'))).toBe(false);
});

it.each(['package','policy'] as const)('keeps a later unreviewed %s reintroduction pending when the accepted aggregate reverted it',async kind=>{
 const {f,service,receipts}=fixture();sh(f.vault,'remote','add','origin','https://github.com/fixture-org/fixture-vault.git');
 let id:string;
 if(kind==='package'){
  await service.createDraft('report','report');const loaded=await service.readDraftFile('report','SKILL.md');
  await service.writeDraftFile('report','SKILL.md',skillMd('report','Target later reverted.'),false,loaded.version);
  id=(await service.propose({kind:'update',skill:'report',draft:'report'})).id;
 }else id=(await service.propose({kind:'disable',skill:'video'})).id;
 const applied=await service.apply(id);sh(f.vault,'merge','-q','--ff-only',applied.branch);
 sh(f.vault,'revert','--no-edit',applied.commit);const acceptedHead=sh(f.vault,'rev-parse','HEAD');
 receipts.push({repo:'fixture-org/fixture-vault',head:acceptedHead,merged:acceptedHead,branch:'main'});
 sh(f.vault,'cherry-pick',applied.commit);const tip=sh(f.vault,'rev-parse','HEAD');
 sh(f.vault,'update-ref','refs/remotes/origin/main',tip);sh(f.vault,'symbolic-ref','refs/remotes/origin/HEAD','refs/remotes/origin/main');
 service.invalidate();expect((await service.changes()).find(change=>change.id===id)!.status).toBe('pending');
 // Acceptance of the actual reintroduced aggregate, rather than ancestry alone, is sufficient.
 receipts.push({repo:'fixture-org/fixture-vault',head:tip,merged:tip,branch:'main'});
 expect((await service.changes()).find(change=>change.id===id)!.status).toBe('live');
});
