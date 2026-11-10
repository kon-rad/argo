import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { POLICY, policyHash, evaluate, scopeObservation } from '../src/review/policy.js';
import { collectCode, pathProblem, reviewable } from '../src/review/scope.js';
import { validatePlan } from '../src/review/plan.js';
import { preflight } from '../src/review/preflight.js';
import { GitHub, type HostConfig } from '../src/review/adapters.js';

const base = 'a'.repeat(40), head = 'b'.repeat(40);
const files = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `src/f${i}.ts`, status: 'modified' as const }));
function plan(n = 1) {
  const paths = files(n).map(f => ({ ...f, sourceChars: 100, imports: [] }));
  return { version: 1, policyHash, card: 'example-task', repository: 'example/engine', base,
    requirements: [{ id: 'r1', description: 'Behavior is verified', tasks: ['t1'], tests: ['test1'] }],
    tasks: [{ id: 't1', requirements: ['r1'], paths: paths.map(f => f.path), tests: ['test1'], dependencies: [] }],
    tests: [{ id: 'test1', requirements: ['r1'], paths: ['test/scope.test.ts'], command: 'npm test' }],
    dependencies: [], files: paths, diffChars: 100, otherContextChars: 100,
    uncertainty: { reviewableFiles: 0, sourceChars: 0, diffChars: 0, combinedChars: 0, unknowns: [] },
    confidence: 'high', verification: ['npm test'], decomposition: [] };
}

