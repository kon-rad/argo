import { existsSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { parseSettings, settingsReport } from '../src/settings.js';
import { runSkillsCli, type CliIo } from '../src/addons/skills/cli.js';
import { SkillsService } from '../src/addons/skills/service.js';
import { authorizeRemotePlan, packBundle, proposeViews, syncViews } from '../src/addons/skills/reconcile.js';
import { SETTINGS, sh, skillsFixture, write } from './helpers/skills.js';

const CANONICAL='https://skills.test', ALTERNATE='https://echo.example.test';
async function fixture() {
 const f=skillsFixture();write(join(f.vault,SETTINGS.policyFile),'version: 1\nmode: managed\norg: {grant: [report]}\n');
 sh(f.vault,'add',SETTINGS.policyFile);sh(f.vault,'commit','-qm','Committed fixture policy');
 const service=new SkillsService(f.vault,{...SETTINGS},{engineSkills:f.engine,db:false});
 const state=await service.current(),plan=proposeViews(state.catalog,state.policy,state.roster,{agents:['alpha']});
 const fetcher=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const body=JSON.parse(String(init?.body));
  return new Response(JSON.stringify({policyDigest:body.policyDigest,fingerprint:body.fingerprint}));
 });
 await authorizeRemotePlan(plan,{authorityOrigin:CANONICAL},CANONICAL,'fixture-token',fetcher);
 const root=join(f.base,'managed');expect(syncViews(root,plan).views[0]!.status).toBe('current');
 const before=readlinkSync(join(root,'views/alpha/zen-agent')),out=join(f.base,'bundle.json');
 const bundle=join(f.base,'import.json');writeFileSync(bundle,JSON.stringify({...packBundle(plan),authorityOrigin:CANONICAL}));
 fetcher.mockClear();const errors:string[]=[];
 const io:CliIo={out:()=>{},err:line=>errors.push(line),env:{PATH:'',SECONDBRAIN_SERVER:CANONICAL,SB_LEDGER_TOKEN:'fixture-token'},fetch:fetcher};
 return {f,service,plan,root,before,out,bundle,io,fetcher,errors};
}

it('defaults the trust anchor to null, normalizes HTTPS origins and reports unsafe configuration without retaining it',()=>{
 expect(parseSettings({}).skills.authorityOrigin).toBeNull();
 expect(parseSettings({skills:{authorityOrigin:'HTTPS://SKILLS.TEST:443/'}}).skills.authorityOrigin).toBe(CANONICAL);
 for(const authorityOrigin of ['http://skills.test','https://user:fixture-password@skills.test','https://skills.test/path','https://skills.test/a/..','https://skills.test?','https://skills.test#','https://skills.test/?x=1','https://skills.test\\',' https://skills.test','https://skills.test\n']){ // public-ok: invalid credentials on a reserved .test host
  const report=settingsReport({skills:{authorityOrigin}});
  expect(report.errors.some(error=>error.path.join('.')==='skills.authorityOrigin')).toBe(true);
  expect(report.settings.skills.authorityOrigin).toBeNull();
 }
});

it.each(['pack','sync','dry-run','ack'] as const)('refuses an alternate HTTPS echo server for %s before token-file reads or transmission',async command=>{
 const x=await fixture();
 const args=command==='pack'?['pack','--out',x.out,'--agents','alpha']:command==='ack'?['ack','--root',x.root]:['sync','--agents','alpha','--root',x.root,...(command==='dry-run'?['--dry-run']:[])];
 args.push('--server',ALTERNATE,'--token-file',join(x.f.base,'never-read-token'));
 expect(await runSkillsCli(args,x.service,x.io)).toBe(1);
 expect(x.fetcher).not.toHaveBeenCalled();expect(x.errors.join(' ')).toMatch(/does not match.*authorityOrigin/);expect(x.errors.join(' ')).not.toMatch(/ENOENT|fixture-token/);
 expect(readlinkSync(join(x.root,'views/alpha/zen-agent'))).toBe(x.before);expect(existsSync(x.out)).toBe(false);
});

