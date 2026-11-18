import { execFile } from 'node:child_process';
import { relative, sep } from 'node:path';

/**
 * Read-only Git questions about package paths, with a fixed argv (no shell) and a timeout. Every answer
 * is "unknown" (null) when the path is not in a Git work tree or Git is missing: provenance that cannot
 * be established is not invented.
 */

export function git(cwd: string, args: string[], timeoutMs = 10_000): Promise<string | null> {
  return new Promise((resolveP) => {
    execFile('git', ['-c', 'core.quotepath=off', ...args], { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } },
      (err, stdout) => resolveP(err ? null : stdout));
  });
}

export async function gitTop(dir: string): Promise<string | null> {
  const out = await git(dir, ['rev-parse', '--show-toplevel']);
  return out ? out.trim() : null;
}

export const toPosix = (p: string): string => p.split(sep).join('/');

export interface RootGit {
  top: string;
  head: string | null;
  /** Repo-relative paths with uncommitted changes (tracked or untracked) under the root. */
  dirty: string[] | null;
  /** Repo-relative tracked files under the root. */
  tracked: Set<string> | null;
  /** A failed provenance command is visible instead of being treated as an empty successful result. */
  error: string | null;
}

/** One status and one ls-files per root, so each package's dirty/tracked answer is a prefix check. */
export async function rootGit(dir: string): Promise<RootGit | null> {
  const top = await gitTop(dir);
  if (!top) return null;
  const rel = toPosix(relative(top, dir)) || '.';
  const [head, status, files] = await Promise.all([
    git(top, ['rev-parse', 'HEAD']),
    git(top, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', rel]),
    git(top, ['ls-files', '-z', '--', rel]),
  ]);
  const dirty: string[] | null = status === null ? null : [];
  if (status) {
    const parts = status.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const e = parts[i]!;
      if (e.length < 4) continue;
      dirty!.push(e.slice(3));
      if (e[0] === 'R' || e[0] === 'C') i++; // rename source follows
    }
  }
  return { top, head: head ? head.trim() : null, dirty, tracked: files === null ? null : new Set(files.split('\0').filter(Boolean)),
    error: [status === null ? 'Git status is unavailable; dirty state is unknown' : null, files === null ? 'Git tracked files are unavailable; tracked state is unknown' : null, head === null ? 'Git HEAD is unavailable; revision is unknown' : null].filter(Boolean).join('; ') || null };
}

export function pathState(g: RootGit, absPath: string): { rel: string; dirty: boolean | null; tracked: boolean | null } {
  const rel = toPosix(relative(g.top, absPath));
  const prefix = `${rel}/`;
  const dirty = g.dirty?.some((d) => d === rel || d.startsWith(prefix)) ?? null;
  let tracked = g.tracked?.has(rel) ?? null;
  if (tracked === false && g.tracked) for (const t of g.tracked) if (t.startsWith(prefix)) { tracked = true; break; }
  return { rel, dirty, tracked };
}

export async function lastRevision(top: string, rel: string): Promise<string | null> {
  const out = await git(top, ['log', '-1', '--format=%H', '--', rel]);
  return out && out.trim() ? out.trim() : null;
}

export async function history(top: string, rel: string, limit = 20): Promise<{ revision: string; date: string; subject: string }[]> {
  const out = await git(top, ['log', `-${Math.min(100, Math.max(1, limit))}`, '--format=%H%x1f%cI%x1f%s', '--', rel]);
  if (!out) return [];
  return out.split('\n').filter(Boolean).map((line) => {
    const [revision, date, subject] = line.split('\x1f');
    return { revision: revision!, date: date!, subject: (subject ?? '').slice(0, 200) };
  });
}

/** Files of a path at a revision: [{path relative to rel, mode, blob}] (regular files and executables only). */
export async function treeAt(top: string, revision: string, rel: string): Promise<{ path: string; exec: boolean; blob: string }[] | null> {
  const out = await git(top, ['ls-tree', '-r', '-z', revision, '--', `${rel}/`]);
  if (out === null) return null;
  const entries: { path: string; exec: boolean; blob: string }[] = [];
  for (const e of out.split('\0').filter(Boolean)) {
    const m = /^(\d{6}) (\w+) ([0-9a-f]+)\t(.*)$/s.exec(e);
    if (!m) continue;
    if (m[2] !== 'blob') continue;
    if (m[1] !== '100644' && m[1] !== '100755') return null; // a symlink or submodule in history: refuse, never guess
    entries.push({ path: m[4]!.slice(rel.length + 1), exec: m[1] === '100755', blob: m[3]! });
  }
  return entries;
}

export function blob(top: string, sha: string): Promise<Buffer | null> {
  return new Promise((resolveP) => {
    execFile('git', ['cat-file', 'blob', sha], { cwd: top, timeout: 10_000, maxBuffer: 16 * 1024 * 1024, encoding: 'buffer' },
      (err, stdout) => resolveP(err ? null : (stdout as unknown as Buffer)));
  });
}
