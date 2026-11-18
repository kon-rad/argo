import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { blob, git, gitTop, lastRevision, toPosix } from './git.js';
import { parsePolicy, type LoadedPolicy } from './policy.js';
import { rosterSourceDigest } from './roster.js';
import type { ReviewReceipt } from './lifecycle.js';

export class PolicyReviewError extends Error { constructor(message: string, readonly status = 409) { super(message); } }
export interface PolicyProvenance { repo: string; path: string; revision: string; digest: string; source: string; approvedBy: string }
export interface PolicySnapshot { top: string; repo: string; path: string; revision: string; digest: string; head: string; branch: string; blob: string }
export interface PolicyApprovalProvider {
  /** Latest owner receipt for the repository/path only, returned as zero or one rows. */
  read(repo: string, path: string, revision: string, digest: string): Promise<PolicyProvenance[]>;
  write(receipt: PolicyProvenance): Promise<void>;
}
const sha = /^[0-9a-f]{40,64}$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const marked = new WeakMap<LoadedPolicy, { fingerprint: string; provenance: PolicyProvenance; at: number }>();
const hash = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
function fingerprint(policy: LoadedPolicy): string {
  const parsed = parsePolicy(policy.text);
  if (!policy.exists || !policy.valid || policy.mode !== 'managed' || !parsed.valid || parsed.mode !== 'managed' ||
      parsed.digest !== policy.digest || JSON.stringify(parsed.policy) !== JSON.stringify(policy.policy)) throw new PolicyReviewError('Managed policy bytes or parsed policy changed; obtain approval for the exact committed policy.');
  return JSON.stringify([policy.text, policy.digest, policy.policy]);
}
/** Authorization belongs to this exact in-memory parsed policy, never a serializable reviewed boolean. */
export function markPolicyReviewed(policy: LoadedPolicy, provenance: PolicyProvenance): void {
  const value = fingerprint(policy);
  if (provenance.digest !== policy.digest || !digestPattern.test(provenance.digest) || !sha.test(provenance.revision) ||
      !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(provenance.repo) || !provenance.path || provenance.path.startsWith('/') || provenance.path.split('/').some(p => !p || p === '.' || p === '..') ||
      !provenance.source || !provenance.approvedBy) throw new PolicyReviewError('Invalid policy approval provenance.');
  marked.set(policy, { fingerprint: value, provenance: { ...provenance }, at: Date.now() });
}
export function assertPolicyReviewed(policy: LoadedPolicy): void {
  if (!marked.has(policy) || Date.now() - marked.get(policy)!.at > 60_000 || marked.get(policy)!.fingerprint !== fingerprint(policy)) throw new PolicyReviewError('Managed skills policy has no approval for these exact bytes. Commit the policy and obtain an accepted review or explicit owner policy approval before synchronization.');
}
/** Require a regular file and ancestors inside the vault, without resolving away a policy-path symlink. */
function regularPolicyPath(vaultRoot: string, policyPath: string): string {
  const rel = relative(resolve(vaultRoot), resolve(policyPath));
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new PolicyReviewError('Policy approval requires a policy file inside the vault Git tree.');
  let current = realpathSync(vaultRoot);
  const parts = rel.split(sep);
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!);
    const st = lstatSync(current);
    if (st.isSymbolicLink() || (i === parts.length - 1 ? !st.isFile() : !st.isDirectory())) throw new PolicyReviewError('Policy and its ancestors must be regular files/directories; symlinks are not approved.');
  }
  return current;
}
async function regularBlob(top: string, revision: string, path: string): Promise<{ id: string; data: Buffer } | null> {
  const entry = await git(top, ['ls-tree', '-z', revision, '--', path]);
  const match = entry && /^100(?:644|755) blob ([0-9a-f]+)\t[^\0]+\0$/.exec(entry);
  if (!match) return null;
  const data = await blob(top, match[1]!);
  return data ? { id: match[1]!, data } : null;
}
/** A clean policy snapshot at the known origin default tip; unrelated newer commits do not replace its last-change revision. */
export async function policySnapshot(vaultRoot: string, policyPath: string, policy: LoadedPolicy): Promise<PolicySnapshot> {
  fingerprint(policy);
  let file: string;
  try { file = regularPolicyPath(vaultRoot, policyPath); } catch (err) { if (err instanceof PolicyReviewError) throw err; throw new PolicyReviewError('Policy file is missing or unreadable; approval provenance is unavailable.'); }
  const top = await gitTop(dirname(file));
  if (!top) throw new PolicyReviewError('Policy is not in an available Git repository.');
  const path = toPosix(relative(top, file));
  if (!path || path.startsWith('../') || isAbsolute(path)) throw new PolicyReviewError('Policy path leaves its Git repository.');
  const [remote, defaultRef, head, tracked, status, ignored] = await Promise.all([
    git(top, ['remote', 'get-url', 'origin']), git(top, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']),
    git(top, ['rev-parse', '--verify', 'HEAD^{commit}']), git(top, ['ls-files', '-z', '--', path]),
    git(top, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', path]),
    git(top, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', path]),
  ]);
  const repoMatch = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(remote?.trim() ?? '');
  if (!repoMatch || !defaultRef?.trim().startsWith('refs/remotes/origin/') || !head || !sha.test(head.trim())) throw new PolicyReviewError('Policy repository origin/default branch provenance is unavailable.');
  if (status === null || tracked === null || ignored === null) throw new PolicyReviewError('Git policy dirty/tracked state is unknown; approval refused.');
  if (status !== '' || ignored !== '' || !tracked.split('\0').includes(path)) throw new PolicyReviewError('Policy must be clean and tracked in Git; commit and review its exact bytes first.');
  const tip = (await git(top, ['rev-parse', '--verify', `${defaultRef.trim()}^{commit}`]))?.trim();
  if (!tip || tip !== head.trim()) throw new PolicyReviewError('Policy approval requires the current origin default branch tip.');
  const revision = await lastRevision(top, path), committed = await regularBlob(top, tip, path);
  if (!revision || !sha.test(revision) || !committed || hash(committed.data.toString('utf8')) !== policy.digest ||
      !committed.data.equals(readFileSync(file)) || policy.text !== committed.data.toString('utf8')) throw new PolicyReviewError('Policy bytes differ from the committed Git policy; approval refused.');
  return { top, repo: repoMatch[1]!.toLowerCase(), path, revision, digest: policy.digest!, head: tip, branch: defaultRef.trim().slice('refs/remotes/origin/'.length), blob: committed.id };
}
export function matchesApproval(snapshot: PolicySnapshot, receipt: PolicyProvenance): boolean {
  return receipt.repo === snapshot.repo && receipt.path === snapshot.path && receipt.revision === snapshot.revision && receipt.digest === snapshot.digest &&
    !!receipt.source && !!receipt.approvedBy;
}
/** The accepted review must contain this policy change, preserve the exact blob on merge, and reach the current tip. */
export async function acceptedPolicyReview(snapshot: PolicySnapshot, receipts: ReviewReceipt[]): Promise<PolicyProvenance | null> {
  for (const receipt of receipts) {
    if (receipt.repo.toLowerCase() !== snapshot.repo || receipt.branch !== snapshot.branch || !sha.test(receipt.base) || !sha.test(receipt.head) || !sha.test(receipt.merged)) continue;
    const ancestry = await Promise.all([
      git(snapshot.top, ['merge-base', '--is-ancestor', receipt.base, receipt.head]),
      git(snapshot.top, ['merge-base', '--is-ancestor', snapshot.revision, receipt.head]),
      git(snapshot.top, ['merge-base', '--is-ancestor', receipt.head, receipt.merged]),
      git(snapshot.top, ['merge-base', '--is-ancestor', receipt.merged, snapshot.head]),
    ]);
    if (ancestry.some(value => value === null)) continue;
    // Prove that this PR introduced the policy revision, rather than inheriting it in its base.
    // A successful merge-base answer distinguishes non-ancestry from unavailable Git evidence.
    const introduced: string | undefined = (await git(snapshot.top, ['merge-base', snapshot.revision, receipt.base]))?.trim();
    if (!introduced || introduced === snapshot.revision) continue;
    const baseTree = await git(snapshot.top, ['ls-tree', '-z', receipt.base, '--', snapshot.path]);
    if (baseTree === null) continue;
    if (baseTree !== '') {
      const baseEntry = /^100(?:644|755) blob ([0-9a-f]+)\t[^\0]+\0$/.exec(baseTree);
      if (!baseEntry || baseEntry[1] === snapshot.blob) continue;
    }
    const [reviewed, merged] = await Promise.all([regularBlob(snapshot.top, receipt.head, snapshot.path), regularBlob(snapshot.top, receipt.merged, snapshot.path)]);
    if (reviewed?.id !== snapshot.blob || merged?.id !== snapshot.blob) continue;
    return { repo: snapshot.repo, path: snapshot.path, revision: snapshot.revision, digest: snapshot.digest, source: `review:${receipt.head}:${receipt.merged}`, approvedBy: 'accepted-review' };
  }
  return null;
}

/** Team/name/runtime authorization inputs must also come from clean tracked vault files. */
export async function cleanTrackedRoster(vaultRoot: string): Promise<string> {
  const root = realpathSync(vaultRoot), top = await gitTop(root);
  if (!top) throw new PolicyReviewError('Roster authorization sources require an available vault Git repository.');
  const leaves = ['.agents/org/org.json', '.agents/org/config/org.yaml'];
  const folders = ['.agents/org/config/agents', '.agents/org/config/teams'];
  const sources: string[] = [];
  const present = (path: string): boolean => {
    try { lstatSync(path); return true; } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false; throw new PolicyReviewError('Roster source is unreadable.'); }
  };
  // Reject links in even an otherwise absent source tree before any directory enumeration.
  for (const target of [...leaves, ...folders]) {
    let current = root;
    const parts = target.split('/');
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i]!);
      if (!present(current)) break;
      const st = lstatSync(current), file = leaves.includes(target) && i === parts.length - 1;
      if (st.isSymbolicLink() || (file ? !st.isFile() : !st.isDirectory())) throw new PolicyReviewError(`Roster authorization source must be regular, without symlinks: ${target}`);
    }
  }
  for (const path of leaves) if (present(join(root, path))) sources.push(path);
  for (const folder of folders) {
    if (!present(join(root, folder))) continue;
    for (const name of readdirSync(join(root, folder)).sort()) if ((folder.endsWith('/agents') ? /^[a-z0-9][a-z0-9-]{0,31}\.ya?ml$/ : /^.+\.ya?ml$/).test(name)) {
      const path = `${folder}/${name}`;
      regularPolicyPath(root, join(root, path)); sources.push(path);
    }
  }
  const paths = [...leaves, ...folders].map(path => toPosix(relative(top, join(root, path))));
  const [status, tracked] = await Promise.all([git(top, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...paths]), git(top, ['ls-files', '-z', '--', ...paths])]);
  if (status === null || tracked === null) throw new PolicyReviewError('Roster Git dirty/tracked state is unknown; managed planning refused.');
  if (status !== '') throw new PolicyReviewError('Roster authorization sources have uncommitted changes; commit team/runtime/name configuration before managed synchronization.');
  const members = new Set(tracked.split('\0').filter(Boolean));
  const captured: [string, string][] = [];
  for (const source of sources) {
    const file = join(root, source), path = toPosix(relative(top, file));
    if (!members.has(path)) throw new PolicyReviewError(`Roster authorization source is untracked or ignored: ${source}`);
    const committed = await regularBlob(top, 'HEAD', path);
    const bytes = readFileSync(file);
    if (!committed || !committed.data.equals(bytes)) throw new PolicyReviewError(`Roster authorization source differs from its committed bytes: ${source}`);
    captured.push([source, createHash('sha256').update(bytes).digest('hex')]);
  }
  return rosterSourceDigest(captured);
}
