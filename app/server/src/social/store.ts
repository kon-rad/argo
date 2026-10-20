import { randomBytes } from 'node:crypto';
import { query, withTransaction } from '../db.js';
import { decryptToken, encryptToken } from './crypto.js';
import type { ConnectedAccount, PostMedia, PostOptions, ProviderName, QueuedPost, StoredAccount, TokenPair, Transport } from './providers/types.js';

interface AccountRow {
  id: number;
  provider: ProviderName;
  transport: Transport;
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
    transport: row.transport,
    providerAccountId: row.provider_account_id,
    displayName: row.display_name,
    accessToken: decryptToken(row.access_token, encKey),
    accessTokenExpiresAt: row.access_token_expires_at,
    refreshToken: row.refresh_token ? decryptToken(row.refresh_token, encKey) : null,
    refreshTokenExpiresAt: row.refresh_token_expires_at,
  };
}

/** Upserts on (provider, provider_account_id): reconnecting the same account replaces its tokens. */
export async function saveConnectedAccount(
  provider: ProviderName,
  account: ConnectedAccount,
  encKey: string | undefined,
  transport: Transport = 'direct',
): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO social_accounts (provider, provider_account_id, display_name, access_token, access_token_expires_at, refresh_token, refresh_token_expires_at, transport)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (provider, provider_account_id) DO UPDATE SET
       display_name = excluded.display_name,
       transport = excluded.transport,
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
      transport,
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
  transport: Transport;
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
    transport: r.transport,
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
  options: PostOptions;
  status: string;
  scheduled_for: Date;
  posted_at: Date | null;
  remote_id: string | null;
  remote_url: string | null;
  last_error: string | null;
  attempt_count: number;
  handed_off_at: Date | null;
  created_at: Date;
}

const POST_COLUMNS = `p.*, (
  SELECT coalesce(json_agg(json_build_object(
    'position', m.position, 'filename', m.filename, 'contentType', m.content_type,
    'size', coalesce(octet_length(m.bytes), 0), 'altText', m.alt_text) ORDER BY m.position), '[]'::json)
  FROM social_post_media m WHERE m.post_id = p.id) AS media`;

/**
 * The post and its media in one transaction: a post is never queued without the
 * media it was meant to carry. A 'draft' waits for `approvePost`; the timer skips it.
 */
