import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { GitHub, type HostConfig, type Repository } from '../src/review/adapters.js';
import { preflight } from '../src/review/preflight.js';
import { policyHash, evaluate, scopeObservation } from '../src/review/policy.js';
import * as gate from '../src/review/gate.js';
import { tick } from '../src/review/worker.js';

const repo: Repository = { github: 'example/engine', gitDir: '/tmp/fixture.git', base: 'main', target: 'fixture', checks: ['test'], notes: ['design.md'] };
const base = 'a'.repeat(40), head = 'b'.repeat(40);
const revision = { number: 7, baseRefOid: base, headRefOid: head };
afterEach(() => vi.restoreAllMocks());

it('requests an immutable aggregate diff with the same flags as actual admission, never a commit-series patch', async () => {
  const github = new GitHub({ exclude: [] } as unknown as HostConfig, repo);
  github.gh = vi.fn(async () => 'main.ts\n');
  github.git = vi.fn(async args => args.includes('--name-only') ? 'main.ts\0' : args[0] === 'diff' ? 'net diff' : '');
  expect(await github.diff(revision)).toBe('net diff');
  expect(github.git).toHaveBeenCalledWith(['fetch', '--no-tags', 'https://github.com/example/engine.git', head, base]);
  expect(github.git).toHaveBeenCalledWith(['diff', '--name-only', '--no-renames', '-z', base, head, '--']);
  expect(github.git).toHaveBeenCalledWith(['diff', '--no-ext-diff', '--no-textconv', '--binary', base, head, '--']);
  expect(github.gh).not.toHaveBeenCalled();
});

it('refuses excluded aggregate paths before reading diff contents', async () => {
  const github = new GitHub({ exclude: ['private'] } as unknown as HostConfig, repo);
  github.gh = vi.fn(async () => 'private/note.md\n');
  github.git = vi.fn(async args => args.includes('--name-only') ? 'private/note.md\0' : '');
  await expect(github.diff(revision)).rejects.toThrow(/excluded/);
  expect(github.git).not.toHaveBeenCalledWith(expect.arrayContaining(['--binary']));
});

