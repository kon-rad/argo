import { posix } from 'node:path';
/** Only absolute structured paths beneath the configured vault establish vault scope.
 * Relative paths have no recorded cwd contract; keep them as separate path targets.
 */
export function vaultPath(path: string, root?: string): string | undefined {
  if (!root || !path.startsWith('/') || path.includes('\\') || /[\x00-\x1f]/.test(path)) return undefined;
  const base = posix.normalize(root).replace(/\/$/, '');
  const normalized = posix.normalize(path);
  if (!normalized.startsWith(`${base}/`)) return undefined;
  const relative = normalized.slice(base.length + 1);
  // The engine checkout and hidden subtrees are separate targets, even inside a vault.
  if (relative.split('/').some(part => part.startsWith('.'))) return undefined;
  return relative || undefined;
}
