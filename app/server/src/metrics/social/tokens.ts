import { query } from '../../db.js';
import { decryptToken, encryptToken } from '../../social/crypto.js';

/**
 * Collector tokens at rest: AES-256-GCM with SOCIAL_TOKEN_ENC_KEY, the same
 * scheme the social module uses for its OAuth tokens (social/crypto.ts). The
 * table holds ciphertext only; errors stored next to it are redacted first.
 */

export type TokenPlatform = 'instagram';

export interface StoredToken { token: string; expiresAt: Date | null; refreshedAt: Date; lastError: string | null }

export async function loadToken(platform: TokenPlatform, account: string, encKey: string | undefined): Promise<StoredToken | null> {
  const { rows } = await query<{ access_token: string; expires_at: Date | null; refreshed_at: Date; last_error: string | null }>(
    `SELECT access_token, expires_at, refreshed_at, last_error FROM social_metric_tokens WHERE platform = $1 AND account = $2`,
    [platform, account.toLowerCase()],
  );
  const r = rows[0];
  if (!r) return null;
  return { token: decryptToken(r.access_token, encKey), expiresAt: r.expires_at, refreshedAt: r.refreshed_at, lastError: r.last_error };
}

export async function hasToken(platform: TokenPlatform, account: string): Promise<boolean> {
  const { rows } = await query(`SELECT 1 FROM social_metric_tokens WHERE platform = $1 AND account = $2`, [platform, account.toLowerCase()]);
  return rows.length > 0;
}

/** Stores (or replaces) a token. `refreshedAt` defaults to now: a token just issued can't be refreshed for 24 hours. */
export async function saveToken(
  platform: TokenPlatform, account: string, token: string, encKey: string | undefined,
  opts: { expiresAt?: Date | null; refreshedAt?: Date } = {},
): Promise<void> {
  await query(
    `INSERT INTO social_metric_tokens (platform, account, access_token, expires_at, refreshed_at, last_error, updated_at)
     VALUES ($1, $2, $3, $4, $5, NULL, now())
     ON CONFLICT (platform, account) DO UPDATE SET access_token = excluded.access_token, expires_at = excluded.expires_at,
       refreshed_at = excluded.refreshed_at, last_error = NULL, updated_at = now()`,
    [platform, account.toLowerCase(), encryptToken(token, encKey), opts.expiresAt ?? null, opts.refreshedAt ?? new Date()],
  );
}

/** Notes a failed refresh; the token itself is left as it was, so collection goes on until it expires. */
export async function recordTokenError(platform: TokenPlatform, account: string, message: string): Promise<void> {
  await query(`UPDATE social_metric_tokens SET last_error = $3, updated_at = now() WHERE platform = $1 AND account = $2`,
    [platform, account.toLowerCase(), message.slice(0, 500)]);
}
