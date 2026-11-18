import type pg from 'pg';
import { z } from 'zod';
import { GitHub, type HostConfig, type Repository } from './adapters.js';
import { repositoryKey } from './context.js';

/** One owner reconciliation: a PR the owner merged outside the review gate. */
export const OwnerMergeRequest = z.object({
  card: z.string().regex(/^t_[a-f0-9]{6,32}$/, 'card must look like t_<hex>'),
  pr: z.number().int().positive(),
  merge: z.string().regex(/^[a-f0-9]{40}$/, 'merge must be the full 40 character merge commit sha'),
  reason: z.string().trim().min(8, 'reason must say why, at least 8 characters').max(2000),
}).strict();
export type OwnerMergeRequest = z.infer<typeof OwnerMergeRequest>;

/** What was confirmed on GitHub. Stored verbatim on the receipt. */
export interface OwnerMergeAttestation {
  repo: string; pr: number; state: 'MERGED'; merged: string; head: string; base: string; baseTip: string; branch: string; checkedAt: string;
}

type GitHubReader = Pick<GitHub, 'pr' | 'git'>;

/**
 * Confirm on GitHub that `pr` is merged into the registered protected base with exactly `merge`, and that its
 * branch names the card. `GitHub.pr` already refuses a cross-repository PR, another base and an unrelated branch.
 */
export async function verifyOwnerMerge(github: GitHubReader, repo: Repository, card: string, pr: number, merge: string): Promise<OwnerMergeAttestation> {
  let p;
  try { p = await github.pr(card, pr); }
  catch (error) { throw new Error(`PR #${pr} is not a ${repo.github} PR into ${repo.base} from a branch naming ${card}: ${error instanceof Error ? error.message : 'lookup failed'}`); }
  if (p.state !== 'MERGED' || !p.mergeCommit) throw new Error(`PR #${pr} is not merged (state ${p.state}); nothing to reconcile`);
  if (p.mergeCommit.oid !== merge) throw new Error(`PR #${pr} was merged as ${p.mergeCommit.oid}, not ${merge}`);
  const remote = `https://github.com/${repo.github}.git`;
  const line = (await github.git(['ls-remote', '--heads', remote, `refs/heads/${repo.base}`])).trim().split('\n').find(l => l.endsWith(`\trefs/heads/${repo.base}`));
  const baseTip = line?.split('\t')[0] ?? '';
  if (!/^[a-f0-9]{40}$/.test(baseTip)) throw new Error(`Cannot read the tip of ${repo.base} on ${repo.github}`);
  await github.git(['fetch', '--no-tags', remote, merge, baseTip]);
  try { await github.git(['merge-base', '--is-ancestor', merge, baseTip]); }
  catch { throw new Error(`Merge ${merge} is not on the protected base ${repo.base}`); }
  if (p.isCrossRepository || p.baseRefName !== repo.base) throw new Error(`PR #${pr} is not a ${repo.github} PR into ${repo.base}`);
  return { repo: repo.github, pr, state: 'MERGED', merged: merge, head: p.headRefOid, base: p.baseRefName, baseTip, branch: p.headRefName, checkedAt: new Date().toISOString() };
}

export interface OwnerMergeReceipt { id: number; card: string; job: number | null; repo: string; pr: number; merged: string; reason: string; reconciled_by: string; reconciled_at: string }

/**
 * The owner verb behind `cli-review reconcile-owner-merge`. The database refuses any caller but the owner login, and
 * any card that is not stuck in one of the documented owner-merge states.
 */
export async function reconcileOwnerMerge(client: pg.Client, host: HostConfig, input: unknown,
  connect: (repo: Repository) => GitHubReader = repo => new GitHub(host, repo)): Promise<OwnerMergeReceipt> {
  const req = OwnerMergeRequest.parse(input);
  // Idempotent: the same reconciliation run twice returns the receipt it already wrote.
  const prior = (await client.query<OwnerMergeReceipt>('SELECT * FROM review_owner_merges WHERE card=$1 AND pr=$2 AND merged=$3', [req.card, req.pr, req.merge])).rows[0];
  if (prior) return prior;
  const check = (await client.query<{ info: { repo: string | null; body: string | null; job: number | null; pr: number | null; merged: string | null } }>(
    'SELECT review_owner_merge_check($1) AS info', [req.card])).rows[0]!.info;
  if (check.pr && check.pr !== req.pr) throw new Error(`Review job ${check.job} is for PR #${check.pr}, not #${req.pr}`);
  if (check.merged && check.merged !== req.merge) throw new Error(`Review job ${check.job} recorded merge ${check.merged}, not ${req.merge}`);
  const key = repositoryKey({ repo: check.repo, body: check.body }, host.repositories);
  const repo = host.repositories[key];
  if (!repo) throw new Error(`Card ${req.card} names no repository registered in the host policy`);
  const attestation = await verifyOwnerMerge(connect(repo), repo, req.card, req.pr, req.merge);
  return (await client.query<OwnerMergeReceipt>('SELECT (review_owner_reconcile($1,$2,$3,$4,$5::jsonb)).*',
    [req.card, req.pr, req.merge, req.reason, JSON.stringify(attestation)])).rows[0]!;
}

/** `<card> --pr <n> --merge <sha> --reason "<why>"` */
export function parseOwnerMergeArgs(argv: string[]): OwnerMergeRequest {
  const [card, ...rest] = argv;
  const opts: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]!, value = rest[i + 1];
    if (!['--pr', '--merge', '--reason'].includes(flag) || value === undefined) throw new Error(`Unexpected argument ${flag}`);
    opts[flag.slice(2)] = value;
  }
  return OwnerMergeRequest.parse({ card, pr: Number(opts.pr), merge: opts.merge, reason: opts.reason });
}
