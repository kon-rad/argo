import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

export const hash = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['--literal-pathspecs', '-C', cwd, ...args], { encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export interface ChangeCapture {
  version: 1; id: string; repository: string; worktree: string; path: string; before: string | null; after: string;
  diff: { format: 'replacement'; before?: string; after?: string; truncated: boolean };
  commit?: { sha: string; verification: 'local-object'; authorship: 'unknown' };
}
/** A single synchronous file operation, never a working-tree-wide diff or mtime attribution. */
export function prepareChange(abs: string) {
  // Symlinks can cross repository boundaries. Leave them unsupported rather than invent identity.
  let cwd = dirname(abs);
  while (!existsSync(cwd) && dirname(cwd) !== cwd) cwd = dirname(cwd);
  try {
    if (existsSync(abs) && (lstatSync(abs).isSymbolicLink() || statSync(abs).size > 16 * 1024 * 1024)) return null;
    const root = realpathSync(git(cwd, 'rev-parse', '--show-toplevel'));
    const common = realpathSync(git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
    const before = existsSync(abs) ? readFileSync(abs) : null;
    return { root, common, before, path: relative(root, resolve(realpathSync(cwd), relative(cwd, abs))) };
  } catch { return null; }
}
export function finishChange(abs: string, prepared: ReturnType<typeof prepareChange>, intended: string): ChangeCapture | null {
  if (!prepared || Buffer.byteLength(intended) > 16 * 1024 * 1024) return null;
  try {
    const after = readFileSync(abs), before = prepared.before;
    // A racing external writer makes this observation insufficient.
    if (!after.equals(Buffer.from(intended)) || before?.equals(after)) return null;
    const bounded = (before?.length ?? 0) + after.length <= 16384 && (!before || Buffer.from(before.toString('utf8')).equals(before));
    return { version: 1, id: randomUUID(), repository: hash(prepared.common), worktree: hash(prepared.root), path: prepared.path,
      before: before === null ? null : hash(before), after: hash(after),
      diff: { format: 'replacement', ...(bounded ? { before: before?.toString('utf8') ?? '', after: after.toString('utf8') } : {}), truncated: !bounded } };
  } catch { return null; }
}
/** Proves this path's parent/commit bytes, not authorship or ownership of the whole commit. */
export function inspectCommit(root: string, change: ChangeCapture, sha: string): ChangeCapture {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('commit must be a full SHA');
  if (git(root, 'cat-file', '-t', sha) !== 'commit') throw new Error('SHA must identify a commit object');
  const show = (ref: string): Buffer | null => {
    const entry = git(root, 'ls-tree', ref, '--', change.path);
    if (!entry) return null;
    const match = /^100(?:644|755) blob ([a-f0-9]{40})\t/.exec(entry);
    if (!match) throw new Error('path is not a regular blob');
    return execFileSync('git', ['-C', root, 'cat-file', 'blob', match[1]!], { timeout: 2000, maxBuffer: 16 * 1024 * 1024 });
  };
  const parents = git(root, 'rev-list', '--parents', '-n', '1', sha).split(' ');
  if (parents.length !== 2) throw new Error('requires a single-parent commit');
  const after = show(sha), before = show(parents[1]!);
  if (!after || hash(after) !== change.after || (before === null ? null : hash(before)) !== change.before) throw new Error('commit bytes do not match this capture');
  return { ...change, commit: { sha, verification: 'local-object', authorship: 'unknown' } };
}
