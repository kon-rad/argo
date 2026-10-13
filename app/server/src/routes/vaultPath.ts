import { assertIndexed, safeVaultPath, toVaultKey, type VaultFileRow } from '../paths.js';
import { HttpError } from './http.js';

/** The full three-step guard, in the order the spec fixes. */
export async function resolveIndexed(
  vaultRoot: string,
  raw: unknown,
): Promise<{ key: string; abs: string; row: VaultFileRow }> {
  const { key, abs } = resolveDir(vaultRoot, raw);
  if (!key) throw new HttpError(400, 'path is required');

  const row = await assertIndexed(key);
  if (!row) throw new HttpError(404, `not in the index: ${key}`);
  return { key, abs, row };
}

/** Steps 1 and 2 only — directories have no row to check against. */
export function resolveDir(vaultRoot: string, raw: unknown): { key: string; abs: string } {
  if (raw !== undefined && typeof raw !== 'string') throw new HttpError(400, 'path must be a string');
  const key = toVaultKey(raw ?? '');
  const abs = safeVaultPath(vaultRoot, key);
  if (abs === null) throw new HttpError(400, 'path escapes the vault root');
  return { key, abs };
}
