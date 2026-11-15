import { describe, it, expect, vi } from 'vitest';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReview, evidence, digest, type GateIO, type Job, type Snapshot, type Source, type Verdict } from '../src/review/gate.js';
import { mergeVerdicts, partition, reviewInPasses, splitDiff, PASS_CHARS } from '../src/review/passes.js';
import { collectCode, type ChangedFile } from '../src/review/scope.js';
import { notifyOwner, type HostConfig } from '../src/review/adapters.js';
import { ownerNotice } from '../src/review/worker.js';
import { source } from '../src/review/context.js';
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

  it('leaves a snapshot that fits one reviewer call untouched', () => {
    const s = large(3, 100);
    expect(partition(s)).toEqual([{ snapshot: s, files: [] }]);
  });

  it('reviews 96 files in passes: every diff chunk and source exactly once, context in every pass, nothing truncated', () => {
    const s = large(96, 20_000), total = s.sources.reduce((n, x) => n + x.text.length, 0);
    expect(total).toBeGreaterThan(PASS_CHARS);
    expect(96).toBeGreaterThan(POLICY.reviewableFiles); // the old gate refused this PR outright
    const passes = partition(s);
    expect(passes.length).toBeGreaterThan(1);
    for (const p of passes) {
      expect(p.snapshot.sources.map(x => x.ref)).toEqual(expect.arrayContaining(['ticket', 'note:t_123abc/RESULT.md']));
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

  it('gives a file larger than a whole pass its own pass, uncut', () => {
    const s = large(2, 20);
    s.sources.push(src(`github:source:${head}:src/huge.ts`, 'h'.repeat(PASS_CHARS + 5)));
    const passes = partition(s);
    const huge = passes.filter(p => p.files.includes('src/huge.ts'));
    expect(huge).toHaveLength(1);
    expect(huge[0]!.files).toEqual(['src/huge.ts']);
    expect(huge[0]!.snapshot.sources.find(x => x.ref.endsWith('src/huge.ts'))!.text).toHaveLength(PASS_CHARS + 5);
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
