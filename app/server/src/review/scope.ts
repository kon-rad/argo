import { posix } from 'node:path';
import { z } from 'zod';
import { evaluate, isReviewable, requireCapacity, scopeObservation } from './policy.js';

export const ChangedFile = z.object({ path: z.string().min(1), status: z.enum(['added', 'modified', 'removed', 'renamed', 'copied', 'changed', 'unchanged']), previousPath: z.string().optional() }).strict();
export type ChangedFile = z.infer<typeof ChangedFile>;
export type CodeSource = { path: string; revision: string; ref: string; text: string };
export const reviewable = isReviewable;
export function pathProblem(path: string, exclude: string[] = []): string | undefined {
  if (!path || path.startsWith('/') || path.includes('\\') || /[\x00-\x1f\x7f:]/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..')) return 'Use normalized repository-relative paths without traversal.';
  const template = /(?:^|\/)\.env\.(?:example|sample|template)$/.test(path);
  if ((!template && /(?:^|\/)(?:\.env(?:\.[^/]*)?|credentials?[^/]*|secrets?[^/]*)(?:$|\/)|\.(?:pem|key)$/i.test(path)) ||
      /(?:^|\/)(?:\.git|\.ssh|\.codex|CURRENT)(?:$|\/)/i.test(path) ||
      exclude.some(p => path === p.replace(/\/$/, '') || path.startsWith(p.replace(/\/$/, '') + '/'))) return 'Path is excluded credential/private material; remove it from scope.';
  return undefined;
}
export function importProblem(path: string, exclude: string[] = []): string | undefined {
  return pathProblem(path, exclude) ?? (/credential|(?:^|\/)secrets?(?:\/|\.)|\.(?:pem|key)$|(?:^|\/)\.env(?:$|\.)/i.test(path)
    ? 'Local import references excluded credential/private source.' : undefined);
}
export function checkImport(path: string, exclude: string[] = []): void {
  const problem = importProblem(path, exclude);
  if (problem) throw new PathError(path, problem);
}
export class PathError extends Error {
  constructor(readonly path: string, problem: string) { super(`excluded path ${path}: ${problem}`); }
}
export function checkPaths(files: ChangedFile[], exclude: string[] = []): void {
  for (const file of files) for (const path of [file.path, file.previousPath].filter((p): p is string => p !== undefined)) {
    const problem = pathProblem(path, exclude);
    if (problem) throw new PathError(path, problem);
  }
}
export function immediateImports(path: string, text: string, tracked: Set<string>): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/(?:from\s*|import\s*|require\()\s*['"](\.[^'"]+)['"]/g)) {
    const stem = posix.normalize(posix.join(posix.dirname(path), m[1]!));
    if (stem.startsWith('../')) continue;
    const match = [stem, stem.replace(/\.js$/, '.ts'), stem + '.ts', stem + '.tsx', stem + '.js', stem + '/index.ts', stem + '/index.js'].find(p => tracked.has(p));
    if (match) found.add(match);
  }
  return [...found];
}
/** Shared exact-revision selector. Imports are one level from changed head sources only. */
export async function collectCode(files: ChangedFile[], head: string, base: string, tracked: Set<string>, read: (revision: string, path: string) => Promise<string>, exclude: string[] = []): Promise<CodeSource[]> {
  checkPaths(files, exclude);
  requireCapacity(evaluate(scopeObservation(files, [], ''), 'actual'));
  const selected = new Map(files.filter(f => reviewable(f.path)).map(f => [f.path, f.status === 'removed' ? base : head]));
  const result = new Map<string, CodeSource>();
  const add = async (path: string, revision: string) => {
    if (!result.has(path)) result.set(path, { path, revision, ref: `github:source:${revision}:${path}`, text: await read(revision, path) });
    return result.get(path)!;
  };
  for (const [path, revision] of [...selected]) {
    const source = await add(path, revision);
    if (revision !== head) continue;
    for (const imported of immediateImports(path, source.text, tracked)) {
      checkImport(imported, exclude);
      if (!selected.has(imported)) selected.set(imported, head);
    }
  }
  // Check the import count before reading additional source material.
  requireCapacity(evaluate({ ...scopeObservation(files, [...result.values()], ''), sources: selected.size }, 'actual'));
  for (const [path, revision] of selected) await add(path, revision);
  const sources = [...result.values()];
  requireCapacity(evaluate(scopeObservation(files, sources, ''), 'actual'));
  return sources;
}
