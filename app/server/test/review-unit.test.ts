import { describe, it, expect } from 'vitest';
import { runReview, evidence, Snapshot, type GateIO, type Job, type Verdict } from '../src/review/gate.js';

const sha = 'a'.repeat(40), base = 'b'.repeat(40), merged = 'c'.repeat(40);
const snapshot = (): Snapshot => ({ repo: 'example/engine', pr: 7, head: sha, base, branch: 'main', merged: null,
  checks: [{ name: 'test', state: 'pass' }], sources: [{ ref: 'ticket', revision: '1', text: 'Acceptance: working tests', essential: true, missing: false, truncated: false }] });
const checked = () => ({status:'checked' as const,evidence:['ticket'],rationale:'Verified against ticket and test evidence'});
const verdict = (): Verdict => ({ decision: 'accept', reviewer: 'auditor', repo: 'example/engine', pr: 7, head: sha, base,
  evidence: '', categories: { security: checked(), compatibility: checked(), migrations: checked(), regressions: checked(), scope: checked(), placeholders: checked(), tests: checked() }, findings: [] });
function fixture() {
  const job: Job = { id: 1, card: 't_123abc', builder: 'builder', reviewer: 'auditor', target: 'test', round: 0, state: 'queued', snapshot: null, verdict: null, merged: null, deployed: null };
  let current = snapshot(), reviews = 0, merges = 0, deploys = 0, completions = 0;
  const events: string[] = [];
  const io: GateIO = {
    async gather() { return structuredClone(current); },
    async review(s, evidence) { reviews++; return { ...verdict(), evidence }; },
    async save(patch) { Object.assign(job, patch); events.push(patch.state ?? 'save'); },
    async reject(text) { events.push(text); },
    async merge(s) { if (current.merged) return current.merged; merges++; current.merged = merged; return merged; },
    async deploy(revision) { deploys++; return revision; },
    async health(revision) { return revision === merged; },
    async verifyMerge(s,revision){if(current.merged!==revision)throw new Error('Unconfirmed merge');},
    async complete() { completions++; },
  };
  return { job, io, events, setCurrent(s: Snapshot) { current = s; }, counts: () => ({ reviews, merges, deploys, completions }) };
}
describe('automatic contextual shipping gate', () => {
  it('accepts only exact evidence and completes after merge, deployment and health; retries do not merge twice', async () => {
    const f = fixture(); await runReview(f.job, ['test'], f.io); await runReview(f.job, ['test'], f.io);
    expect(f.counts()).toEqual({ reviews: 1, merges: 1, deploys: 1, completions: 1 });
    expect(f.events).toEqual(['reviewing', 'approved', 'merging', 'merged', 'deploying', 'deployed', 'save', 'done']);
  });
  it.each(['missing', 'truncated'] as const)('blocks %s essential context before dispatch', async (field) => {
    const f = fixture(), s = snapshot(); s.sources[0]![field] = true; f.setCurrent(s);
    await runReview(f.job, ['test'], f.io); expect(f.job.state).toBe('blocked'); expect(f.counts().reviews).toBe(0);
  });
  it.each(['pending', 'fail'])('blocks %s required CI', async state => {
    const f = fixture(), s = snapshot(); s.checks[0]!.state = state; f.setCurrent(s);
    await runReview(f.job, ['test'], f.io); expect(f.job.state).toBe(state==='fail'?'rejected':'blocked'); expect(f.counts().merges).toBe(0);
  });
  it('rejects unauthorized reviewer, self review, malformed verdict and missing coverage', async () => {
    for (const change of [{ reviewer: 'builder' }, { reviewer: 'stranger' }, { decision: 'maybe' }, { categories: {} }, { evidence: 'forged' }, { categories:{...verdict().categories,tests:{...checked(),evidence:['missing-source']}} }]) {
      const f = fixture(); f.io.review = async (_, evidence) => ({ ...verdict(), evidence, ...change });
      await runReview(f.job, ['test'], f.io); expect(f.job.state).toBe('blocked'); expect(f.counts().merges).toBe(0);
    }
    const f = fixture(); f.job.builder = 'auditor'; await runReview(f.job, ['test'], f.io); expect(f.job.state).toBe('blocked');
  });
  it('returns actionable findings to the same builder and allows a new round', async () => {
    const f = fixture(); f.io.review = async (_, evidence) => ({ ...verdict(), decision: 'reject', evidence,
      findings: [{ severity: 'high', location: 'server.ts:12', evidence: 'query uses string interpolation', impact: 'SQL injection', fix: 'Bind parameters', verification: 'Test an injection payload' }] });
    await runReview(f.job, ['test'], f.io); expect(f.job.state).toBe('rejected'); expect(f.events.join('\n')).toContain('Bind parameters'); expect(f.counts().completions).toBe(0);
    f.job.round++; f.job.state = 'queued'; f.job.verdict = null; f.job.snapshot = null;
    f.io.review = async (_, evidence) => ({ ...verdict(), evidence }); await runReview(f.job, ['test'], f.io);
    expect(f.job.state).toBe('done'); expect(f.job.builder).toBe('builder');
  });
  it('invalidates changed head, base, ticket or evidence before merge', async () => {
    for (const field of ['head', 'base', 'sources'] as const) {
      const f = fixture(); const review = f.io.review;
      f.io.review = async (s, e) => { const v = await review(s, e); const changed = snapshot();
        if (field === 'sources') changed.sources[0]!.revision = '2'; else changed[field] = 'd'.repeat(40);
        f.setCurrent(changed); return v; };
      await runReview(f.job, ['test'], f.io); expect(f.job.state).toBe('blocked'); expect(f.counts().merges).toBe(0);
    }
  });
  it.each(['merge', 'deploy', 'health'] as const)('keeps %s failures open and preserves actual merge state on retry', async step => {
    const f = fixture(); const original = f.io[step];
    f.io[step] = (async () => { throw new Error(`${step} failed`); }) as never;
    await runReview(f.job, ['test'], f.io); expect(f.job.state).toBe('blocked'); expect(f.counts().completions).toBe(0);
    expect(f.job.merged).toBe(step === 'merge' ? null : merged);
    f.io[step] = original as never; await runReview(f.job, ['test'], f.io); expect(f.job.state).toBe('done'); expect(f.counts().merges).toBe(1);
  });
  it('recovers a merge completed externally before its receipt was saved', async () => {
    const f = fixture(); const merge = f.io.merge;
    let interrupted = false;
    f.io.merge = async s => { const result = await merge(s); if (!interrupted) { interrupted = true; throw new Error('connection lost'); } return result; };
    await runReview(f.job, ['test'], f.io); expect(f.job.merged).toBeNull();
    await runReview(f.job, ['test'], f.io); expect(f.job.state).toBe('done'); expect(f.counts().merges).toBe(1);
  });
});

