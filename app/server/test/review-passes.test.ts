import { describe, it, expect, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runReview, evidence, digest, type GateIO, type Job, type Snapshot, type Source, type Verdict } from '../src/review/gate.js';
import { mergeVerdicts, partition, reviewInPasses, splitDiff, PASS_CHARS, reviewTransportBytes, type InventoryPart, type InventoryIdentity } from '../src/review/passes.js';
import { collectCode, type ChangedFile } from '../src/review/scope.js';
import { codexReview, notifyOwner, type HostConfig } from '../src/review/adapters.js';
import { ownerNotice } from '../src/review/worker.js';
import { source, boardSources } from '../src/review/context.js';
import { POLICY } from '../src/review/policy.js';

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const src = (ref: string, text: string): Source => ({ ref, revision: digest(text), text, essential: true, missing: false, truncated: false });
const fileDiff = (path: string, body: string) => `diff --git a/${path} b/${path}\nindex 1..2 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${body}\n`;
/** `count` changed files of `chars` each, plus one unchanged import, the ticket and the builder's result. */
function large(count: number, chars: number): Snapshot {
  const paths = Array.from({ length: count }, (_, i) => `src/f${String(i).padStart(3, '0')}.ts`);
  return { repo: 'example/engine', pr: 7, head, base, branch: 'main', merged: null, checks: [{ name: 'test', state: 'pass' }],
    sources: [src('ticket', 'Acceptance: working tests'), src('note:t_123abc/RESULT.md', 'Tests passed'),
      src(`github:diff:${head}`, paths.map(p => fileDiff(p, `+${p}`)).join('')),
      ...paths.map(p => src(`github:source:${head}:${p}`, p.padEnd(chars, 'x'))), src(`github:source:${head}:src/imported.ts`, 'export const shared = 1;')] };
}
const checked = (ref = 'ticket') => ({ status: 'checked' as const, evidence: [ref], rationale: 'Verified against the ticket and tests' });
const verdict = (e: string, findings: Verdict['findings'] = []): Verdict => ({ decision: findings.length ? 'reject' : 'accept', reviewer: 'auditor', repo: 'example/engine', pr: 7, head, base, evidence: e,
  categories: { security: checked(), compatibility: checked(), migrations: checked(), regressions: checked(), scope: checked(), placeholders: checked(), tests: checked() }, findings });
const finding = (severity: 'critical' | 'high' | 'medium' | 'low', location: string) => ({ severity, location, evidence: 'Observed defect', impact: 'Breaks callers', fix: 'Fix it', verification: 'Rerun the test' });

