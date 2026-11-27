import pg from 'pg';
import { expect, it, vi } from 'vitest';
import type { HostConfig, Repository } from '../src/review/adapters.js';
import { archiveOwnerHistory, parseOwnerHistoryArchiveArgs, verifyOwnerHistoryPr } from '../src/review/history-archive.js';

const repo: Repository = { github: 'example/engine', gitDir: '/srv/engine.git', base: 'main', target: 'fixture', checks: ['tests'], notes: ['README.md'] };
const host = { repositories: { engine: repo } } as HostConfig;
const sha = 'a'.repeat(40), tip = 'b'.repeat(40);
const req = { card: 't_aabbcc', repoKey: 'engine', pr: 12, outcome: 'merged' as const, merge: sha,
  staleBefore: '2000-01-02T00:00:00+01:00', reason: 'Historical shared work' };
const url = 'https://github.com/example/engine/pull/12';
const args = [req.card, '--repo-key', req.repoKey, '--pr', '12', '--stale-before', req.staleBefore, '--reason', req.reason];
const merged = [...args, '--outcome', 'merged', '--merge', sha];
const closed = [...args, '--outcome', 'closed-unmerged'];
const facts = { number: 12, url, headRefOid: tip, headRefName: 'maintenance/shared', baseRefName: 'main',
  isCrossRepository: false, state: 'MERGED', mergeCommit: { oid: sha } };
function reader(override: Record<string, unknown> = {}) {
  return {
    gh: vi.fn(async (_args: string[]) => JSON.stringify({ ...facts, ...override })),
    git: vi.fn(async (args: string[]) => args[0] === 'ls-remote' ? tip + '\trefs/heads/main\n' : ''),
  };
}

it('parses both outcomes and preserves a cutoff with an explicit offset', () => {
  expect(parseOwnerHistoryArchiveArgs(merged)).toEqual(req);
  expect(parseOwnerHistoryArchiveArgs(closed)).toMatchObject({ outcome: 'closed-unmerged' });
});

it.each([
  merged.slice(0, -2), [...closed, '--merge', sha], [...merged, '--repo-key', 'second'],
  [...merged, '--force'], merged.map(x => x === req.staleBefore ? '2000-01-02T00:00:00' : x),
  merged.map(x => x === req.staleBefore ? '2000-02-31T12:00:00Z' : x),
  merged.map(x => x === '12' ? '0xc' : x), merged.map(x => x === sha ? sha.slice(1) : x),
  merged.map(x => x === 'merged' ? 'open' : x),
].map(argv => ({ argv })))('refuses invalid arguments $argv', ({ argv }) => {
  expect(() => parseOwnerHistoryArchiveArgs(argv)).toThrow();
});

it('binds a shared merged PR to the registered repo, base and exact merge ancestry', async () => {
  const github = reader();
  const facts = await verifyOwnerHistoryPr(github, repo, req);
  expect(facts).toMatchObject({ repoKey: 'engine', repo: repo.github, pr: 12, url, state: 'MERGED', branch: 'maintenance/shared', baseTip: tip, merged: sha });
  expect(github.gh.mock.calls[0]![0]).toEqual(['pr', 'view', '12', '--repo', repo.github, '--json', expect.any(String)]);
  expect(github.git.mock.calls.map(([args]) => args)).toEqual([
    ['ls-remote', '--heads', 'https://github.com/example/engine.git', 'refs/heads/main'],
    ['fetch', '--no-tags', 'https://github.com/example/engine.git', sha, tip],
    ['merge-base', '--is-ancestor', sha, tip],
  ]);
});

it('requires CLOSED and an explicit null merge commit for closed-unmerged history', async () => {
  const request = parseOwnerHistoryArchiveArgs(closed);
  const github = reader({ state: 'CLOSED', mergeCommit: null });
  expect(await verifyOwnerHistoryPr(github, repo, request)).toMatchObject({ state: 'CLOSED', merged: null, baseTip: null });
  expect(github.git).not.toHaveBeenCalled();
  for (const fields of [{ state: 'OPEN', mergeCommit: null }, { state: 'CLOSED' }, { state: 'CLOSED', mergeCommit: undefined }, {}]) {
    await expect(verifyOwnerHistoryPr(reader(fields), repo, request)).rejects.toThrow();
  }
});

