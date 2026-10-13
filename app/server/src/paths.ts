import { isAbsolute, resolve, sep } from 'node:path';
import { query } from './db.js';

export interface VaultFileRow {
  id: number;
  path: string;
  parent_path: string;
  name: string;
  title: string | null;
  ext: string;
  is_markdown: boolean;
  size_bytes: number;
  mtime: string;
  frontmatter: Record<string, unknown> | null;
  body: string | null;
}

/**
 * Step 1 and 2 of the three-step guard: syntactic rejection, then resolution
 * checked against the root. Returns the absolute path, or null if rejected.
 *
 * Backslashes are normalised before the segment check so a Windows-style
 * `..\..\etc` cannot walk out on a platform where `\` is an ordinary
 * filename character. Nothing in this vault has a backslash in a name, and
 * rejecting the ambiguity is cheaper than reasoning about it.
 *
 * Step 3 — the path must exist in `vault_files` — lives in `assertIndexed`,
 * because it is the step that makes this safe rather than approximately safe.
 */
export function safeVaultPath(root: string, input: string): string | null {
  if (input.includes('\0')) return null;
  if (isAbsolute(input) || /^[A-Za-z]:/.test(input)) return null;

  const normalised = input.replace(/\\/g, '/');
  if (normalised.split('/').some((seg) => seg === '..')) return null;

  const abs = resolve(root, normalised);
  const rootAbs = resolve(root);
  // `startsWith(root)` alone would accept a sibling like /tmp/vault-other.
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) return null;
  return abs;
}

/** Step 3: the index is the allowlist. A pruned file is unreachable. */
export async function assertIndexed(path: string): Promise<VaultFileRow | null> {
  const { rows } = await query<VaultFileRow>(
    `SELECT id, path, parent_path, name, title, ext, is_markdown, size_bytes, mtime,
            frontmatter, body
     FROM vault_files WHERE path = $1`,
    [path],
  );
  return rows[0] ?? null;
}

/** Normalises a query-string path to the form stored in `vault_files`. */
export function toVaultKey(input: string): string {
  return input.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '');
}