describe('one review capacity policy', () => {
  it('preserves hard boundaries and reserves the default planning margin', () => {
    expect(POLICY).toMatchObject({ changedFiles: 100, reviewableFiles: 30, sources: 80, sourceChars: 80000, diffChars: 250000, combinedChars: 500000, softTarget: 24 });
    for (const n of [24, 30, 31]) {
      const o = scopeObservation(files(n), [], '');
      expect(evaluate(o, 'actual').status).toBe(n > 30 ? 'decompose' : 'pass');
      expect(evaluate(o, 'forecast').status).toBe(n > 24 ? 'decompose' : 'pass');
    }
    expect(validatePlan(plan(24)).status).toBe('pass');
    expect(validatePlan(plan(25)).status).toBe('decompose');
    const p = plan(24); p.uncertainty.reviewableFiles = 1;
    expect(validatePlan(p).reasons.some(r => r.code === 'soft-target')).toBe(true);
    expect(validatePlan(plan(30), { softTarget: 30 }).status).toBe('pass');
    expect(validatePlan(plan(), { softTarget: 31 }).status).toBe('invalid');
  });
  it('counts deletes, renames, tests and docs, but retains lock/binary selection rules', async () => {
    const changed = [{ path: 'old.py', status: 'removed' as const }, { path: 'new.ts', previousPath: 'old.ts', status: 'renamed' as const },
      { path: 'test/check.test.ts', status: 'added' as const }, { path: 'docs/check.md', status: 'modified' as const },
      { path: 'package-lock.json', status: 'modified' as const }, { path: 'image.png', status: 'added' as const }];
    const reads: string[] = [];
    const code = await collectCode(changed, head, base, new Set(changed.map(f => f.path)), async (r, p) => { reads.push(`${r}:${p}`); return 'x'; });
    expect(code).toHaveLength(4); expect(reads).toContain(`${base}:old.py`); expect(reads).toContain(`${head}:new.ts`);
    expect(reviewable('deps.lock')).toBe(false);
    expect(scopeObservation(changed, code, '').changedFiles).toBe(6);
  });
  it('gathers only immediate imports, deduplicates and applies the same limits in the public adapter', async () => {
    const texts: Record<string, string> = { 'src/f0.ts': "import './one.js'; import './two.js';", 'src/one.ts': "import './deep.js';", 'src/two.ts': 'test', 'src/deep.ts': 'deep' };
    const read = async (_r: string, p: string) => texts[p]!;
    const code = await collectCode(files(1), head, base, new Set(Object.keys(texts)), read);
    expect(code.map(s => s.path)).toEqual(['src/f0.ts', 'src/one.ts', 'src/two.ts']);
    const github = new GitHub({ home: '/tmp', exclude: [] } as unknown as HostConfig,
      { github: 'example/engine', gitDir: '/tmp/fixture.git', base: 'main', target: 'test', checks: ['test'], notes: ['design.md'] });
    let changed = 30;
    github.gh = async () => JSON.stringify([files(changed).map(f => ({ filename: f.path, status: f.status }))]);
    github.git = async () => '';
    expect(await github.code({ number: 1, headRefOid: head, baseRefOid: base })).toHaveLength(30);
    changed = 31;
    await expect(github.code({ number: 1, headRefOid: head, baseRefOid: base })).rejects.toThrow(/reviewableFiles/);
    expect(evaluate(scopeObservation(files(101), [], ''), 'actual').status).toBe('decompose');
    expect(evaluate({ ...scopeObservation([], [], ''), sources: 81 }, 'actual').status).toBe('decompose');
  });
  it.each(['sourceChars', 'diffChars', 'combinedChars'] as const)('reports exact %s observations without truncation', key => {
    const o = { ...scopeObservation([], [], ''), [key]: POLICY[key] + 1 };
    const r = evaluate(o, 'actual');
    expect(r.status).toBe('decompose'); expect(r.reasons).toContainEqual(expect.objectContaining({ code: key, observed: POLICY[key] + 1, allowed: POLICY[key] }));
    expect(evaluate({ ...o, [key]: POLICY[key] }, 'actual').status).toBe('pass');
  });
  it.each(['../escape.ts', '/absolute.ts', 'src/../escape.ts', 'src\\escape.ts', '.env', 'src/credentials.json', 'secrets/key.ts', '.git/config', 'private/file.md'])('rejects unsafe/private path %s', async path => {
    expect(pathProblem(path, ['private'])).toBeTruthy();
    const p = plan(); p.files[0]!.path = path;
    expect(validatePlan(p, { exclude: ['private'] }).status).toBe('invalid');
    await expect(collectCode([{ path, status: 'removed' }], head, base, new Set(), async () => { throw new Error('must never read'); }, ['private'])).rejects.toThrow();
  });
  it('allows public env templates and rejects excluded immediate imports and rename origins', async () => {
    expect(pathProblem('vault-template/env.example', [])).toBeUndefined();
    expect(pathProblem('.env.example', [])).toBeUndefined();
    await expect(collectCode(files(1), head, base, new Set(['private.ts']), async () => "import '../private.js'", ['private.ts'])).rejects.toThrow(/excluded/);
    await expect(collectCode([{ path: 'safe.ts', previousPath: '.env', status: 'renamed' }], head, base, new Set(), async () => '')).rejects.toThrow(/excluded/);
  });
  it('rejects missing/malformed plans, policy drift, missing mappings, dependency cycles and unquantified uncertainty', () => {
    for (const p of [undefined, {}, { ...plan(), version: 2 }, { ...plan(), policyHash: 'wrong' }, { ...plan(), requirements: [] }]) expect(validatePlan(p).status).toBe('invalid');
    const p = plan(); p.tasks[0]!.tests = []; expect(validatePlan(p).status).toBe('invalid');
    const q = plan(); q.tasks[0]!.dependencies = ['t1'] as never[]; expect(validatePlan(q).status).toBe('invalid');
    const u = plan(); u.uncertainty.unknowns = ['new imports'] as never[]; expect(validatePlan(u).status).toBe('invalid');
    u.uncertainty.reviewableFiles = 2; u.uncertainty.sourceChars = 500; u.uncertainty.diffChars = 500; u.uncertainty.combinedChars = 1000;
    expect(validatePlan(u).status).toBe('pass');
  });
  it('requires a decomposition to preserve requirements and independently verifiable dependency order', () => {
    const p = plan(31);
    p.decomposition = [{ id: 'slice1', requirements: ['r1'], base, paths:p.files.slice(0,16).map(f=>f.path), diffChars:100,otherContextChars:100, dependencies: [], verification: ['npm test'] },
      {id:'slice2',requirements:['r1'],base,paths:p.files.slice(16).map(f=>f.path),diffChars:100,otherContextChars:100,dependencies:['slice1'],verification:['npm test']}] as never[];
    expect(validatePlan(p).status).toBe('decompose');
    p.decomposition = [{ id: 'slice1', requirements: [], base, dependencies: ['missing'], verification: [] }] as never[];
    expect(validatePlan(p).status).toBe('invalid');
  });
  it('a passing forecast cannot authorize an oversized actual revision; local CLI collection is read-only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scope-fixture-'));
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
    try {
      git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.com'); // public-ok
      await writeFile(join(dir, 'initial.md'), 'base'); git('add', '.'); git('commit', '-qm', 'base'); const revision = git('rev-parse', 'HEAD');
      const p = { ...plan(), base: revision };
      expect(validatePlan(p).status).toBe('pass');
      for (let i = 0; i < 31; i++) await writeFile(join(dir, `f${i}.ts`), 'export const x = 1;');
      git('add', '.'); git('commit', '-qm', 'oversized'); const actualHead = git('rev-parse', 'HEAD');
      const before = git('status', '--porcelain');
      const r = await preflight({ mode: 'actual', repository: dir, base: revision, head: actualHead, plan: p, contextSources: [{ref:'ticket',chars:100}] });
      expect(r.status).toBe('decompose'); expect(r.observations.reviewableFiles).toBe(31); expect(r.policyHash).toBe(policyHash);
      expect(r.reasons.some(r => r.code === 'unplanned-path')).toBe(true);
      expect(git('status', '--porcelain')).toBe(before); expect(git('rev-parse', 'HEAD')).toBe(actualHead);
      await writeFile(join(dir, 'untracked.ts'), 'pending');
      expect((await preflight({ mode: 'actual', repository: dir, base: revision, head: actualHead, plan: p, contextSources: [{ref:'ticket',chars:100}] })).status).toBe('invalid');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

import { vi } from 'vitest';
import { scopeMain } from '../src/review/preflight.js';
import { source } from '../src/review/context.js';
it('exports versioned schema/policy, structured CLI failures and context defaults', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scope-cli-'));
  const output: string[] = [], log = vi.spyOn(console, 'log').mockImplementation(s => { output.push(String(s)); });
  try {
    expect(await scopeMain(['policy'])).toBe(0);
    expect(JSON.parse(output.pop()!).policyHash).toBe(policyHash);
    expect(await scopeMain(['schema'])).toBe(0);
    expect(JSON.parse(output.pop()!).properties.version.const).toBe(1);
    expect(await scopeMain(['actual'])).toBe(1);
    expect(JSON.parse(output.pop()!).status).toBe('invalid');
    expect(await scopeMain(['forecast',join(dir,'missing.json')])).toBe(1);
    await writeFile(join(dir,'malformed.json'), '{');
    expect(await scopeMain(['forecast',join(dir,'malformed.json')])).toBe(1);
    await writeFile(join(dir,'missing-plan.json'), JSON.stringify({repository:dir,base}));
    expect(await scopeMain(['forecast',join(dir,'missing-plan.json')])).toBe(1);
    expect(JSON.parse(output.pop()!).reasons[0].code).toBe('plan-schema');
    expect(source('boundary','x'.repeat(POLICY.sourceChars)).truncated).toBe(false);
    expect(source('boundary','x'.repeat(POLICY.sourceChars+1)).truncated).toBe(true);
  } finally { log.mockRestore(); await rm(dir,{recursive:true,force:true}); }
});

it('measures real base imports, actual sources/diff/context and refuses excluded evidence before reading content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scope-context-'));
  const git = (...args:string[]) => execFileSync('git',['-C',dir,...args],{encoding:'utf8'}).trim();
  try {
    git('init','-q'); git('config','user.name','Fixture'); git('config','user.email','fixture@example.com'); // public-ok
    await writeFile(join(dir,'main.ts'), "import './helper.js';\n");
    await writeFile(join(dir,'helper.ts'), 'export const value = 1;');
    await writeFile(join(dir,'test.ts'), 'test'); git('add','.');git('commit','-qm','base'); const revision=git('rev-parse','HEAD');
    const p=plan(); p.base=revision; p.files=[{path:'main.ts',status:'modified',sourceChars:10,imports:[]}]; p.tasks[0]!.paths=['main.ts'];p.tests[0]!.paths=['test.ts'];
    const forecast=await preflight({mode:'forecast',repository:dir,base:revision,plan:p});
    expect(forecast.status).toBe('pass'); expect(forecast.observations.sources).toBe(2);
    expect((await preflight({mode:'forecast',repository:dir,base:revision,plan:p,config:{exclude:['helper.ts']}})).status).toBe('invalid');
    await writeFile(join(dir,'main.ts'), "import './helper.js';\nexport const x = 1;\n");git('add','.');git('commit','-qm','small change');const revisionHead=git('rev-parse','HEAD');
    const input={mode:'actual' as const,repository:dir,base:revision,head:revisionHead,plan:p,contextSources:[]};
    const actual=await preflight(input);expect(actual.status).toBe('pass');expect(actual.observations.sources).toBe(2);
    expect(actual.binding).toMatchObject({base:revision,head:revisionHead});
    expect((await preflight({...input,contextSources:[{ref:'ticket',chars:80001}]})).reasons.some(r=>r.code==='sourceChars')).toBe(true);
    expect((await preflight({...input,contextSources:Array.from({length:7},(_,i)=>({ref:String(i),chars:75000}))})).reasons.some(r=>r.code==='combinedChars')).toBe(true);
    expect((await preflight({...input,contextSources:undefined})).status).toBe('invalid');
    await writeFile(join(dir,'helper.ts'), 'x'.repeat(POLICY.sourceChars+1));git('add','.');git('commit','-qm','oversized source');
    const oversized=await preflight({...input,head:git('rev-parse','HEAD')});
    expect(oversized.status).toBe('decompose');expect(oversized.reasons.some(r=>r.code==='sourceChars')).toBe(true);
    expect(oversized.observations.sourceChars).toBe(POLICY.sourceChars+1);
    await writeFile(join(dir,'helper.ts'),'export const value = 1;');
    const largePaths=['large0.ts','large1.ts','large2.ts','large3.ts'];
    for(const path of largePaths) await writeFile(join(dir,path),'x'.repeat(70000));
    git('add','.');git('commit','-qm','oversized aggregate and patch');
    const large=await preflight({...input,head:git('rev-parse','HEAD')});
    expect(large.status).toBe('decompose');
    expect(large.reasons.some(r=>r.code==='diffChars')).toBe(true);
    expect(large.reasons.some(r=>r.code==='combinedChars')).toBe(true);
    await writeFile(join(dir,'private.json'),'synthetic sensitive fixture');git('add','.');git('commit','-qm','excluded fixture');
    const excluded=await preflight({...input,head:git('rev-parse','HEAD'),config:{exclude:['private.json']}});
    expect(excluded.status).toBe('invalid');expect(excluded.reasons[0]).toMatchObject({code:'excluded-path',path:'private.json'});

  } finally { await rm(dir,{recursive:true,force:true}); }
});