it.each([{ number: 13 }, { url: 'https://github.com/example/other/pull/12' }, { state: 'OPEN' },
  { state: 'CLOSED', mergeCommit: null }, { isCrossRepository: true }, { baseRefName: 'other' },
  { mergeCommit: { oid: tip } }, { mergeCommit: null }])('refuses inconsistent PR identity or outcome %o', async fields => {
  await expect(verifyOwnerHistoryPr(reader(fields), repo, req)).rejects.toThrow();
});

it('refuses a missing base or merge outside the protected branch', async () => {
  const github = reader();
  github.git.mockResolvedValueOnce('');
  await expect(verifyOwnerHistoryPr(github, repo, req)).rejects.toThrow(/tip/);
  github.git.mockResolvedValueOnce(tip + '\trefs/heads/main').mockResolvedValueOnce('').mockRejectedValueOnce(new Error('exit 1'));
  await expect(verifyOwnerHistoryPr(github, repo, req)).rejects.toThrow(/protected base/);
});

it('refuses unknown and inherited repository keys before any external lookup', async () => {
  const connect = vi.fn();
  const client = new pg.Client();
  for (const repoKey of ['obsolete', 'constructor', 'toString']) {
    await expect(archiveOwnerHistory(client, host, { ...req, repoKey }, connect)).rejects.toThrow(/registered/);
  }
  expect(connect).not.toHaveBeenCalled();
});

it('checks database authority before contacting GitHub', async () => {
  const client = new pg.Client();
  vi.spyOn(client, 'query').mockImplementation(async () => { throw new Error('owner required'); });
  const connect = vi.fn();
  await expect(archiveOwnerHistory(client, host, req, connect)).rejects.toThrow('owner required');
  expect(connect).not.toHaveBeenCalled();
});

it('passes the selected job, parsed request and live attestation to the locked transition', async () => {
  const client = new pg.Client();
  const query = vi.spyOn(client, 'query');
  const receipt = { id: '11' };
  query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ id: '8' }] }).mockResolvedValueOnce({ rows: [receipt] });
  const connect = vi.fn(() => reader());
  expect(await archiveOwnerHistory(client, host, req, connect)).toEqual(receipt);
  expect(connect).toHaveBeenCalledWith(repo);
  const [sql, args] = query.mock.calls.at(-1)!;
  expect(sql).toContain('FROM review_owner_history_archive(');
  expect(args.slice(0, 8)).toEqual([req.card, '8', req.repoKey, req.pr, req.outcome, sha, req.staleBefore, req.reason]);
  expect(JSON.parse(args[8])).toMatchObject({ url, state: 'MERGED', head: tip, merged: sha });
});

it('replays through the locked transition using the original attestation when GitHub is unavailable', async () => {
  const client = new pg.Client();
  const query = vi.spyOn(client, 'query');
  const attestation = await verifyOwnerHistoryPr(reader(), repo, req);
  const receipt = { id: '11', job: '8', attestation };
  query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [receipt] }).mockResolvedValueOnce({ rows: [receipt] });
  const connect = vi.fn();
  expect(await archiveOwnerHistory(client, host, req, connect)).toEqual(receipt);
  expect(query.mock.calls.at(-1)![0]).toContain('FROM review_owner_history_archive(');
  expect(connect).not.toHaveBeenCalled();
});

it.each([{ repo: 'example/replacement' }, { base: 'release' }])('refuses a replay after policy registration changed %o', async changed => {
  const client = new pg.Client();
  const query = vi.spyOn(client, 'query');
  const attestation = { ...await verifyOwnerHistoryPr(reader(), repo, req), ...changed };
  query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ job: '8', attestation }] });
  const connect = vi.fn();
  await expect(archiveOwnerHistory(client, host, req, connect)).rejects.toThrow(/conflicts/);
  expect(connect).not.toHaveBeenCalled();
  expect(query).toHaveBeenCalledTimes(2);
});