import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { vi } from 'vitest';
import { source, note } from '../src/review/context.js';
import { childEnv, command } from '../src/review/process.js';
import { targetMain } from '../src/review/target.js';
import { GitHub, type HostConfig } from '../src/review/adapters.js';
import { parseCodexResult } from '../src/addons/dispatch/codex.js';

describe('bounded context and concrete adapters',()=>{
  it('retains the full structured verdict beyond the dispatch display limit',()=>{
    const text=JSON.stringify({...verdict(),details:'x'.repeat(1500)});
    const p=parseCodexResult({code:0,stderr:'',stdout:[JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}),JSON.stringify({type:'turn.completed'})].join('\n')});
    expect(p.text).toHaveLength(600);expect(p.fullText).toBe(text);
  });
  it('marks truncated and redacted evidence as blocking and rejects excluded files and escaping symlinks',async()=>{
    expect(source('large','x'.repeat(100),true,20).truncated).toBe(true);
    const redacted=source('log','password=fixture-sensitive-value');expect(redacted.redacted).toBe(true);expect(redacted.missing).toBe(false);expect(redacted.text).not.toContain('fixture-sensitive-value');
    const dir=await mkdtemp(join(tmpdir(),'review-context-'));
    try{
      await writeFile(join(dir,'note.md'),'Relevant design');await symlink('/etc/hosts',join(dir,'escape.md'));
      expect((await note(dir,'note.md',[])).missing).toBe(false);
      expect((await note(dir,'note.md',['note.md'])).missing).toBe(true);
      expect((await note(dir,'escape.md',[])).missing).toBe(true);
      expect((await note(dir,'../outside.md',[])).missing).toBe(true);
      expect((await note(dir,'.env',[])).missing).toBe(true);
    }finally{await rm(dir,{recursive:true,force:true});}
  });
  it('uses bounded, timed child processes and removes inherited credentials and loader options',async()=>{
    const env=childEnv('/tmp');expect(env).not.toHaveProperty('DATABASE_URL');expect(env).not.toHaveProperty('OPENAI_API_KEY');expect(env).not.toHaveProperty('NODE_OPTIONS');
    await expect(command(process.execPath,['-e','setTimeout(()=>{},10000)'],'/tmp',env,20)).rejects.toThrow(/timed out/);
    await expect(command(process.execPath,['-e',"process.stdout.write('x'.repeat(200))"],'/tmp',env,1000,30)).rejects.toThrow(/truncated/);
  });
  it('requires a unique known PR and uses normal exact-head PR merge under strict branch protection',async()=>{
    const repo={github:'example/engine',gitDir:'/tmp/fixture.git',base:'main',target:'fixture',checks:['test'],notes:['design.md']};
    const github=new GitHub({home:'/tmp'} as HostConfig,repo), calls:string[][]=[], ghCalls:string[][]=[];
    const metadata={number:7,body:'t_123abc',headRefOid:sha,baseRefOid:base,baseRefName:'main',headRefName:'card/t_123abc',isCrossRepository:false,isDraft:false,reviewDecision:null,state:'OPEN',mergeCommit:null as null|{oid:string},statusCheckRollup:[]};
    github.gh=async args=> {ghCalls.push(args);if(args[1]==='list')return '[]';if(args[0]==='api' && !args[1]?.endsWith('/protection'))return JSON.stringify({permissions:{admin:false}});if(args[0]==='api')return JSON.stringify({required_status_checks:{strict:true,contexts:['test']},allow_force_pushes:{enabled:false},enforce_admins:{enabled:true}});if(args[1]==='merge'){metadata.state='MERGED';metadata.mergeCommit={oid:merged};return '';}return JSON.stringify(metadata);};
    await expect(github.pr('t_123abc')).rejects.toThrow(/Unknown/);
    github.git=async args=>{
      calls.push(args);
      if(args[0]==='ls-remote')return `${base}\trefs/heads/main`;
      if(args[0]==='merge-tree')return 'd'.repeat(40);
      if(args.includes('commit-tree'))return merged;
      if(args[0]==='show')return `${base} ${sha}`;
      return '';
    };
    expect(await github.merge('t_123abc',snapshot())).toBe(merged);
    await github.confirmMerge('t_123abc',snapshot(),merged);
    expect(calls.some(c=>c[0]==='push')).toBe(false);
    expect(ghCalls.find(c=>c[1]==='merge')).toContain('--match-head-commit');
    expect(ghCalls.flat().some(v=>v.startsWith('--force'))).toBe(false);
    metadata.headRefOid='e'.repeat(40);await expect(github.merge('t_123abc',snapshot())).rejects.toThrow(/head changed/);
  });
  it('deploys once with a durable target receipt and reconciles retries through exact-revision health',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'review-target-')), log=vi.spyOn(console,'log').mockImplementation(()=>{});
    try{
      const script=join(dir,'bridge.mjs'),state=join(dir,'applied.json'),policy=join(dir,'target.json');
      await writeFile(script,`import{readFileSync,writeFileSync}from'node:fs';const[action,file,revision,key]=process.argv.slice(2);if(action==='deploy'){let n=0;try{n=JSON.parse(readFileSync(file)).n}catch{}writeFileSync(file,JSON.stringify({revision,n:n+1}));}else{console.log(JSON.stringify({revision:JSON.parse(readFileSync(file)).revision,healthy:true}));}`);
      await writeFile(policy,JSON.stringify({stateDir:join(dir,'ledger'),cwd:dir,home:dir,deployArgv:[process.execPath,script,'deploy',state],healthArgv:[process.execPath,script,'health',state]}),{mode:0o600});
      await targetMain([policy,'deploy',merged,'1']);await targetMain([policy,'deploy',merged,'1']);await targetMain([policy,'health',merged,'1']);
      expect(JSON.parse(await readFile(state,'utf8')).n).toBe(1);
      await expect(targetMain([policy,'deploy',sha,'1'])).rejects.toThrow(/key reused/);
    }finally{log.mockRestore();await rm(dir,{recursive:true,force:true});}
  });
  it('does not replay an uncertain deployment or let a different revision overtake it',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'review-uncertain-'));
    try{
      const policy=join(dir,'target.json'),script=join(dir,'fail.mjs'),count=join(dir,'count.txt');
      await writeFile(script,`import{appendFileSync}from'node:fs';const[action,path]=process.argv.slice(2);if(action==='deploy')appendFileSync(path,'called\\n');process.exit(1);`);
      await writeFile(policy,JSON.stringify({stateDir:join(dir,'ledger'),cwd:dir,home:dir,deployArgv:[process.execPath,script,'deploy',count],healthArgv:[process.execPath,script,'health',count]}),{mode:0o600});
      await expect(targetMain([policy,'deploy',merged,'1'])).rejects.toThrow();
      await expect(targetMain([policy,'deploy',merged,'1'])).rejects.toThrow();
      await expect(targetMain([policy,'deploy',sha,'2'])).rejects.toThrow(/Earlier target/);
      expect(await readFile(count,'utf8')).toBe('called\n');
    }finally{await rm(dir,{recursive:true,force:true});}
  });
});