it('enforces the imported-source boundary without recursively following imports', async () => {
  for (const n of [79,80]) {
    const imports=Array.from({length:n},(_,i)=>`lib${i}.ts`), tracked=new Set(['main.ts',...imports]);
    const read=async (_r:string,path:string) => path==='main.ts' ? imports.map(p=>`import './${p}';`).join('\n') : "import './untracked.ts';";
    const collect=collectCode([{path:'main.ts',status:'modified'}],head,base,tracked,read);
    if(n===79) expect(await collect).toHaveLength(80);
    else await expect(collect).rejects.toThrow(/sources/);
  }
  const removed=await collectCode([{path:'removed.ts',status:'removed'}],head,base,new Set(['private.ts']),async()=>"import './private.ts';",['private.ts']);
  expect(removed).toHaveLength(1);expect(removed[0]!.revision).toBe(base);
});

it('retains the stricter credential-name exclusion for immediate imports', async () => {
  await expect(collectCode([{path:'main.ts',status:'modified'}],head,base,new Set(['load-credentials.ts']),async()=>"import './load-credentials.ts';")).rejects.toThrow(/excluded/);
  const p=plan(); p.files[0]!.imports=[{path:'load-credentials.ts',sourceChars:10}] as never[];
  expect(validatePlan(p).status).toBe('invalid');
});

it('includes forecast non-code sources in per-source and aggregate budgets', () => {
  const p = {...plan(),contextSources:[{ref:'ticket',chars:80001}]};
  expect(validatePlan(p).reasons.some(r=>r.code==='sourceChars')).toBe(true);
  p.contextSources=Array.from({length:7},(_,i)=>({ref:String(i),chars:75000}));
  expect(validatePlan(p).reasons.some(r=>r.code==='combinedChars')).toBe(true);
});
