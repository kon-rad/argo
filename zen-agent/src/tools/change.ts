import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants, closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { changedLines, type ChangedLines } from './changeDiff.js';

export const hash = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['--literal-pathspecs', '-C', cwd, ...args], { encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export interface FileObservationRecord {
  version: 1; id: string; repository: string; worktree: string; path: string; observedBefore: string | null; observedAfter: string; ownership: 'unknown';
  diff: ChangedLines;
  commitMatch?: { sha: string; verification: 'local-object'; authorship: 'unknown' };
}
const sameEntry = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino;
/** Inspect lexical entries even for dangling links; canonicalization alone follows them. */
function location(abs: string, root: string, lexicalRoot: string) {
  const path = relative(lexicalRoot, abs);
  if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error('outside worktree');
  const parents = new Map<string, Stats>();
  let cursor = lexicalRoot, file: Stats | undefined;
  const pieces = path.split(sep);
  for (let i = -1; i < pieces.length; i++) {
    if (i >= 0) cursor = resolve(cursor, pieces[i]!);
    const stat = lstatSync(cursor, { throwIfNoEntry: false });
    if (!stat) continue; // Missing ancestors are created by the tool, then checked again.
    if (stat.isSymbolicLink()) throw new Error('symlink observation unsupported');
    if (realpathSync(cursor) !== resolve(root, ...pieces.slice(0, i + 1))) throw new Error('canonical path changed');
    if (i < pieces.length - 1) {
      if (!stat.isDirectory()) throw new Error('parent is not a directory');
      parents.set(cursor, stat);
    } else {
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('unsupported file');
      file = stat;
    }
  }
  return { parents, file, path };
}
function readObserved(abs: string, file: Stats): Buffer {
  const fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = fstatSync(fd);
    if (!sameEntry(current, file) || !current.isFile() || current.size > 16 * 1024 * 1024) throw new Error('file changed');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
function sameParents(before: Map<string, Stats>, after: Map<string, Stats>): boolean {
  return [...before].every(([path, stat]) => after.has(path) && sameEntry(stat, after.get(path)!));
}
/** A single synchronous file operation, never a working-tree-wide diff or mtime attribution. */
export function prepareChange(abs: string) {
  // Symlinks can cross repository boundaries. Leave them unsupported rather than invent identity.
  let cwd = dirname(abs);
  while (!existsSync(cwd) && dirname(cwd) !== cwd) cwd = dirname(cwd);
  try {
    const root = realpathSync(git(cwd, 'rev-parse', '--show-toplevel'));
    const common = realpathSync(git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
    // Locate this worktree's lexical root, allowing OS aliases above it (e.g. /tmp),
    // while rejecting a symlink standing in for the root or any descendant entry.
    let lexicalRoot = cwd;
    while (realpathSync(lexicalRoot) !== root) {
      const parent = dirname(lexicalRoot); if (parent === lexicalRoot) return null;
      lexicalRoot = parent;
    }
    const observed = location(abs, root, lexicalRoot);
    const before = observed.file ? readObserved(abs, observed.file) : null;
    const checked = location(abs, root, lexicalRoot);
    if (!sameParents(observed.parents, checked.parents) || !!observed.file !== !!checked.file || observed.file && !sameEntry(observed.file, checked.file!)) return null;
    return { root, common, lexicalRoot, abs, before, path: observed.path, parents: observed.parents, file: observed.file };
  } catch { return null; }
}
/** Eligibility check immediately before the tool write, not an atomic external-writer CAS. */
export function checkBeforeWrite(abs: string, prepared: ReturnType<typeof prepareChange>, replacementBase?: Buffer): ReturnType<typeof prepareChange> {
  if (!prepared || abs !== prepared.abs || replacementBase && !prepared.before?.equals(replacementBase)) return null;
  try {
    const observed = location(abs, prepared.root, prepared.lexicalRoot);
    if (!sameParents(prepared.parents, observed.parents) || !!prepared.file !== !!observed.file || prepared.file && !sameEntry(prepared.file, observed.file!)) return null;
    const current = observed.file ? readObserved(abs, observed.file) : null;
    if (prepared.before === null ? current !== null : current === null || !prepared.before.equals(current)) return null;
    const checked = location(abs, prepared.root, prepared.lexicalRoot);
    if (!sameParents(observed.parents, checked.parents) || !!observed.file !== !!checked.file || observed.file && !sameEntry(observed.file, checked.file!)) return null;
    return prepared;
  } catch { return null; }
}
export function finishObservation(abs: string, prepared: ReturnType<typeof prepareChange>, intended: string, env: NodeJS.ProcessEnv = process.env): FileObservationRecord | null {
  if (!prepared || Buffer.byteLength(intended) > 16 * 1024 * 1024) return null;
  try {
    if (abs !== prepared.abs) return null;
    const observed = location(abs, prepared.root, prepared.lexicalRoot);
    if (!observed.file || !sameParents(prepared.parents, observed.parents) || prepared.file && !sameEntry(prepared.file, observed.file)) return null;
    const cwd = dirname(abs);
    if (realpathSync(git(cwd, 'rev-parse', '--show-toplevel')) !== prepared.root || realpathSync(git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir')) !== prepared.common) return null;
    const after = readObserved(abs, observed.file), before = prepared.before;
    const checked = location(abs, prepared.root, prepared.lexicalRoot);
    if (!checked.file || !sameEntry(observed.file, checked.file) || !sameParents(observed.parents, checked.parents)) return null;
    // Final bytes must match the intended write; this is not an atomic external-writer transaction.
    if (!after.equals(Buffer.from(intended)) || before?.equals(after)) return null;
    return { version: 1, id: randomUUID(), repository: hash(prepared.common), worktree: hash(prepared.root), path: prepared.path,
      observedBefore: before === null ? null : hash(before), observedAfter: hash(after), ownership: 'unknown',
      // Redaction happens before this object reaches tool results/session persistence.
      diff: changedLines(before, after, env) };
  } catch { return null; }
}
/** A Git content comparison only; never proof that this tool owned a transition. */
export function inspectObservedCommit(root: string, observation: FileObservationRecord, sha: string): FileObservationRecord {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('commit must be a full SHA');
  if (git(root, 'cat-file', '-t', sha) !== 'commit') throw new Error('SHA must identify a commit object');
  const show = (ref: string): Buffer | null => {
    const entry = git(root, 'ls-tree', ref, '--', observation.path);
    if (!entry) return null;
    const match = /^100(?:644|755) blob ([a-f0-9]{40})\t/.exec(entry);
    if (!match) throw new Error('path is not a regular blob');
    return execFileSync('git', ['-C', root, 'cat-file', 'blob', match[1]!], { timeout: 2000, maxBuffer: 16 * 1024 * 1024 });
  };
  const parents = git(root, 'rev-list', '--parents', '-n', '1', sha).split(' ');
  if (parents.length !== 2) throw new Error('requires a single-parent commit');
  const after = show(sha), before = show(parents[1]!);
  if (!after || hash(after) !== observation.observedAfter || (before === null ? null : hash(before)) !== observation.observedBefore) throw new Error('commit bytes do not match this observed pair');
  return { ...observation, commitMatch: { sha, verification: 'local-object', authorship: 'unknown' } };
}
