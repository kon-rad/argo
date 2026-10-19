import { query, withTransaction } from '../db.js';
import { decryptToken, encryptToken } from './crypto.js';
import type { ConnectedAccount, PostMedia, ProviderName, QueuedPost, StoredAccount, TokenPair } from './providers/types.js';

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

/** What a listing shows of an image: never the bytes. */
export interface MediaSummary {
  position: number;
  filename: string;
  contentType: string;
  size: number;
  altText: string;
}

export interface PostRow {
  id: number;
  account_id: number;
  body: string;
  media: MediaSummary[];
  status: string;
  scheduled_for: Date;
  posted_at: Date | null;
  remote_id: string | null;
  remote_url: string | null;
  last_error: string | null;
  attempt_count: number;
  created_at: Date;
}

const POST_COLUMNS = `p.*, (
  SELECT coalesce(json_agg(json_build_object(
    'position', m.position, 'filename', m.filename, 'contentType', m.content_type,
    'size', octet_length(m.bytes), 'altText', m.alt_text) ORDER BY m.position), '[]'::json)
  FROM social_post_media m WHERE m.post_id = p.id) AS media`;

/** The post and its images in one transaction: a post is never queued without the images it was meant to carry. */
export async function queuePost(accountId: number, body: string, media: PostMedia[], scheduledFor: Date): Promise<PostRow> {
  const id = await withTransaction(async (c) => {
    const { rows } = await c.query<{ id: number }>(
      `INSERT INTO social_posts (account_id, body, scheduled_for) VALUES ($1, $2, $3) RETURNING id`,
      [accountId, body, scheduledFor],
    );
    const postId = rows[0]!.id;
    for (const [position, m] of media.entries()) {
      await c.query(
        `INSERT INTO social_post_media (post_id, position, filename, content_type, bytes, alt_text) VALUES ($1, $2, $3, $4, $5, $6)`,
        [postId, position, m.filename, m.contentType, m.bytes, m.altText],
      );
    }
    return postId;
  });
  const { rows } = await query<PostRow>(`SELECT ${POST_COLUMNS} FROM social_posts p WHERE p.id = $1`, [id]);
  return rows[0]!;
}

export async function listPosts(status?: string): Promise<PostRow[]> {
  const { rows } = status
    ? await query<PostRow>(`SELECT ${POST_COLUMNS} FROM social_posts p WHERE p.status = $1 ORDER BY p.scheduled_for`, [status])
    : await query<PostRow>(`SELECT ${POST_COLUMNS} FROM social_posts p ORDER BY p.scheduled_for`);
  return rows;
}

export async function cancelPost(id: number): Promise<boolean> {
  const res = await query(`UPDATE social_posts SET status = 'canceled' WHERE id = $1 AND status = 'queued'`, [id]);
  return (res.rowCount ?? 0) > 0;
}

/** Due posts without their image bytes; the scheduler loads those one post at a time (postMedia). */
export async function dueQueuedPosts(now: Date, limit = 10): Promise<Omit<QueuedPost, 'media'>[]> {
  const { rows } = await query<{ id: number; account_id: number; body: string; attempt_count: number }>(
    `SELECT id, account_id, body, attempt_count FROM social_posts WHERE status = 'queued' AND scheduled_for <= $1 ORDER BY scheduled_for LIMIT $2`,
    [now, limit],
  );
  return rows.map((r) => ({ id: r.id, accountId: r.account_id, body: r.body, attemptCount: r.attempt_count }));
}

export async function postMedia(postId: number): Promise<PostMedia[]> {
  const { rows } = await query<{ filename: string; content_type: PostMedia['contentType']; bytes: Buffer; alt_text: string }>(
    `SELECT filename, content_type, bytes, alt_text FROM social_post_media WHERE post_id = $1 ORDER BY position`,
    [postId],
  );
  return rows.map((m) => ({ filename: m.filename, contentType: m.content_type, bytes: m.bytes, altText: m.alt_text }));
}

export async function markPublishing(id: number, now: Date): Promise<void> {
  await query(`UPDATE social_posts SET status = 'publishing', publishing_started_at = $2 WHERE id = $1`, [id, now]);
}

/**
 * A run killed mid-publish leaves its post in 'publishing'. After 15 minutes it
 * is marked failed, not requeued: LinkedIn may already have it, and a second
 * copy is worse than a post the owner has to check and requeue by hand.
 */
export async function failStalePublishing(now: Date): Promise<number> {
  const res = await query(
    `UPDATE social_posts SET status = 'failed', last_error = 'interrupted while publishing; check LinkedIn before queueing it again'
     WHERE status = 'publishing' AND (publishing_started_at IS NULL OR publishing_started_at < $1::timestamptz - interval '15 minutes')`,
    [now],
  );
  return res.rowCount ?? 0;
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