export async function queuePost(
  accountId: number,
  body: string,
  media: PostMedia[],
  scheduledFor: Date,
  options: PostOptions = {},
  status: 'queued' | 'draft' = 'queued',
): Promise<PostRow> {
  const id = await withTransaction(async (c) => {
    const { rows } = await c.query<{ id: number }>(
      `INSERT INTO social_posts (account_id, body, scheduled_for, options, status) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [accountId, body, scheduledFor, JSON.stringify(options), status],
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
  const res = await query(`UPDATE social_posts SET status = 'canceled' WHERE id = $1 AND status IN ('queued', 'draft')`, [id]);
  return (res.rowCount ?? 0) > 0;
}

/** The owner's yes: a draft becomes queued, for `at` or its own time (never in the past). */
export async function approvePost(id: number, now: Date, at?: Date): Promise<PostRow | null> {
  const res = await query<{ id: number }>(
    `UPDATE social_posts SET status = 'queued', scheduled_for = coalesce($3::timestamptz, greatest(scheduled_for, $2::timestamptz))
     WHERE id = $1 AND status = 'draft' RETURNING id`,
    [id, now, at ?? null],
  );
  if (!res.rows[0]) return null;
  const { rows } = await query<PostRow>(`SELECT ${POST_COLUMNS} FROM social_posts p WHERE p.id = $1`, [id]);
  return rows[0]!;
}

/** The network a connected account posts to, or null when it's missing or disconnected. */
export async function accountProvider(id: number): Promise<{ provider: ProviderName; transport: Transport } | null> {
  const { rows } = await query<{ provider: ProviderName; transport: Transport }>(
    `SELECT provider, transport FROM social_accounts WHERE id = $1 AND disconnected_at IS NULL`,
    [id],
  );
  return rows[0] ?? null;
}

/** Resolves `x`, `instagram`, ... to the one connected account for that network. */
export async function accountIdForProvider(provider: string): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `SELECT id FROM social_accounts WHERE provider = $1 AND disconnected_at IS NULL ORDER BY id`,
    [provider],
  );
  if (rows.length !== 1) throw new Error(`${rows.length} connected ${provider} accounts; pick one by id (see \`cli-social accounts\`)`);
  return Number(rows[0]!.id);
}

/** Due posts without their image bytes; the scheduler loads those one post at a time (postMedia). */
export async function dueQueuedPosts(now: Date, limit = 10): Promise<Omit<QueuedPost, 'media'>[]> {
  const { rows } = await query<{ id: number; account_id: number; body: string; options: PostOptions; attempt_count: number }>(
    `SELECT id, account_id, body, options, attempt_count FROM social_posts WHERE status = 'queued' AND scheduled_for <= $1 ORDER BY scheduled_for LIMIT $2`,
    [now, limit],
  );
  return rows.map((r) => ({ id: r.id, accountId: r.account_id, body: r.body, options: r.options, attemptCount: r.attempt_count }));
}

export async function postMedia(postId: number): Promise<PostMedia[]> {
  const { rows } = await query<{ filename: string; content_type: PostMedia['contentType']; bytes: Buffer; alt_text: string }>(
    `SELECT filename, content_type, bytes, alt_text FROM social_post_media WHERE post_id = $1 ORDER BY position`,
    [postId],
  );
  return rows.map((m) => ({ filename: m.filename, contentType: m.content_type, bytes: m.bytes, altText: m.alt_text }));
}

/**
 * Gives each of a post's media an unguessable token (kept if it has one) for
 * the public route a relay fetches from. Returns the tokens by position.
 */
export async function assignPublicTokens(postId: number): Promise<Map<number, string>> {
  const { rows } = await query<{ id: number; position: number; public_token: string | null }>(
    `SELECT id, position, public_token FROM social_post_media WHERE post_id = $1 ORDER BY position`,
    [postId],
  );
  const out = new Map<number, string>();
  for (const r of rows) {
    let token = r.public_token;
    if (!token) {
      token = randomBytes(24).toString('base64url');
      await query(`UPDATE social_post_media SET public_token = $2 WHERE id = $1`, [r.id, token]);
    }
    out.set(r.position, token);
  }
  return out;
}

/** A file for the public media route: only while its post is publishing, and only before its bytes are dropped. */
export async function mediaByToken(token: string): Promise<{ contentType: string; bytes: Buffer } | null> {
  const { rows } = await query<{ content_type: string; bytes: Buffer }>(
    `SELECT m.content_type, m.bytes FROM social_post_media m JOIN social_posts p ON p.id = m.post_id
     WHERE m.public_token = $1 AND m.bytes IS NOT NULL AND p.status = 'publishing'`,
    [token],
  );
  return rows[0] ? { contentType: rows[0].content_type, bytes: rows[0].bytes } : null;
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
     WHERE status = 'publishing' AND handed_off_at IS NULL AND (publishing_started_at IS NULL OR publishing_started_at < $1::timestamptz - interval '15 minutes')`,
    [now],
  );
  return res.rowCount ?? 0;
}

/** A post is out: its public URLs stop working and its video bytes go (the network has the file now). */
export async function markPosted(id: number, now: Date, remoteId: string, url: string | undefined): Promise<void> {
  await withTransaction(async (c) => {
    await c.query(`UPDATE social_posts SET status = 'posted', posted_at = $2, remote_id = $3, remote_url = $4 WHERE id = $1`, [id, now, remoteId, url ?? null]);
    await c.query(
      `UPDATE social_post_media SET public_token = NULL,
         bytes = CASE WHEN content_type LIKE 'video/%' THEN NULL ELSE bytes END,
         purged_at = CASE WHEN content_type LIKE 'video/%' THEN $2::timestamptz ELSE purged_at END
       WHERE post_id = $1`,
      [id, now],
    );
  });
}

/** A relay accepted the post; it stays 'publishing' until the relay reports it sent. */
export async function markHandedOff(id: number, now: Date, remoteId: string): Promise<void> {
  await query(`UPDATE social_posts SET handed_off_at = $2, remote_id = $3 WHERE id = $1`, [id, now, remoteId]);
}

export interface HandedOffPost {
  id: number;
  account_id: number;
  remote_id: string;
  handed_off_at: Date;
}

export async function handedOffPosts(limit = 20): Promise<HandedOffPost[]> {
  const { rows } = await query<HandedOffPost>(
    `SELECT id, account_id, remote_id, handed_off_at FROM social_posts
     WHERE status = 'publishing' AND handed_off_at IS NOT NULL ORDER BY handed_off_at LIMIT $1`,
    [limit],
  );
  return rows;
}

/** Final: no retry. The relay already has the post, so queueing it again could post it twice. */
export async function markFailed(id: number, message: string): Promise<void> {
  await withTransaction(async (c) => {
    await c.query(`UPDATE social_posts SET status = 'failed', last_error = $2 WHERE id = $1`, [id, message]);
    await c.query(`UPDATE social_post_media SET public_token = NULL WHERE post_id = $1`, [id]);
  });
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
     WHERE disconnected_at IS NULL AND transport = 'direct'
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