it('refuses an alternate environment selector even alongside a canonical flag and never echoes URL credentials',async()=>{
 const x=await fixture();x.io.env.SECONDBRAIN_SERVER=ALTERNATE;
 expect(await runSkillsCli(['sync','--agents','alpha','--root',x.root,'--server',CANONICAL],x.service,x.io)).toBe(1);
 x.io.env.SECONDBRAIN_SERVER=CANONICAL;
 expect(await runSkillsCli(['ack','--root',x.root,'--server','https://fixture-user:do-not-echo@echo.example.test'],x.service,x.io)).toBe(1); // public-ok: invalid credentials on a reserved .test host
 expect(x.fetcher).not.toHaveBeenCalled();expect(x.errors.join(' ')).not.toMatch(/do-not-echo|fixture-token/);
 expect(readlinkSync(join(x.root,'views/alpha/zen-agent'))).toBe(x.before);
});

it('fails closed without local authority configuration despite canonical flags, environment and bundle fields',async()=>{
 const x=await fixture();x.service.settings.authorityOrigin=null;
 for(const args of [
  ['pack','--out',x.out,'--agents','alpha','--server',CANONICAL],
  ['sync','--bundle',x.bundle,'--root',x.root,'--server',CANONICAL],
  ['sync','--agents','alpha','--dry-run','--root',x.root],
  ['ack','--root',x.root],
 ]) expect(await runSkillsCli(args,x.service,x.io)).toBe(1);
 expect(x.fetcher).not.toHaveBeenCalled();expect(x.errors.every(error=>error.includes('skills.authorityOrigin is not configured'))).toBe(true);
 expect(readlinkSync(join(x.root,'views/alpha/zen-agent'))).toBe(x.before);expect(existsSync(x.out)).toBe(false);
});

it('requires explicit canonical context in the transport API and revokes an old capability on mismatch',async()=>{
 const x=await fixture();
 await expect(authorizeRemotePlan(x.plan,{authorityOrigin:CANONICAL},ALTERNATE,'fixture-token',x.fetcher)).rejects.toThrow(/does not match/);
 expect(()=>packBundle(x.plan)).toThrow(/no current accepted/);
 await expect(authorizeRemotePlan(x.plan,{authorityOrigin:null},CANONICAL,'fixture-token',x.fetcher)).rejects.toThrow(/not configured/);
 expect(x.fetcher).not.toHaveBeenCalled();expect(readlinkSync(join(x.root,'views/alpha/zen-agent'))).toBe(x.before);
 await authorizeRemotePlan(x.plan,{authorityOrigin:'HTTPS://SKILLS.TEST:443/'},`${CANONICAL}/`,'fixture-token',x.fetcher);
 expect(packBundle(x.plan).policyDigest).toBe(x.plan.policyDigest);
 expect(x.fetcher).toHaveBeenCalledWith(new URL('/api/skills/authorize',CANONICAL),expect.objectContaining({headers:expect.objectContaining({Authorization:'Bearer fixture-token'})}));
});

it('packs, imports, synchronizes and acknowledges through the configured canonical origin',async()=>{
 const x=await fixture();
 expect(await runSkillsCli(['pack','--agents','alpha','--out',x.out],x.service,x.io)).toBe(0);
 expect(await runSkillsCli(['sync','--bundle',x.out,'--root',x.root],x.service,x.io)).toBe(0);
 expect(x.fetcher).toHaveBeenCalledTimes(2);expect(x.fetcher.mock.calls.every(([url])=>new URL(String(url)).origin===CANONICAL)).toBe(true);
 x.fetcher.mockImplementation(async()=>new Response('{}'));
 expect(await runSkillsCli(['ack','--root',x.root],x.service,x.io)).toBe(0);
 expect(String(x.fetcher.mock.calls.at(-1)![0])).toBe(`${CANONICAL}/api/skills/ack`);
});
