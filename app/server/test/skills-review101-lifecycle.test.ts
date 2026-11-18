import { existsSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SkillsService } from '../src/addons/skills/service.js';
import { SETTINGS, sh, skillMd, skillsFixture, write } from './helpers/skills.js';
function fixture() {
 const f=skillsFixture();
 const service=new SkillsService(f.vault,SETTINGS,{engineSkills:f.engine,db:false,observations:async()=>({acks:[],hosts:[],lastSeen:new Map()})});
 return {f,service};
}

it.each(['linked','non-directory'] as const)('refuses a Git-worktree %s private-root ancestor before writing outside it',async kind=>{
 const {f,service}=fixture();const privateRoot=join(f.vault,SETTINGS.privateRoot);
 const sentinel=join(f.outside,'private-root','sentinel.md');write(sentinel,'Untouched outside content.');
 rmSync(privateRoot,{recursive:true});
 if(kind==='linked')symlinkSync(join(f.outside,'private-root'),privateRoot);
 else write(privateRoot,'Not a directory.');
 sh(f.vault,'add','-A','--',SETTINGS.privateRoot);sh(f.vault,'commit','-qm','unsafe tracked private root');
 // A regular source checkout lets preview succeed, but the new Git worktree still contains the unsafe parent.
 rmSync(privateRoot);write(join(privateRoot,'local-marker.md'),'Local regular folder.');service.invalidate();
 await service.createDraft('new-skill');const loaded=await service.readDraftFile('new-skill','SKILL.md');
 await service.writeDraftFile('new-skill','SKILL.md',skillMd('new-skill','Summarizes a source document.','','# Instructions\n\n1. Read the source.\n2. Summarize its claims with citations.\n'),false,loaded.version);
 const change=await service.propose({kind:'create',skill:'new-skill',draft:'new-skill'});
 await expect(service.apply(change.id)).rejects.toThrow(/package destination.*(?:linked|directory)/);
 expect(readFileSync(sentinel,'utf8')).toBe('Untouched outside content.');
 expect(readdirSync(join(f.outside,'private-root'))).toEqual(['sentinel.md']);
 expect(existsSync(join(f.outside,'private-root','new-skill'))).toBe(false);
 expect(sh(f.vault,'branch','--list',`skills/${change.id}`)).toBe('');
 expect(sh(f.vault,'worktree','list').split('\n')).toHaveLength(1);
});

it('blocks untouched starter description and instructions independently while preserving editable malformed drafts',async()=>{
 const {service}=fixture();await service.createDraft('new-skill');
 let preview=await service.preview({kind:'create',skill:'new-skill',draft:'new-skill'});
 expect(preview.validation.valid).toBe(false);expect(preview.validation.errors.join(' ')).toMatch(/description placeholder/);expect(preview.validation.errors.join(' ')).toMatch(/instruction placeholder/);
 await expect(service.propose({kind:'create',skill:'new-skill',draft:'new-skill'})).rejects.toThrow(/does not validate/);
 const save=async(content:string)=>service.writeDraftFile('new-skill','SKILL.md',content,false,(await service.readDraftFile('new-skill','SKILL.md')).version);
 await save(skillMd('new-skill','Summarizes a source document.','','# Instructions\n\nSteps the agent follows.\n'));
 preview=await service.preview({kind:'create',skill:'new-skill',draft:'new-skill'});expect(preview.validation.errors.join(' ')).toMatch(/instruction placeholder/);
 await save(skillMd('new-skill','Describe what this skill does and when an agent should use it.','','# Instructions\n\nRead the document and summarize its claims with citations.\n'));
 preview=await service.preview({kind:'create',skill:'new-skill',draft:'new-skill'});expect(preview.validation.errors.join(' ')).toMatch(/description placeholder/);
 await save('---\nname: [malformed\n');expect((await service.draft('new-skill')).validation.valid).toBe(false);expect((await service.readDraftFile('new-skill','SKILL.md')).content).toContain('malformed');
 await save(skillMd('new-skill','Summarizes a source document.','','# Instructions\n\n1. Read the source document.\n2. Summarize its claims with citations.\n'));
 preview=await service.preview({kind:'create',skill:'new-skill',draft:'new-skill'});expect(preview.validation.valid).toBe(true);expect(preview.blocked).toEqual([]);
 expect((await service.propose({kind:'create',skill:'new-skill',draft:'new-skill'})).kind).toBe('create');
});
