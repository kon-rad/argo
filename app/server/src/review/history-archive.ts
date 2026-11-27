import type pg from 'pg';
import { z } from 'zod';
import { GitHub, type HostConfig, type Repository } from './adapters.js';
import { verifyProtectedBaseMerge } from './reconcile.js';

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const requestFields = {
  card: z.string().regex(/^t_[a-f0-9]{6,32}$/),
  repoKey: z.string().min(1),
  pr: z.number().int().positive().max(2147483647),
  staleBefore: z.iso.datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value)), 'absolute timestamp required'),
  reason: z.string().trim().min(8).max(2000),
};
export const OwnerHistoryArchiveRequest = z.discriminatedUnion('outcome', [
  z.strictObject({ ...requestFields, outcome: z.literal('merged'), merge: sha }),
  z.strictObject({ ...requestFields, outcome: z.literal('closed-unmerged') }),
]);
export type OwnerHistoryArchiveRequest = z.infer<typeof OwnerHistoryArchiveRequest>;

export function parseOwnerHistoryArchiveArgs(argv: string[]): OwnerHistoryArchiveRequest {
  const [card, ...rest] = argv;
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]!, value = rest[i + 1];
    if (!['--repo-key', '--pr', '--outcome', '--merge', '--stale-before', '--reason'].includes(flag)
      || value === undefined || value.startsWith('--') || flags.has(flag)) throw new Error(`Unexpected argument ${flag}`);
    flags.set(flag, value);
  }
  const pr = flags.get('--pr') ?? '';
  if (!/^[1-9][0-9]*$/.test(pr)) throw new Error('--pr must be a positive PR number');
  return OwnerHistoryArchiveRequest.parse({ card, repoKey: flags.get('--repo-key'), pr: Number(pr),
    outcome: flags.get('--outcome'), staleBefore: flags.get('--stale-before'), reason: flags.get('--reason'),
    ...(flags.has('--merge') ? { merge: flags.get('--merge') } : {}) });
}

type Reader = Pick<GitHub, 'gh' | 'git'>;
const HistoricalPr = z.object({
  number: z.number().int().positive(), url: z.string(), baseRefName: z.string(), headRefName: z.string().min(1),
  isCrossRepository: z.boolean(), headRefOid: sha, state: z.enum(['OPEN', 'CLOSED', 'MERGED']), mergeCommit: z.object({ oid: sha }).nullable(),
});

/** Historical branches can cover several cards. The database binds each card to its own human PR link. */
export async function verifyOwnerHistoryPr(github: Reader, repo: Repository, req: OwnerHistoryArchiveRequest) {
  const p = HistoricalPr.parse(JSON.parse(await github.gh(['pr', 'view', String(req.pr), '--repo', repo.github,
    '--json', Object.keys(HistoricalPr.shape).join(',')])));
  const url = `https://github.com/${repo.github}/pull/${req.pr}`;
  if (p.number !== req.pr || p.url !== url || p.isCrossRepository || p.baseRefName !== repo.base) {
    throw new Error(`PR identity does not match ${url} on the registered base ${repo.base}`);
  }
  let baseTip: string | null = null;
  if (req.outcome === 'merged') {
    if (p.state !== 'MERGED' || p.mergeCommit?.oid !== req.merge) throw new Error('GitHub did not attest the requested merge commit');
    baseTip = await verifyProtectedBaseMerge(github, repo, req.merge);
  } else if (p.state !== 'CLOSED' || p.mergeCommit !== null) {
    throw new Error('GitHub did not attest a closed, unmerged PR');
  }
  return { repoKey: req.repoKey, repo: repo.github, pr: req.pr, url, state: p.state, merged: p.mergeCommit?.oid ?? null,
    head: p.headRefOid, branch: p.headRefName, base: p.baseRefName, baseTip, checkedAt: new Date().toISOString() };
}

export async function archiveOwnerHistory(client: pg.Client, host: HostConfig, input: unknown,
  connect: (repo: Repository) => Reader = repo => new GitHub(host, repo)) {
  const req = OwnerHistoryArchiveRequest.parse(input);
  if (!Object.hasOwn(host.repositories, req.repoKey)) throw new Error('Repository key is not registered in the host policy');
  const repo = host.repositories[req.repoKey]!;
  await client.query('SELECT review_owner_history_authorize()');

  // A committed receipt already contains the attestation. The SQL operation checks every replay under the card lock.
  const prior = (await client.query<{ job: string; attestation: Awaited<ReturnType<typeof verifyOwnerHistoryPr>> }>(
    'SELECT job, attestation FROM review_owner_history_archives WHERE card=$1', [req.card])).rows[0];
  if (prior && (prior.attestation.repo !== repo.github || prior.attestation.base !== repo.base)) {
    throw new Error('Registered repository or base conflicts with the historical receipt');
  }
  const job = prior?.job ?? (await client.query<{ id: string }>(
    'SELECT id FROM review_jobs WHERE card=$1 ORDER BY round DESC LIMIT 1', [req.card])).rows[0]?.id;
  if (!job) throw new Error('Historical archive requires a blocked historical review job');
  const attestation = prior?.attestation ?? await verifyOwnerHistoryPr(connect(repo), repo, req);
  return (await client.query('SELECT * FROM review_owner_history_archive($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)',
    [req.card, job, req.repoKey, req.pr, req.outcome, req.outcome === 'merged' ? req.merge : null,
      req.staleBefore, req.reason, JSON.stringify(attestation)])).rows[0]!;
}