it('keeps accepted reviews non-shipping until the owner enables shipping',async()=>{
  const f=fixture();f.io.mayShip=async()=>false;
  await runReview(f.job,['test'],f.io);expect(f.job.state).toBe('approved');expect(f.counts().merges).toBe(0);
  f.io.mayShip=async()=>true;await runReview(f.job,['test'],f.io);expect(f.job.state).toBe('done');expect(f.counts().reviews).toBe(1);
});
it('retains one validated approval across repeated shipping pauses and resumes once',async()=>{
  const f=fixture();let enabled=false;f.io.mayShip=async()=>enabled;
  await runReview(f.job,['test'],f.io);
  const accepted=structuredClone(f.job.verdict),reviewed=structuredClone(f.job.snapshot);
  for(let tick=0;tick<3;tick++)await runReview(f.job,['test'],f.io);
  expect(f.job.state).toBe('approved');
  expect(f.job.verdict).toEqual(accepted);expect(f.job.snapshot).toEqual(reviewed);
  expect(f.counts()).toEqual({reviews:1,merges:0,deploys:0,completions:0});
  enabled=true;await runReview(f.job,['test'],f.io);await runReview(f.job,['test'],f.io);
  expect(f.job.state).toBe('done');
  expect(f.counts()).toEqual({reviews:1,merges:1,deploys:1,completions:1});
});
it.each(['draft','unresolved','changesRequested'] as const)('returns incomplete PR %s to its builder with specific fixes',async key=>{
  const f=fixture(),s=snapshot();if(key==='unresolved')s.unresolved=1;else s[key]=true;f.setCurrent(s);
  await runReview(f.job,['test'],f.io);expect(f.job.state).toBe('rejected');expect(f.counts().merges).toBe(0);expect(f.events.join(' ')).toContain('Required fix');
});