it('gives actual admission and live review the same final net diff after two correction commits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'review-net-diff-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], { encoding: 'utf8' });
  try {
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.com'); // public-ok
    const original = "import './helper.js';\nexport const value = 'base';\nexport const retained = true;\n";
    const final = original.replace("'base'", "'final'");
    await writeFile(join(dir, 'main.ts'), original);
    await writeFile(join(dir, 'helper.ts'), 'export const helper = true;\n');
    await writeFile(join(dir, 'removed.ts'), 'export const removed = true;\n');
    git('add', '.'); git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD').trim();
    await writeFile(join(dir, 'main.ts'), original.replace("'base'", "'interim-value'").replace('true', 'false') + '// removed interim line\n');
    await writeFile(join(dir, 'interim.ts'), '// transient file\n');
    git('add', '.'); git('commit', '-qm', 'interim correction');
    await writeFile(join(dir, 'main.ts'), final);
    await rm(join(dir, 'interim.ts')); await rm(join(dir, 'removed.ts'));
    git('add', '.'); git('commit', '-qm', 'final correction');
    const head = git('rev-parse', 'HEAD').trim(), s = { number: 7, baseRefOid: base, headRefOid: head };
    const aggregate = git('diff', '--no-ext-diff', '--no-textconv', '--binary', base, head, '--');
    const patch = git('format-patch', '--stdout', `${base}..${head}`);
    const github = new GitHub({ exclude: [] } as unknown as HostConfig, repo);
    github.git = async args => args[0] === 'fetch' ? '' : git(...args);
    github.gh = async args => {
      if (args.includes('--name-only')) return 'main.ts\nremoved.ts\n';
      if (args[0] === 'pr') return patch; // Reproduces the old --patch collection locally.
      return JSON.stringify([[{ filename: 'main.ts', status: 'modified' }, { filename: 'removed.ts', status: 'removed' }]]);
    };
    const diff = await github.diff(s), code = await github.code(s);
    expect(diff).toBe(aggregate);
    expect(patch.length).toBeGreaterThan(aggregate.length);
    for (const interim of ['interim-value', 'removed interim line', 'transient file', '+export const retained = false;']) {
      expect(patch).toContain(interim); expect(diff).not.toContain(interim);
    }
    expect(diff).toContain("+export const value = 'final';");
    expect(code.map(c => c.ref)).toEqual([`github:source:${head}:main.ts`, `github:source:${base}:removed.ts`, `github:source:${head}:helper.ts`]);
    expect(code[0]!.text).toBe(final);
    const contextSources = [{ ref: 'prior-findings-and-card-comments', chars: 42 }];
    const plan = { version: 1, policyHash, card: 'example-task', repository: repo.github, base,
      requirements: [{ id: 'r', description: 'Final revision', tasks: ['t'], tests: ['test'] }],
      tasks: [{ id: 't', requirements: ['r'], paths: ['main.ts', 'removed.ts'], tests: ['test'], dependencies: [] }],
      tests: [{ id: 'test', requirements: ['r'], paths: ['main.ts'], command: 'fixture' }], dependencies: [],
      files: [{ path: 'main.ts', status: 'modified', sourceChars: 200, imports: [{ path: 'helper.ts', sourceChars: 100 }] }, { path: 'removed.ts', status: 'removed', sourceChars: 100, imports: [] }],
      diffChars: 2000, otherContextChars: 42, confidence: 'high',
      uncertainty: { reviewableFiles: 0, sourceChars: 0, diffChars: 0, combinedChars: 0, unknowns: [] }, verification: ['fixture'], decomposition: [] };
    const actual = await preflight({ mode: 'actual', repository: dir, base, head, plan, contextSources });
    const live = evaluate(scopeObservation([{ path: 'main.ts' }, { path: 'removed.ts' }], code, diff, undefined, 42), 'actual');
    expect(actual.status).toBe('pass'); expect(live.status).toBe('pass');
    expect(actual.observations).toEqual(live.observations);
    const sources = [...code, { ref: `github:diff:${head}`, text: diff }, { ref: 'board:prior-findings', text: 'Earlier finding and card comment' }]
      .map(s => ({ ...s, revision: gate.digest(s.text), essential: true, missing: false, truncated: false }));
    const snapshot: gate.Snapshot = { repo: repo.github, pr: 7, head, base, branch: 'main', merged: null, checks: [{ name: 'test', state: 'pass' }], sources };
    const job: gate.Job = { id: 1, card: 'example-task', builder: 'builder', reviewer: 'auditor', target: 'fixture', round: 0, state: 'queued', snapshot: null, verdict: null, merged: null, deployed: null };
    const review = vi.fn(async () => { throw new Error('Fixture reviewer received input; stop before verdict or shipping'); });
    const forbidden = vi.fn(async () => { throw new Error('Unexpected shipping operation'); });
    await gate.runReview(job, ['test'], { gather: async () => snapshot, review, save: async () => {}, reject: forbidden,
      merge: forbidden, deploy: forbidden, health: forbidden, complete: forbidden, verifyMerge: forbidden });
    expect(review).toHaveBeenCalledOnce();
    const reviewed = (review.mock.calls[0] as unknown as [gate.Snapshot])[0];
    expect(reviewed.sources.find(s => s.ref === `github:diff:${head}`)?.text).toBe(aggregate);
    expect(reviewed.sources.find(s => s.ref === 'board:prior-findings')?.text).toContain('Earlier finding and card comment');
    expect(reviewed.sources.filter(s => s.ref.startsWith('github:source:'))).toHaveLength(3);
    expect(job.error).toBe('Fixture reviewer received input; stop before verdict or shipping');
    expect(forbidden).not.toHaveBeenCalled();
    console.log(`Two-commit fixture: aggregate=${aggregate.length}, commit-series=${patch.length}, sources=${code.length}, combined=${live.observations.combinedChars}`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it.each(['stable', 'head', 'base', 'merged'] as const)('worker binds aggregate evidence and preserves prior findings with %s revisions', async change => {
  const dir = await mkdtemp(join(tmpdir(), 'review-gather-'));
  try {
    const card = 't_123abc';
    await mkdir(join(dir, card));
    await writeFile(join(dir, 'design.md'), 'Design acceptance');
    for (const file of ['RESULT.md', 'run.log']) await writeFile(join(dir, card, file), `Builder revision: ${head}\nTests passed`);
    const host = { repositories: { engine: repo }, targets: { fixture: {} }, notesRoot: dir, evidenceRoot: dir, exclude: [] } as unknown as HostConfig;
    const job = { id: 1, card, builder: 'builder', reviewer: 'auditor', target: 'fixture', round: 0, state: 'queued', snapshot: change === 'merged' ? { repo: repo.github, pr: 7, base, head } : null };
    const context = { ticket: { repo: 'engine', body: 'Acceptance: final revision', assignee: 'builder' }, comments: [{ body: 'Earlier reviewer finding: verify removed lines' }], conversations: [], reviews: [{ findings: ['Earlier rejection retained'] }] };
    const client = { query: vi.fn(async (sql: string) => ({ rows: sql.includes('pg_try_advisory_lock') ? [{ ok: true }] : sql.includes('review_context') ? [{ context }] : sql.includes('review_policy') ? [{ enabled: true }] : sql.includes('SELECT * FROM review_jobs') ? [job] : [] })) } as unknown as pg.Client;
    const p = { ...revision, body: card, headRefName: card, baseRefName: 'main', isDraft: false, mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE', reviewDecision: null, isCrossRepository: false, state: change === 'merged' ? 'MERGED' : 'OPEN', mergeCommit: change === 'merged' ? { oid: 'd'.repeat(40) } : null, statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] };
    if (change === 'merged') p.baseRefOid = 'c'.repeat(40);
    let reads = 0;
    vi.spyOn(GitHub.prototype, 'pr').mockImplementation(async () => ({ ...p, ...(reads++ && (change === 'head' || change === 'base') ? { [change === 'head' ? 'headRefOid' : 'baseRefOid']: 'c'.repeat(40) } : {}) }) as Awaited<ReturnType<GitHub['pr']>>);
    vi.spyOn(GitHub.prototype, 'threads').mockResolvedValue([{ id: 'prior-thread', isResolved: true, isOutdated: true }]);
    const diff = vi.spyOn(GitHub.prototype, 'diff').mockResolvedValue('final net diff');
    const code = vi.spyOn(GitHub.prototype, 'code').mockResolvedValue([{ ref: `github:source:${head}:main.ts`, text: 'final source' }]);
    const snapshots: gate.Snapshot[] = [];
    vi.spyOn(gate, 'runReview').mockImplementation(async (_job, checks, io) => { expect(checks).toEqual(['test']); snapshots.push(await io.gather()); });
    if (change === 'stable' || change === 'merged') {
      await tick(client, host);
      expect(diff).toHaveBeenCalledWith(expect.objectContaining(revision));
      expect(code).toHaveBeenCalledWith(expect.objectContaining(revision));
      expect(snapshots).toHaveLength(1);
      const s = snapshots[0]!;
      expect(s).toMatchObject({ head, base, checks: [{ name: 'test', state: 'pass' }] });
      expect(s.sources.find(s => s.ref === `github:diff:${head}`)?.text).toBe('final net diff');
      expect(s.sources.find(s => s.ref.endsWith(':comments'))?.text).toContain('Earlier reviewer finding');
      expect(s.sources.find(s => s.ref.endsWith(':reviews'))?.text).toContain('Earlier rejection retained');
      expect(s.sources.find(s => s.ref.startsWith('github:example/engine/pull'))?.text).toContain('prior-thread');
      expect(s.sources.find(s => s.ref === `github:source:${head}:main.ts`)?.text).toBe('final source');
      expect(reads).toBe(2);
    } else {
      await expect(tick(client, host)).rejects.toThrow(/PR head or base changed during collection/);
      expect(snapshots).toHaveLength(0);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