describe('PR size never rejects a review', () => {
  it('splits a diff per file and loses no byte', () => {
    const diff = fileDiff('a.ts', '+a') + fileDiff('dir/b c.ts', '+b') + 'diff --git a/img.png b/img.png\nBinary files differ\n';
    const chunks = splitDiff(diff);
    expect(chunks.map(c => c.path)).toEqual(['a.ts', 'dir/b c.ts', 'img.png']);
    expect(chunks.map(c => c.text).join('')).toBe(diff);
    expect(splitDiff('')).toEqual([]);
  });

  it('decodes real Git quoted paths and reconstructs oversized Unicode-file fragments with contiguous offsets', async () => {
    const dir=await mkdtemp(join(tmpdir(),'review-git-paths-'));
    const git=(...args:string[])=>execFileSync('git',['-C',dir,...args],{encoding:'utf8',maxBuffer:8*1024*1024});
    const unicode='東京-😀.md', spaced='folder b/leaf file .txt', deleted='deleted b/file space.txt';
    const controlled='tab\tline\nquote"back\\slash-\x07\b\f\r\v.txt';
    const binary='binary b/payload file.bin', mode='空 mode b/名 space.txt';
    const names=[unicode,spaced,deleted,controlled,binary,mode];
    try {
      git('init','-q');git('config','core.quotePath','true');git('config','core.filemode','true');
      for(const name of names) {
        const file=join(dir,name);await mkdir(dirname(file),{recursive:true});
        await writeFile(file,name===binary?Buffer.from([0,1,2]):name===mode?'':'Old content\n');await chmod(file,0o644);
      }
      git('add','--','.');
      const content='++ b/spoofed-path\n-- a/spoofed-path\n'+'x'.repeat(PASS_CHARS+50_000)+'\n';
      await writeFile(join(dir,unicode),content);await writeFile(join(dir,spaced),'Changed spaces\n');
      await writeFile(join(dir,controlled),'Changed controls\n');await writeFile(join(dir,binary),Buffer.from([0,4,5]));
      await rm(join(dir,deleted));await chmod(join(dir,mode),0o755);
      const diff=git('diff','--no-ext-diff','--no-textconv','--binary','--'), chunks=splitDiff(diff);
      expect(chunks.map(x=>x.path).sort()).toEqual([...names].sort());
      expect(chunks.map(x=>x.text).join('')).toBe(diff);
      expect(chunks.find(x=>x.path===deleted)!.text).toContain('+++ /dev/null');
      expect(chunks.find(x=>x.path===binary)!.text).toContain('GIT binary patch');
      expect(chunks.find(x=>x.path===mode)!.text).toContain('new mode 100755');
      const chunk=chunks.find(x=>x.path===unicode)!;
      expect(chunk.text.split('\n',1)[0]).toMatch(/"a\/\\[0-7]{3}/);
      expect(chunk.text).toContain('+++ b/spoofed-path');
      const ref=`github:diff:${head}`, codeRef=`github:source:${head}:${unicode}`;
      const snapshot:Snapshot={...large(0,0),sources:[src('ticket','Acceptance: complete quoted paths'),src(ref,chunk.text),src(codeRef,content)]};
      const passes=partition(snapshot), delivered:{index:number;start:number;end:number;text:string}[]=[];
      for(const pass of passes) {
        expect(pass.files).not.toContain('');
        const pieces=pass.snapshot.sources.filter(x=>x.ref===ref), parts=(pass.parts??[]).filter(x=>x.ref===ref);
        expect(parts.length).toBe(pieces.length);
        for(const [i,part] of parts.entries()) {
          expect(part.path).toBe(unicode);
          delivered.push({index:part.index,start:part.start,end:part.end,text:pieces[i]!.text});
        }
      }
      expect(delivered.length).toBeGreaterThan(1);delivered.sort((a,b)=>a.index-b.index);
      let offset=0;
      for(const [i,part] of delivered.entries()) {
        expect(part.index).toBe(i+1);expect(part.start).toBe(offset);
        expect(chunk.text.slice(part.start,part.end)).toBe(part.text);offset=part.end;
      }
      expect(offset).toBe(chunk.text.length);expect(delivered.map(x=>x.text).join('')).toBe(chunk.text);
    } finally { await rm(dir,{recursive:true,force:true}); }
  });

  it('leaves a snapshot that fits one reviewer call untouched', () => {
    const s = large(3, 100);
    expect(partition(s)).toEqual([{ snapshot: s, files: [] }]);
  });

  it('reviews 96 files in passes: each file and context source is complete, with the bounded ticket in every pass', () => {
    const s = large(96, 20_000), total = s.sources.reduce((n, x) => n + x.text.length, 0);
    expect(total).toBeGreaterThan(PASS_CHARS);
    expect(96).toBeGreaterThan(POLICY.reviewableFiles); // the old gate refused this PR outright
    const passes = partition(s);
    expect(passes.length).toBeGreaterThan(1);
    for (const p of passes) {
      expect(p.snapshot.sources.map(x => x.ref)).toEqual(expect.arrayContaining(['ticket']));
      expect(p.snapshot.sources.reduce((n, x) => n + Buffer.byteLength(JSON.stringify(x.text)), 0)).toBeLessThanOrEqual(PASS_CHARS);
      expect(p.snapshot.sources.some(x => x.truncated)).toBe(false);
      expect(p.snapshot).toMatchObject({ repo: s.repo, pr: s.pr, head, base });
    }
    const code = passes.flatMap(p => p.snapshot.sources.filter(x => x.ref.startsWith('github:source:')).map(x => x.ref));
    expect(code.sort()).toEqual(s.sources.filter(x => x.ref.startsWith('github:source:')).map(x => x.ref).sort());
    const diffs = passes.flatMap(p => p.snapshot.sources.filter(x => x.ref === `github:diff:${head}`).flatMap(x => splitDiff(x.text)));
    expect(diffs.map(d => d.path).sort()).toEqual(splitDiff(s.sources[2]!.text).map(d => d.path).sort());
    expect(passes.flatMap(p => p.files)).toHaveLength(97);
    // A file's diff rides with its source.
    for (const p of passes) for (const d of p.snapshot.sources.filter(x => x.ref === `github:diff:${head}`).flatMap(x => splitDiff(x.text))) expect(p.files).toContain(d.path);
  });

  it('budgets a pass by the bytes actually sent, so escaped newlines and quotes cannot overflow the reviewer transport', () => {
    const s = large(2, 20);
    // 260k raw characters each, 520k once JSON-escaped: two of them fit the budget raw but not as sent.
    for (const name of ['q1', 'q2']) s.sources.push(src(`github:source:${head}:src/${name}.ts`, '"\n'.repeat(130_000)));
    const passes = partition(s);
    expect(passes.length).toBeGreaterThan(1);
    expect(passes.find(p => p.files.includes('src/q1.ts'))!.files).not.toContain('src/q2.ts');
  });

  it('transports a file larger than a whole pass in bounded identified Unicode-safe parts', () => {
    const s = large(2, 20), ref = `github:source:${head}:src/huge.ts`;
    const text = '\"\n😀'.repeat(130_000);
    s.sources.push(src(ref, text));
    const passes = partition(s), huge = passes.filter(p => p.files.includes('src/huge.ts'));
    expect(huge.length).toBeGreaterThan(1);
    const transported = huge.flatMap(p => p.snapshot.sources.filter(x => x.ref === ref));
    expect(transported.map(x => x.text).join('')).toBe(text);
    expect(transported.every(x => !x.truncated && !/[\uD800-\uDBFF]$/.test(x.text))).toBe(true);
    expect(huge.flatMap(p => p.parts ?? []).map(p => p.index)).toEqual(transported.map((_, i) => i + 1));
    expect(huge.flatMap(p => p.parts ?? []).every(p => p.ref === ref && p.total === transported.length)).toBe(true);
    expect(passes.every(p => reviewTransportBytes(p.snapshot) <= PASS_CHARS)).toBe(true);
  });

  it('partitions complete large prior-finding histories once in order within every measured call bound', async () => {
    const s = large(8, 40_000);
    const history = Array.from({ length: 7 }, (_, round) => ({ round, pr: 7,
      verdict: JSON.stringify({ findings: [{fix: (round % 2 ? '\"\n' : 'xx').repeat(24_900)}] }), truncated: false }));
    const refs = boardSources('board:t_123abc:earlier_findings', history);
    s.sources.splice(2, 0, ...refs);
    expect(refs.length).toBeGreaterThan(1);
    const calls: { part: Snapshot; index: number }[] = [];
    const result = await reviewInPasses(s, evidence(s), async (part, bound, pass) => {
      calls.push({part,index:pass.index});
      expect(reviewTransportBytes(part) + Buffer.byteLength(JSON.stringify(pass))).toBeLessThanOrEqual(PASS_CHARS);
      expect(part.sources.some(x => x.truncated)).toBe(false);
      expect(pass.allHistory).toEqual(refs.map(x => x.ref));
      expect(part.sources.map(x => x.ref)).toEqual(expect.arrayContaining(['ticket']));
      return verdict(bound);
    });
    expect(result.decision).toBe('accept'); expect(calls.length).toBeGreaterThan(1);
    const delivered = calls.sort((a,b) => a.index-b.index).flatMap(p => p.part.sources.filter(x => x.ref.startsWith('board:t_123abc:earlier_findings')));
    expect(delivered.map(x => x.ref)).toEqual(refs.map(x => x.ref));
    expect(JSON.parse(delivered.map(x => x.text).join(''))).toEqual(history);
    expect(new Set(calls.flatMap(p => p.part.sources.filter(x => x.ref.startsWith('github:source:')).map(x => x.ref))).size).toBe(9);
  });

  it('bounds a single huge diff without losing its text or source identity', () => {
    const s = large(0, 0), ref = `github:diff:${head}`;
    const diff = fileDiff('huge.ts', '+' + '\"\n'.repeat(300_000));
    s.sources = [...s.sources.filter(x => !x.ref.startsWith('github:diff:')), src(ref,diff)];
    const passes = partition(s);
    expect(passes.length).toBeGreaterThan(1);
    expect(passes.flatMap(p => p.snapshot.sources.filter(x => x.ref === ref)).map(x => x.text).join('')).toBe(diff);
    expect(passes.every(p => reviewTransportBytes(p.snapshot) <= PASS_CHARS && p.snapshot.sources.every(x => !x.truncated))).toBe(true);
    const deliveredParts = passes.flatMap(p => p.parts ?? []).filter(p => p.ref === ref);
    expect(deliveredParts.map(p => p.index)).toEqual(deliveredParts.map((_,i) => i+1));
  });

  it('identifies oversized per-file diff fragments unambiguously under one aggregate diff ref', () => {
    const s=large(0,0), ref=`github:diff:${head}`;
    const originals=new Map([['a.ts',fileDiff('a.ts','+'+'a'.repeat(PASS_CHARS+50))],['b.ts',fileDiff('b.ts','+'+'b'.repeat(PASS_CHARS+50))]]);
    s.sources=s.sources.filter(x=>x.ref!==ref);s.sources.push(src(ref,[...originals.values()].join('')));
    const passes=partition(s), chunks=new Map<string,{index:number;start:number;end:number;text:string}[]>();
    for(const pass of passes) {
      const sources=pass.snapshot.sources.filter(x=>x.ref===ref);
      const parts=(pass.parts??[]).filter(x=>x.ref===ref);
      expect(parts.length).toBe(sources.length);
      for(const [i,part] of parts.entries()) {
        expect(part.path).toBeDefined();
        const values=chunks.get(part.path!)??[];
        values.push({index:part.index,start:part.start,end:part.end,text:sources[i]!.text});chunks.set(part.path!,values);
      }
    }
    expect([...chunks.keys()]).toEqual([...originals.keys()]);
    for(const [path,original] of originals) {
      const delivered=chunks.get(path)!.sort((a,b)=>a.index-b.index);
      expect(delivered.map(x=>x.index)).toEqual(delivered.map((_,i)=>i+1));
      expect(delivered.map(x=>x.text).join('')).toBe(original);
      for(const part of delivered)expect(original.slice(part.start,part.end)).toBe(part.text);
    }
  });

  it('dispatches complete individually bounded context even when notes, builder and conversation aggregates exceed a call', async () => {
    const s = large(3, 20_000);
    const context = Array.from({length:14},(_,i) => source(i % 3 === 0 ? `note:project-${i}.md` : `board:t_123abc:${i % 3 === 1 ? 'comments' : 'conversation'}-${i}`,
      `${i}:` + '\"\n'.repeat(19_000)));
    s.sources.splice(2,0,...context);
    expect(context.every(x=>!x.truncated && x.text.length <= POLICY.sourceChars)).toBe(true);
    expect(context.reduce((n,x)=>n+Buffer.byteLength(x.text),0)).toBeGreaterThan(PASS_CHARS);
    const calls:{part:Snapshot;index:number}[]=[];
    const result=await reviewInPasses(s,evidence(s),async(part,bound,pass)=>{
      calls.push({part,index:pass.index});
      expect(reviewTransportBytes(part)+Buffer.byteLength(JSON.stringify(pass))).toBeLessThanOrEqual(PASS_CHARS);
      expect(part.sources.map(x=>x.ref)).toContain('ticket');
      expect(part.sources.every(x=>!x.truncated && !x.missing)).toBe(true);
      expect(pass.allSources).toEqual(s.sources.map(x=>x.ref));
      return verdict(bound);
    });
    expect(result.decision).toBe('accept');expect(calls.length).toBeGreaterThan(1);
    const ordered=calls.sort((a,b)=>a.index-b.index).flatMap(x=>x.part.sources);
    for(const original of s.sources.filter(x=>x.ref!=='ticket')) {
      const delivered=ordered.filter(x=>x.ref===original.ref);
      expect(delivered.map(x=>x.text).join('')).toBe(original.text);
      expect(delivered.every(x=>x.revision===original.revision)).toBe(true);
    }
    expect(ordered.filter(x=>context.some(c=>c.ref===x.ref)).map(x=>x.ref)).toEqual(context.map(x=>x.ref));
  });

  it('transports an oversized ticket completely instead of rejecting its aggregate or treating a prefix as full authority', async () => {
    const s=large(2,20_000), ticket=s.sources[0]!;
    ticket.text='Acceptance: complete review. '+'\"\n😀'.repeat(130_000); ticket.revision=digest(ticket.text);
    const calls:{part:Snapshot;index:number}[]=[];
    const result=await reviewInPasses(s,evidence(s),async(part,bound,pass)=>{
      calls.push({part,index:pass.index});
      expect(reviewTransportBytes(part)+Buffer.byteLength(JSON.stringify(pass))).toBeLessThanOrEqual(PASS_CHARS);
      expect(part.sources.every(x=>!x.truncated)).toBe(true);
      const v=verdict(bound);for(const c of Object.values(v.categories))c.evidence=[part.sources[0]!.ref];return v;
    });
    expect(result.decision).toBe('accept');
    expect(calls.sort((a,b)=>a.index-b.index).flatMap(x=>x.part.sources.filter(x=>x.ref==='ticket')).map(x=>x.text).join('')).toBe(ticket.text);
  });

  it('distributes a complete oversized source inventory with a stable identity instead of imposing an inventory-size gate', async () => {
    const s=large(1,20_000);
    const extra=Array.from({length:120},(_,i)=>src(`note:${String(i).padStart(3,'0')}-`+'path-'.repeat(100)+'.md', 'Complete note '+i+'x'.repeat(7_000)));
    s.sources.splice(2,0,...extra);
    const calls:{part:Snapshot;index:number;inventoryParts:InventoryPart[];identity:InventoryIdentity}[]=[];
    const result=await reviewInPasses(s,evidence(s),async(part,bound,pass)=>{
      expect(reviewTransportBytes(part)+Buffer.byteLength(JSON.stringify(pass))).toBeLessThanOrEqual(PASS_CHARS);
      expect(part.sources.map(x=>x.ref)).toContain('ticket');
      expect(pass.allSources).toEqual([]);expect(pass.allFiles).toEqual([]);
      expect(pass.inventory!.sources).toBe(s.sources.length);
      calls.push({part,index:pass.index,inventoryParts:pass.inventoryParts??[],identity:pass.inventory!});return verdict(bound);
    });
    expect(result.decision).toBe('accept');
    const ordered=calls.sort((a,b)=>a.index-b.index);
    const chunks=ordered.flatMap(x=>x.inventoryParts);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map(x=>x.index)).toEqual(chunks.map((_,i)=>i+1));
    const text=chunks.map(x=>x.text).join('');
    const inventory=JSON.parse(text);
    expect(inventory.sources).toEqual(s.sources.map(x=>x.ref));
    expect(inventory.files).toEqual(['src/f000.ts','src/imported.ts']);
    expect(calls.every(x=>x.identity.digest===digest(text)&&x.identity.parts===chunks.length)).toBe(true);
    for(const original of extra)expect(ordered.flatMap(x=>x.part.sources).filter(x=>x.ref===original.ref).map(x=>x.text).join('')).toBe(original.text);
  });

  it('keeps actual source evidence in metadata-only inventory calls when no bounded shared ticket exists', async () => {
    const s=large(0,0);s.sources=s.sources.filter(x=>!x.ref.startsWith('github:diff:'));
    s.sources[0]!.text='Acceptance: complete evidence '+'x'.repeat(400_000);s.sources[0]!.revision=digest(s.sources[0]!.text);
    s.sources.push(...Array.from({length:4},(_,i)=>src(`note:${i}-`+'long-ref-'.repeat(7_000),'Complete note')));
    const delivered:{part:Snapshot;parts:InventoryPart[]}[]=[];
    await reviewInPasses(s,evidence(s),async(part,bound,pass)=>{
      expect(part.sources.length).toBeGreaterThan(0);
      expect(reviewTransportBytes(part)+Buffer.byteLength(JSON.stringify(pass))).toBeLessThanOrEqual(PASS_CHARS);
      delivered.push({part,parts:pass.inventoryParts??[]});
      const v=verdict(bound);for(const c of Object.values(v.categories))c.evidence=[part.sources[0]!.ref];return v;
    });
    expect(delivered.some(x=>x.parts.some(p=>p.repeatedEvidence))).toBe(true);
    const inventory=delivered.flatMap(x=>x.parts);
    expect(JSON.parse(inventory.map(x=>x.text).join('')).sources).toEqual(s.sources.map(x=>x.ref));
    for(const original of s.sources) {
      const content=delivered.filter(x=>!x.parts.some(p=>p.repeatedEvidence)).flatMap(x=>x.part.sources).filter(x=>x.ref===original.ref).map(x=>x.text).join('');
      expect(content).toBe(original.text);
    }
  });

  it('dispatches many complete context sources and adaptive inventories through the actual bounded adapter prompt', async () => {
    const s=large(2,20_000);
    s.sources.splice(2,0,...Array.from({length:120},(_,i)=>src(`note:${i}-`+'source-path-'.repeat(50)+'.md',`Note ${i}:`+'x'.repeat(7_000))));
    const bound=evidence(s), prompts=new Map<number,string>();
    const processAdapter=await import('../src/review/process.js');
    const command=vi.spyOn(processAdapter,'command').mockImplementation(async(_exe,argv,...rest)=>{
      if(argv.includes('login'))return 'Logged in using ChatGPT';
      const prompt=String(rest.at(-1));
      const index=Number(/This is pass (\d+) of/.exec(prompt)?.[1]??1);prompts.set(index,prompt);
      return JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(verdict(bound))}})+'\n'+JSON.stringify({type:'turn.completed'});
    });
    const host={reviewer:{argv:[process.execPath],cwd:'/tmp',home:'/tmp',model:'fixture'}} as HostConfig;
    try {
      const result=await reviewInPasses(s,bound,async(part,e,pass)=>{
        const response=await codexReview(host,'auditor',part,e,pass);
        const prompt=prompts.get(pass.index)!;
        expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(PASS_CHARS);
        expect(prompt).toContain(JSON.stringify(pass.inventory));
        expect(prompt).toContain(JSON.stringify(pass.inventoryParts??[]));
        return response;
      });
      expect(result.decision).toBe('accept');expect(prompts.size).toBeGreaterThan(1);
    } finally { command.mockRestore(); }
  });

  it('does not advertise missing inventory parts for a complete snapshot that fits one call', async () => {
    const s=large(1,20);
    s.sources.splice(2,0,...Array.from({length:120},(_,i)=>src(`note:${i}-`+'long-path-'.repeat(50),'Complete note')));
    let calls=0;
    await reviewInPasses(s,evidence(s),async(part,bound,pass)=>{
      calls++;expect(part).toBe(s);expect(pass.total).toBe(1);
      expect(pass.inventory!.parts).toBe(0);expect(pass.inventoryParts).toBeUndefined();
      expect(pass.allSources).toEqual(s.sources.map(x=>x.ref));return verdict(bound);
    });
    expect(calls).toBe(1);
  });

  it('accepts only when every pass accepts, and one rejecting pass rejects the PR with its findings first by severity', async () => {
    const s = large(96, 20_000), e = evidence(s);
    const seen: { index: number; total: number; files: string[]; allFiles: string[] }[] = [];
    const accepted = await reviewInPasses(s, e, async (_part, bound, pass) => { seen.push(pass); return verdict(bound); });
    expect(accepted.decision).toBe('accept'); expect(accepted.findings).toEqual([]); expect(accepted.evidence).toBe(e);
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.map(p => p.index).sort((a, b) => a - b)).toEqual(seen.map((_, i) => i + 1));
    expect(seen.every(p => p.total === seen.length && p.allFiles.length === 97)).toBe(true);
    expect(accepted.categories.security.rationale).toContain(`Pass 1/${seen.length}:`);
    const rejected = await reviewInPasses(s, e, async (_part, bound, pass) => verdict(bound, pass.index === 2 ? [finding('low', 'b.ts:1'), finding('critical', 'a.ts:9')] : []));
    expect(rejected.decision).toBe('reject');
    expect(rejected.findings.map(f => f.location)).toEqual(['a.ts:9', 'b.ts:1']);
  });

  it('fails the whole review when one pass fails or answers for another revision, so nothing is accepted half-read', async () => {
    const s = large(96, 20_000), e = evidence(s);
    await expect(reviewInPasses(s, e, async (_p, bound, pass) => { if (pass.index === 2) throw new Error('Reviewer did not finish'); return verdict(bound); })).rejects.toThrow('Reviewer did not finish');
    await expect(reviewInPasses(s, e, async (_p, bound, pass) => ({ ...verdict(bound), head: pass.index === 2 ? 'c'.repeat(40) : head }))).rejects.toThrow(/different revisions/);
    await expect(reviewInPasses(s, e, async (_p, bound, pass) => ({ ...verdict(bound), decision: pass.index === 1 ? 'reject' : 'accept' }))).rejects.toThrow(/contradicts/);
  });

  it('keeps the 30 most severe findings and says how many were left for the next round', () => {
    const many = [verdict('e'.repeat(64), Array.from({ length: 20 }, (_, i) => finding('low', `low:${i}`))), verdict('e'.repeat(64), Array.from({ length: 20 }, (_, i) => finding('high', `high:${i}`)))];
    const merged = mergeVerdicts(many);
    expect(merged.findings).toHaveLength(30);
    expect(merged.findings.slice(0, 20).every(f => f.severity === 'high')).toBe(true);
    expect(merged.findings[29]!.evidence).toContain('10 further lower-ranked findings');
  });

  it('runs the gate end to end on a 96-file PR: reviewed in passes, accepted, merged and deployed', async () => {
    const s = large(96, 20_000), merged = 'c'.repeat(40);
    const job: Job = { id: 1, card: 't_123abc', builder: 'builder', reviewer: 'auditor', target: 'test', round: 0, state: 'queued', snapshot: null, verdict: null, merged: null, deployed: null };
    let current = s, calls = 0;
    const io: GateIO = { gather: async () => structuredClone(current),
      review: (snap, e) => reviewInPasses(snap, e, async (_part, bound) => { calls++; return verdict(bound); }),
      save: async patch => { Object.assign(job, patch); }, reject: async () => { throw new Error('unexpected rejection'); },
      merge: async () => { current = { ...current, merged }; return merged; }, deploy: async r => r, health: async () => true, verifyMerge: async () => {}, complete: async () => {} };
    await runReview(job, ['test'], io);
    expect(job.error ?? null).toBeNull();
    expect(job.state).toBe('done'); expect(job.verdict?.decision).toBe('accept'); expect(calls).toBeGreaterThan(1);
    expect(job.verdict?.findings.some(f => f.code?.startsWith('scope-'))).toBe(false);
  });

  it('the gate collector reads every source past the planning budgets; the planning CLI path still stops at them', async () => {
    const files: ChangedFile[] = Array.from({ length: POLICY.changedFiles + 20 }, (_, i) => ({ path: `src/f${i}.ts`, status: 'modified' as const }));
    const read = async (_revision: string, path: string) => path === 'src/f0.ts' ? 'y'.repeat(POLICY.sourceChars + 1) : 'export {};';
    const tracked = new Set(files.map(f => f.path));
    const code = await collectCode(files, head, base, tracked, read, [], false);
    expect(code).toHaveLength(POLICY.changedFiles + 20);
    expect(code[0]!.text).toHaveLength(POLICY.sourceChars + 1);
    await expect(collectCode(files, head, base, tracked, read)).rejects.toThrow();
    expect(source('whole', code[0]!.text, true, Number.MAX_SAFE_INTEGER).truncated).toBe(false);
  });
});

