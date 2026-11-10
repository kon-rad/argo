import { query } from '../../db.js';
import { decryptToken, encryptToken } from '../../social/crypto.js';

/**
 * Collector tokens at rest: AES-256-GCM with SOCIAL_TOKEN_ENC_KEY, the same
 * scheme the social module uses for its OAuth tokens (social/crypto.ts). The
 * table holds ciphertext only; errors stored next to it are redacted first.
 */

export type TokenPlatform = 'instagram';

export type TokenKind = 'instagram-login' | 'facebook-user';

export interface StoredToken { tokenKind: TokenKind; assetId: string | null; token: string; expiresAt: Date | null; refreshedAt: Date; lastError: string | null }

export async function loadToken(platform: TokenPlatform, account: string, encKey: string | undefined): Promise<StoredToken | null> {
  const { rows } = await query<{ access_token: string; expires_at: Date | null; refreshed_at: Date; last_error: string | null; token_kind: TokenKind; asset_id: string | null }>(
    `SELECT access_token, expires_at, refreshed_at, last_error, token_kind, asset_id FROM social_metric_tokens WHERE platform = $1 AND account = $2`,
    [platform, account.toLowerCase()],
  );
  const r = rows[0];
  if (!r) return null;
  return { tokenKind: r.token_kind, assetId: r.asset_id, token: decryptToken(r.access_token, encKey), expiresAt: r.expires_at, refreshedAt: r.refreshed_at, lastError: r.last_error };
}

export async function hasToken(platform: TokenPlatform, account: string): Promise<boolean> {
  const { rows } = await query(`SELECT 1 FROM social_metric_tokens WHERE platform = $1 AND account = $2`, [platform, account.toLowerCase()]);
  return rows.length > 0;
}

/** Stores (or replaces) a token. `refreshedAt` defaults to now: a token just issued can't be refreshed for 24 hours. */
export async function saveToken(
  platform: TokenPlatform, account: string, token: string, encKey: string | undefined,
  opts: { expiresAt?: Date | null; refreshedAt?: Date; tokenKind?: TokenKind; assetId?: string } = {},
): Promise<void> {
  await query(
    `INSERT INTO social_metric_tokens (platform, account, access_token, expires_at, refreshed_at, last_error, updated_at, token_kind, asset_id)
     VALUES ($1, $2, $3, $4, $5, NULL, now(), $6, $7)
     ON CONFLICT (platform, account) DO UPDATE SET access_token = excluded.access_token, expires_at = excluded.expires_at,
       refreshed_at = excluded.refreshed_at, last_error = NULL, updated_at = now(), token_kind = excluded.token_kind, asset_id = excluded.asset_id`,
    [platform, account.toLowerCase(), encryptToken(token, encKey), opts.expiresAt ?? null, opts.refreshedAt ?? new Date(), opts.tokenKind ?? 'instagram-login', opts.assetId ?? null],
  );
}

/** Notes a failed refresh; the token itself is left as it was, so collection goes on until it expires. */
export async function recordTokenError(platform: TokenPlatform, account: string, message: string): Promise<void> {
  await query(`UPDATE social_metric_tokens SET last_error = $3, updated_at = now() WHERE platform = $1 AND account = $2`,
    [platform, account.toLowerCase(), message.slice(0, 500)]);
}