import {hasAcceptance,repositoryKey,linkedNote,builderIsReviewer} from '../src/review/context.js';
it('uses runner body criteria and registered repo headers without accepting unknown repositories',()=>{
 expect(hasAcceptance({body:'Repo: engine\nDone when: all checks pass',contract:{}})).toBe(true);
 expect(hasAcceptance({body:'Please implement it',contract:{}})).toBe(false);
 expect(repositoryKey({repo:'vault',body:'Assigned by owner. Repo: vault.\nRepo: engine\nDone when: tests'}, {engine:{},vault:{}})).toBe('engine');
 expect(repositoryKey({repo:'vault',body:'Repo: unregistered'}, {engine:{},vault:{}})).toBe('');
});
it('resolves unambiguous sibling links only beneath owner-selected roots',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'review-links-'));
 try{
  await (await import('node:fs/promises')).mkdir(join(dir,'project'));
  await writeFile(join(dir,'project','sibling.md'),'Relevant design');
  expect((await linkedNote(dir,'sibling',[],['project'],[])).text).toBe('Relevant design');
  expect((await linkedNote(dir,'sibling',[],[],[])).missing).toBe(true);
  expect((await linkedNote(dir,'../escape',[],['project'],[])).missing).toBe(true);
 }finally{await rm(dir,{recursive:true,force:true});}
});