describe('the owner hears about a rejection or a block', () => {
  const job = (patch: Partial<Job>): Job => ({ id: 64, card: 't_7d94e013', builder: 'm4', reviewer: 'vera', target: 'engine', round: 1, state: 'reviewing', merged: null, deployed: null, verdict: null,
    snapshot: { repo: 'example/engine', pr: 183, head, base, branch: 'main', merged: null, checks: [], sources: [] }, ...patch });
  const fresh = { state: 'queued' as const, error: null };

  it('writes one line for a rejection with the PR, the round, the findings and who holds the card', () => {
    const text = ownerNotice(job({ state: 'rejected', verdict: verdict('e'.repeat(64), [finding('high', 'PR base'), finding('low', 'x.ts:3')]) }), fresh, 'Areas/projects 1')!;
    expect(text).toContain('vera: changes requested on t_7d94e013 "Areas/projects 1", round 1, 2 findings.');
    expect(text).toContain('https://github.com/example/engine/pull/183');
    expect(text).toContain('- [high] PR base: Observed defect');
    expect(text).toContain('The card is back with m4.');
    expect(text).not.toContain('—');
  });

  it('writes one line for a new block and stays quiet when a retry blocks on the same error', () => {
    const blocked = job({ state: 'blocked', error: 'Deployment health failed', merged: 'c'.repeat(40) });
    expect(ownerNotice(blocked, fresh, '')).toContain('vera: review blocked on t_7d94e013: Deployment health failed.');
    expect(ownerNotice(blocked, fresh, '')).toContain('Already merged');
    expect(ownerNotice(blocked, { state: 'blocked', error: 'Deployment health failed' }, '')).toBeNull();
    expect(ownerNotice(blocked, { state: 'blocked', error: 'Required CI missing, failed or pending' }, '')).toContain('review blocked');
    expect(ownerNotice(job({ state: 'reviewing', error: 'Waiting for required CI: app' }), fresh, '')).toBeNull();
    expect(ownerNotice(job({ state: 'approved' }), fresh, '')).toBeNull();
  });

  it('calls only the owner-registered program with the text as one argument, and a failing notifier never throws', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'review-notify-'));
    try {
      const out = join(dir, 'sent.txt'), program = join(dir, 'notify.sh');
      await writeFile(program, `#!/bin/sh\nprintf '%s' "$1" > '${out}'\n`); await chmod(program, 0o700);
      const host = { home: dir, notify: { argv: [program], cwd: dir } } as unknown as HostConfig;
      expect(await notifyOwner(host, 'vera: review blocked on t_1; $(touch nope) `id`')).toBe(true);
      expect(await readFile(out, 'utf8')).toBe('vera: review blocked on t_1; $(touch nope) `id`');
      expect(await notifyOwner({ home: dir } as unknown as HostConfig, 'x')).toBe(false);
      expect(await notifyOwner({ home: dir, notify: { argv: [join(dir, 'missing')], cwd: dir } } as unknown as HostConfig, 'x')).toBe(false);
      expect(await notifyOwner({ home: dir, notify: { argv: ['relative'], cwd: dir } } as unknown as HostConfig, 'x')).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); vi.restoreAllMocks(); }
  });
});
