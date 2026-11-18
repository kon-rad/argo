import { describe, expect, it } from 'vitest';
import { GitHub, type HostConfig, type Repository } from '../src/review/adapters.js';

const card = 't_abc123';
const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const merged = 'c'.repeat(40);
const repo: Repository = {
  github: 'example/engine',
  gitDir: '/tmp/example-engine.git',
  base: 'main',
  target: 'fixture',
  checks: ['test'],
  notes: ['design.md'],
};

type Metadata = ReturnType<typeof metadata>;

function metadata(number: number, overrides: Record<string, unknown> = {}) {
  return {
    number,
    body: '',
    headRefOid: head,
    baseRefOid: base,
    baseRefName: 'main',
    headRefName: `card/${card}-fix-binding`,
    isCrossRepository: false,
    isDraft: false,
    mergeStateStatus: 'CLEAN',
    mergeable: 'MERGEABLE',
    reviewDecision: null,
    state: 'OPEN',
    mergeCommit: null as null | { oid: string },
    statusCheckRollup: [],
    ...overrides,
  };
}

function fixture(candidates: Metadata[]) {
  const github = new GitHub({ home: '/tmp' } as HostConfig, repo);
  const values = new Map(candidates.map(candidate => [candidate.number, candidate]));
  const calls: string[][] = [];
  github.gh = async args => {
    calls.push(args);
    if (args[1] === 'list') return JSON.stringify(candidates.map(({ number }) => ({ number })));
    if (args[1] === 'view') return JSON.stringify(values.get(Number(args[2])));
    if (args[0] === 'api' && args[1]?.endsWith('/protection')) return JSON.stringify({
      required_status_checks: { strict: true, contexts: ['test'] },
      allow_force_pushes: { enabled: false },
      enforce_admins: { enabled: true },
    });
    if (args[0] === 'api') return JSON.stringify({ permissions: { admin: false } });
    if (args[1] === 'merge') {
      const candidate = values.get(Number(args[2]))!;
      candidate.state = 'MERGED';
      candidate.mergeCommit = { oid: merged };
      return '';
    }
    throw new Error(`Unexpected GitHub call: ${args.join(' ')}`);
  };
  return { github, calls, values };
}

describe('review PR binding', () => {
  it('selects the exact card branch after validating broad search hits', async () => {
    const exact = metadata(7);
    const bodyOnlyReference = metadata(8, {
      body: `Verification evidence mentions ${card}.`,
      headRefName: 'verify/unrelated-change',
    });
    const { github, calls } = fixture([exact, bodyOnlyReference]);

    await expect(github.pr(card)).resolves.toMatchObject({ number: 7, headRefName: exact.headRefName });
    expect(calls.filter(args => args[1] === 'view').map(args => args[2])).toEqual(['7', '8']);
  });

  it('fails closed for zero or multiple valid exact bindings', async () => {
    await expect(fixture([]).github.pr(card)).rejects.toThrow(/Unknown or ambiguous PR/);
    const first = metadata(7);
    const second = metadata(8, { headRefName: `bot/coder/${card}-historical` });
    await expect(fixture([first, second]).github.pr(card)).rejects.toThrow(/Unknown or ambiguous PR/);
  });

  it('fails closed when the bounded broad search may be truncated', async () => {
    const candidates = Array.from({ length: 100 }, (_, index) => metadata(index + 1, {
      headRefName: `verify/unrelated-${index}`,
      body: `Evidence mentions ${card}.`,
    }));
    const { github, calls } = fixture(candidates);
    await expect(github.pr(card)).rejects.toThrow(/search is truncated/);
    expect(calls.some(args => args[1] === 'view')).toBe(false);
  });

  it('accepts supported branch prefixes and suffixes only at full identifier boundaries', async () => {
    await expect(fixture([metadata(7, { headRefName: `bot/coder/${card}-historical` })]).github.pr(card))
      .resolves.toMatchObject({ number: 7 });
    for (const headRefName of [`card/${card}4-fix`, `card/x${card}-fix`]) {
      await expect(fixture([metadata(7, { headRefName })]).github.pr(card)).rejects.toThrow(/Unknown or ambiguous PR/);
    }
  });

  it.each([
    ['cross-repository', { isCrossRepository: true }],
    ['wrong base', { baseRefName: 'release' }],
    ['closed', { state: 'CLOSED' }],
    ['changed card identity', { headRefName: 'card/t_other9-fix' }],
  ])('refuses a pinned PR that is %s', async (_label, change) => {
    const { github } = fixture([metadata(7, change)]);
    await expect(github.pr(card, 7)).rejects.toThrow(/closed, unrelated or targets an unregistered base/);
  });

  it('revalidates changed pinned identity and preserves exact-head merge authority', async () => {
    const { github, calls, values } = fixture([metadata(7)]);
    await expect(github.pr(card, 7)).resolves.toMatchObject({ number: 7 });
    values.get(7)!.headRefName = 'card/t_other9-fix';
    await expect(github.pr(card, 7)).rejects.toThrow(/closed, unrelated or targets an unregistered base/);

    values.set(7, metadata(7));
    await expect(github.merge(card, {
      repo: repo.github,
      pr: 7,
      head,
      base,
      branch: `card/${card}-fix-binding`,
      merged: null,
      checks: [{ name: 'test', state: 'pass' }],
      sources: [],
    })).resolves.toBe(merged);
    expect(calls.find(args => args[1] === 'merge')).toContain('--match-head-commit');

    values.set(7, metadata(7, { headRefOid: 'd'.repeat(40) }));
    await expect(github.merge(card, {
      repo: repo.github,
      pr: 7,
      head,
      base,
      branch: `card/${card}-fix-binding`,
      merged: null,
      checks: [{ name: 'test', state: 'pass' }],
      sources: [],
    })).rejects.toThrow(/head changed/);
  });
});