it('blocks stale approval evidence before any resumed deployment while retaining the actual merge receipt',async()=>{
 const f=fixture();f.io.mayShip=async()=>false;await runReview(f.job,['test'],f.io);
 f.job.merged=merged;f.job.state='merged';const s=snapshot();s.merged=merged;s.sources[0]!.revision='changed-ticket';f.setCurrent(s);
 f.io.mayShip=async()=>true;await runReview(f.job,['test'],f.io);
 expect(f.job.state).toBe('blocked');expect(f.job.merged).toBe(merged);expect(f.counts().deploys).toBe(0);
});
it('invalidates old approval before checking missing new-head evidence, then permits a fresh review',async()=>{
 const f=fixture();f.io.mayShip=async()=>false;await runReview(f.job,['test'],f.io);
 const s=snapshot();s.head='d'.repeat(40);s.sources[0]!.missing=true;f.setCurrent(s);
 await runReview(f.job,['test'],f.io);expect(f.job.snapshot).toBeNull();expect(f.job.verdict).toBeNull();
 s.sources[0]!.missing=false;f.setCurrent(s);f.io.review=async(current,hash)=>({...verdict(),head:current.head,evidence:hash});
 await runReview(f.job,['test'],f.io);expect(f.job.state).toBe('approved');expect(f.job.snapshot?.head).toBe(s.head);
});
it('retains a confirmed external merge but never deploys it when parent validation fails',async()=>{
 const f=fixture();f.io.verifyMerge=async()=>{throw new Error('Different parents');};await runReview(f.job,['test'],f.io);
 expect(f.job.merged).toBe(merged);expect(f.job.state).toBe('blocked');expect(f.counts().deploys).toBe(0);
});

it('does not permit a reviewer persona to self-approve through a machine-session assignee',()=>{
 expect(builderIsReviewer({assignee:'machine',body:'Persona: auditor'},'auditor')).toBe(true);
 expect(builderIsReviewer({assignee:'machine',body:'Persona: coder'},'auditor','Builder persona: auditor')).toBe(true);
 expect(builderIsReviewer({assignee:'machine',body:'Persona: coder'},'auditor','Builder persona: coder')).toBe(false);
});

