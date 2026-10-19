import { query } from '../db.js';
import { decryptToken, encryptToken } from './crypto.js';
import type { ConnectedAccount, ProviderName, QueuedPost, StoredAccount, TokenPair } from './providers/types.js';

interface AccountRow {
  id: number;
  provider: ProviderName;
  provider_account_id: string;
  display_name: string;
  access_token: string;
  access_token_expires_at: Date;
  refresh_token: string | null;
  refresh_token_expires_at: Date | null;
  reauth_notified_at: Date | null;
  connected_at: Date;
  disconnected_at: Date | null;
}

function toStoredAccount(row: AccountRow, encKey: string | undefined): StoredAccount {
  return {
    id: row.id,
    provider: row.provider,
    providerAccountId: row.provider_account_id,
    displayName: row.display_name,
    accessToken: decryptToken(row.access_token, encKey),
    accessTokenExpiresAt: row.access_token_expires_at,
    refreshToken: row.refresh_token ? decryptToken(row.refresh_token, encKey) : null,
    refreshTokenExpiresAt: row.refresh_token_expires_at,
  };
}

/** Upserts on (provider, provider_account_id): reconnecting the same account replaces its tokens. */
export async function saveConnectedAccount(provider: ProviderName, account: ConnectedAccount, encKey: string | undefined): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO social_accounts (provider, provider_account_id, display_name, access_token, access_token_expires_at, refresh_token, refresh_token_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (provider, provider_account_id) DO UPDATE SET
       display_name = excluded.display_name,
       access_token = excluded.access_token,
       access_token_expires_at = excluded.access_token_expires_at,
       refresh_token = excluded.refresh_token,
       refresh_token_expires_at = excluded.refresh_token_expires_at,
       reauth_notified_at = NULL,
       disconnected_at = NULL
     RETURNING id`,
    [
      provider,
      account.providerAccountId,
      account.displayName,
      encryptToken(account.tokens.accessToken, encKey),
      account.tokens.accessTokenExpiresAt,
      account.tokens.refreshToken ? encryptToken(account.tokens.refreshToken, encKey) : null,
      account.tokens.refreshTokenExpiresAt,
    ],
  );
  return rows[0]!.id;
}

export async function updateAccountTokens(id: number, tokens: TokenPair, encKey: string | undefined): Promise<void> {
  await query(
    `UPDATE social_accounts SET access_token = $2, access_token_expires_at = $3, refresh_token = $4, refresh_token_expires_at = $5, reauth_notified_at = NULL
     WHERE id = $1`,
    [
      id,
      encryptToken(tokens.accessToken, encKey),
      tokens.accessTokenExpiresAt,
      tokens.refreshToken ? encryptToken(tokens.refreshToken, encKey) : null,
      tokens.refreshTokenExpiresAt,
    ],
  );
}

export async function getAccount(id: number, encKey: string | undefined): Promise<StoredAccount | null> {
  const { rows } = await query<AccountRow>(`SELECT * FROM social_accounts WHERE id = $1 AND disconnected_at IS NULL`, [id]);
  return rows[0] ? toStoredAccount(rows[0], encKey) : null;
}

export interface AccountSummary {
  id: number;
  provider: ProviderName;
  displayName: string;
  accessTokenExpiresAt: Date;
  hasRefreshToken: boolean;
  connectedAt: Date;
}

export async function listAccounts(): Promise<AccountSummary[]> {
  const { rows } = await query<AccountRow>(`SELECT * FROM social_accounts WHERE disconnected_at IS NULL ORDER BY connected_at`);
  return rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    displayName: r.display_name,
    accessTokenExpiresAt: r.access_token_expires_at,
    hasRefreshToken: Boolean(r.refresh_token),
    connectedAt: r.connected_at,
  }));
}

export async function disconnectAccount(id: number): Promise<boolean> {
  const res = await query(`UPDATE social_accounts SET disconnected_at = now() WHERE id = $1 AND disconnected_at IS NULL`, [id]);
  return (res.rowCount ?? 0) > 0;
}

export interface PostRow {
  id: number;
  account_id: number;
  body: string;
  media_paths: string[];
  status: string;
  scheduled_for: Date;
  posted_at: Date | null;
  remote_id: string | null;
  remote_url: string | null;
  last_error: string | null;
  attempt_count: number;
  created_at: Date;
}

export async function queuePost(accountId: number, body: string, mediaPaths: string[], scheduledFor: Date): Promise<PostRow> {
  const { rows } = await query<PostRow>(
    `INSERT INTO social_posts (account_id, body, media_paths, scheduled_for) VALUES ($1, $2, $3, $4) RETURNING *`,
    [accountId, body, mediaPaths, scheduledFor],
  );
  return rows[0]!;
}

export async function listPosts(status?: string): Promise<PostRow[]> {
  const { rows } = status
    ? await query<PostRow>(`SELECT * FROM social_posts WHERE status = $1 ORDER BY scheduled_for`, [status])
    : await query<PostRow>(`SELECT * FROM social_posts ORDER BY scheduled_for`);
  return rows;
}

export async function cancelPost(id: number): Promise<boolean> {
  const res = await query(`UPDATE social_posts SET status = 'canceled' WHERE id = $1 AND status = 'queued'`, [id]);
  return (res.rowCount ?? 0) > 0;
}

export async function dueQueuedPosts(now: Date, limit = 10): Promise<QueuedPost[]> {
  const { rows } = await query<{ id: number; account_id: number; body: string; media_paths: string[]; attempt_count: number }>(
    `SELECT id, account_id, body, media_paths, attempt_count FROM social_posts WHERE status = 'queued' AND scheduled_for <= $1 ORDER BY scheduled_for LIMIT $2`,
    [now, limit],
  );
  return rows.map((r) => ({ id: r.id, accountId: r.account_id, body: r.body, mediaPaths: r.media_paths, attemptCount: r.attempt_count }));
}

export async function markPublishing(id: number): Promise<void> {
  await query(`UPDATE social_posts SET status = 'publishing' WHERE id = $1`, [id]);
}

export async function markPosted(id: number, now: Date, remoteId: string, url: string | undefined): Promise<void> {
  await query(`UPDATE social_posts SET status = 'posted', posted_at = $2, remote_id = $3, remote_url = $4 WHERE id = $1`, [id, now, remoteId, url ?? null]);
}

/** Gives up after 3 attempts (this one included), leaving the post 'failed' rather than retrying forever. */
export async function markFailedOrRetry(id: number, attemptCount: number, message: string): Promise<void> {
  const nextStatus = attemptCount + 1 >= 3 ? 'failed' : 'queued';
  await query(`UPDATE social_posts SET status = $2, last_error = $3, attempt_count = attempt_count + 1 WHERE id = $1`, [id, nextStatus, message]);
}

export interface ReauthCandidate {
  id: number;
  provider: ProviderName;
  display_name: string;
}

export async function accountsNeedingReauth(now: Date): Promise<ReauthCandidate[]> {
  const { rows } = await query<ReauthCandidate>(
    `SELECT id, provider, display_name FROM social_accounts
     WHERE disconnected_at IS NULL
       AND access_token_expires_at < $1::timestamptz + interval '7 days'
       AND (refresh_token IS NULL OR refresh_token_expires_at < $1::timestamptz + interval '7 days')
       AND (reauth_notified_at IS NULL OR reauth_notified_at < $1::timestamptz - interval '24 hours')`,
    [now],
  );
  return rows;
}

export async function markReauthNotified(id: number, now: Date): Promise<void> {
  await query(`UPDATE social_accounts SET reauth_notified_at = $1 WHERE id = $2`, [now, id]);
}