function jsonbRoundTrip<T>(value:T):T {
  const sorted=(v:unknown):unknown => Array.isArray(v) ? v.map(sorted) : v!==null && typeof v==='object'
    ? Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,item])=>[k,sorted(item)])) : v;
  return JSON.parse(JSON.stringify(sorted(value))) as T;
}
it('fingerprints equivalent raw, parsed and JSONB-reordered snapshots identically',()=>{
  const raw=snapshot(),parsed=Snapshot.parse(raw),stored=jsonbRoundTrip(parsed);
  expect(evidence(raw)).toBe(evidence(parsed));expect(evidence(stored)).toBe(evidence(parsed));
  stored.sources[0]!.text+=' changed acceptance';
  expect(evidence(stored)).not.toBe(evidence(parsed));
});
it('reuses the accepted review after a PostgreSQL JSONB worker restart',async()=>{
  const f=fixture();f.io.mayShip=async()=>false;await runReview(f.job,['test'],f.io);
  Object.assign(f.job,jsonbRoundTrip(f.job));
  f.io.mayShip=async()=>true;await runReview(f.job,['test'],f.io);
  expect(f.job.state).toBe('done');expect(f.counts()).toEqual({reviews:1,merges:1,deploys:1,completions:1});
});
it('restores deployed state after health failure before SQL completion without repeating effects',async()=>{
  const f=fixture(),health=f.io.health,complete=f.io.complete;
  f.io.health=async()=>false;
  f.io.complete=async()=>{if(f.job.state!=='deployed')throw new Error('SQL requires deployed state');await complete();};
  await runReview(f.job,['test'],f.io);
  expect(f.job.state).toBe('blocked');expect(f.job.deployed).toBe(merged);
  f.io.health=health;await runReview(f.job,['test'],f.io);
  expect(f.job.state).toBe('done');expect(f.counts()).toEqual({reviews:1,merges:1,deploys:1,completions:1});
});
it.each(['project','feature'])('ignores only board %s audit stamps while retaining meaningful evidence',kind=>{
  const project={title:'Platform',owner:'lead',stage:'building',updated_at:'before',updated_by:'writer'};
  const snap=(data:unknown,ref=`board:t_123abc:${kind}`)=>({...snapshot(),sources:[source(ref,data)]});
  const original=snap(project),before=structuredClone(original);
  for(const field of ['updated_at','updated_by'])expect(evidence(snap({...project,[field]:'after'}))).toBe(evidence(original));
  expect(original).toEqual(before);
  for(const field of ['title','owner','stage'])expect(evidence(snap({...project,[field]:'changed'}))).not.toBe(evidence(original));
  for(const ref of [`github:t_123abc:${kind}`,`board:not-a-card:${kind}`,`board:t_123abc:ticket`]){
    expect(evidence(snap({...project,updated_at:'after'},ref))).not.toBe(evidence(snap(project,ref)));
  }
  expect(evidence(snap('malformed before'))).not.toBe(evidence(snap('malformed after')));
});
it('retains the raw revision for redacted project content and audit changes',()=>{
  const snap=(title:string,updated_at='before')=>({...snapshot(),sources:[source('board:t_123abc:project',{title,updated_at})]});
  const before=snap('token=old-sensitive-value'),changed=snap('token=new-sensitive-value');
  expect(before.sources[0]!.redacted).toBe(true);expect(before.sources[0]!.text).toBe(changed.sources[0]!.text);
  expect(evidence(before)).not.toBe(evidence(changed));
  expect(evidence(before)).not.toBe(evidence(snap('token=old-sensitive-value','after')));
});
it('completes a previously healthy release after bookkeeping fails without replaying superseded effects',async()=>{
  const f=fixture(),complete=f.io.complete,health=f.io.health;let healthCalls=0;
  f.io.health=async revision=>{healthCalls++;return health(revision);};
  f.io.complete=async()=>{throw new Error('Bookkeeping interrupted after verified health');};
  await runReview(f.job,['test'],f.io);
  expect(f.job.state).toBe('blocked');expect(f.job.health).toBe(merged);
  f.io.health=async()=>{healthCalls++;throw new Error('A newer release is now running');};
  f.io.complete=complete;await runReview(f.job,['test'],f.io);
  expect(f.job.state).toBe('done');expect(healthCalls).toBe(1);
  expect(f.counts()).toEqual({reviews:1,merges:1,deploys:1,completions:1});
});
it.each([undefined,'d'.repeat(40)])('requires live health when the durable health receipt is absent or wrong (%s)',async receipt=>{
  const f=fixture();f.io.complete=async()=>{throw new Error('Bookkeeping interrupted');};
  await runReview(f.job,['test'],f.io);f.job.health=receipt;
  let healthCalls=0;f.io.health=async()=>{healthCalls++;return false;};
  await runReview(f.job,['test'],f.io);
  expect(f.job.state).toBe('blocked');expect(healthCalls).toBe(1);expect(f.counts().completions).toBe(0);
});
