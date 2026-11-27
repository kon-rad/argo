import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { query, withTransaction } from '../db.js';
import { HttpError } from '../routes/http.js';
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

/**
 * Buffer-relayed accounts whose channel is no longer connected in Buffer (swapped or removed there): marked
 * disconnected, so `--account youtube` resolves to the one live channel again. Returns each with the count of
 * drafts and queued posts still pointing at it, which `move` re-points. An empty list changes nothing: an
 * empty answer is more likely a Buffer hiccup than every channel removed at once.
 */
export async function disconnectMissingBufferAccounts(liveChannelIds: string[]): Promise<{ id: number; provider: ProviderName; waiting: number }[]> {
  if (liveChannelIds.length === 0) return [];
  const { rows } = await query<{ id: number; provider: ProviderName; waiting: number }>(
    `WITH gone AS (
       UPDATE social_accounts SET disconnected_at = now()
       WHERE transport = 'buffer' AND disconnected_at IS NULL AND NOT (provider_account_id = ANY($1::text[]))
       RETURNING id, provider)
     SELECT g.id, g.provider,
            (SELECT count(*)::int FROM social_posts p WHERE p.account_id = g.id AND p.status IN ('draft', 'queued')) AS waiting
     FROM gone g ORDER BY g.id`,
    [liveChannelIds],
  );
  return rows;
}

/** Re-point a draft or queued post to another connected account on the same network. False if either doesn't fit. */
export async function movePost(id: number, accountId: number): Promise<boolean> {
  const res = await query(
    `UPDATE social_posts p SET account_id = $2
     FROM social_accounts old_a, social_accounts new_a
     WHERE p.id = $1 AND p.status IN ('draft', 'queued')
       AND old_a.id = p.account_id AND new_a.id = $2
       AND new_a.disconnected_at IS NULL AND new_a.provider = old_a.provider`,
    [id, accountId],
  );
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
  /** The kanban card behind the post, and the vault draft it came from (both optional). */
  card_id: string | null;
  source_path: string | null;
  idempotency_key: string | null;
}

const POST_COLUMNS = `p.*, (
  SELECT coalesce(json_agg(json_build_object(
    'position', m.position, 'filename', m.filename, 'contentType', m.content_type,
    'size', coalesce(octet_length(m.bytes), 0), 'altText', m.alt_text) ORDER BY m.position), '[]'::json)
  FROM social_post_media m WHERE m.post_id = p.id) AS media`;

export interface PostLink {
  cardId?: string | null;
  sourcePath?: string | null;
  /** A caller-chosen stable key; the same key with the same request returns the original post. */
  idempotencyKey?: string | null;
}

export const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:/-]{1,200}$/;

/** The same key was used for a different request; `postId` is the post the key already names. */
export class IdempotencyConflictError extends Error {
  constructor(readonly key: string, readonly postId: number) {
    super(`idempotency key ${key} already names post ${postId}, queued with a different account, time, body, options, media, draft flag or link`);
  }
}

/** JSON with object keys sorted, so option order never changes a fingerprint. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/** SHA-256 of everything that makes a queue request what it is; media by the hash of their bytes. */
export function requestFingerprint(
  accountId: number,
  body: string,
  media: PostMedia[],
  scheduledFor: Date,
  options: PostOptions,
  status: 'queued' | 'draft',
  link: PostLink,
): string {
  return createHash('sha256')
    .update(
      canonical({
        v: 1,
        accountId: Number(accountId),
        body,
        scheduledFor: scheduledFor.toISOString(),
        options,
        status,
        cardId: link.cardId ?? null,
        sourcePath: link.sourcePath ?? null,
        media: media.map((m) => ({ filename: m.filename, contentType: m.contentType, altText: m.altText, sha256: createHash('sha256').update(m.bytes).digest('hex') })),
      }),
    )
    .digest('hex');
}

async function readPost(id: number): Promise<PostRow> {
  const { rows } = await query<PostRow>(`SELECT ${POST_COLUMNS} FROM social_posts p WHERE p.id = $1`, [id]);
  return rows[0]!;
}

/**
 * The post and its media in one transaction: a post is never queued without the
 * media it was meant to carry. A 'draft' waits for `approvePost`; the timer skips it.
 *
 * With `link.idempotencyKey`, the insert is `ON CONFLICT DO NOTHING` on the key's
 * unique index, so concurrent requests with one key store one row: the same
 * request returns the original post (`created: false`), a different one throws
 * IdempotencyConflictError. Without a key, every call queues a new post.
 */
export async function enqueuePost(
  accountId: number,
  body: string,
  media: PostMedia[],
  scheduledFor: Date,
  options: PostOptions = {},
  status: 'queued' | 'draft' = 'queued',
  link: PostLink = {},
): Promise<{ post: PostRow; created: boolean }> {
  const key = link.idempotencyKey ?? null;
  if (key !== null && !IDEMPOTENCY_KEY.test(key)) {
    throw new HttpError(400, 'an idempotency key is 1 to 200 characters of letters, digits and . _ : / -');
  }
  const fingerprint = key === null ? null : requestFingerprint(accountId, body, media, scheduledFor, options, status, link);
  const id = await withTransaction(async (c) => {
    const { rows } = await c.query<{ id: number }>(
      `INSERT INTO social_posts (account_id, body, scheduled_for, options, status, card_id, source_path, idempotency_key, request_fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [accountId, body, scheduledFor, JSON.stringify(options), status, link.cardId ?? null, link.sourcePath ?? null, key, fingerprint],
    );
    if (!rows[0]) return null; // the key is taken (a concurrent insert has committed by now)
    const postId = rows[0].id;
    for (const [position, m] of media.entries()) {
      await c.query(
        `INSERT INTO social_post_media (post_id, position, filename, content_type, bytes, alt_text) VALUES ($1, $2, $3, $4, $5, $6)`,
        [postId, position, m.filename, m.contentType, m.bytes, m.altText],
      );
    }
    return postId;
  });
  if (id !== null) return { post: await readPost(id), created: true };

  const { rows } = await query<{ id: number; request_fingerprint: string }>(
    `SELECT id, request_fingerprint FROM social_posts WHERE idempotency_key = $1`,
    [key],
  );
  const existing = rows[0];
  if (!existing) throw new Error(`idempotency key ${key}: conflicting insert vanished; retry the request`);
  if (existing.request_fingerprint !== fingerprint) throw new IdempotencyConflictError(key!, Number(existing.id));
  return { post: await readPost(existing.id), created: false };
}

/** `enqueuePost` for callers that only want the row. */
export async function queuePost(
  accountId: number,
  body: string,
  media: PostMedia[],
  scheduledFor: Date,
  options: PostOptions = {},
  status: 'queued' | 'draft' = 'queued',
  link: PostLink = {},
): Promise<PostRow> {
  return (await enqueuePost(accountId, body, media, scheduledFor, options, status, link)).post;
}

export interface PostFilter {
  status?: string;
  /** scheduled_for >= from and < to. */
  from?: Date;
  to?: Date;
  accountIds?: number[];
}

export async function listPosts(filter: string | PostFilter = {}): Promise<PostRow[]> {
  const f: PostFilter = typeof filter === 'string' ? { status: filter } : filter;
  const where: string[] = [];
  const args: unknown[] = [];
  const add = (sql: string, v: unknown) => { args.push(v); where.push(sql.replace('?', `$${args.length}`)); };
  if (f.status) add('p.status = ?', f.status);
  if (f.from) add('p.scheduled_for >= ?::timestamptz', f.from);
  if (f.to) add('p.scheduled_for < ?::timestamptz', f.to);
  if (f.accountIds) add('p.account_id = ANY(?::bigint[])', f.accountIds);
  const { rows } = await query<PostRow>(
    `SELECT ${POST_COLUMNS} FROM social_posts p ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.scheduled_for, p.id`,
    args,
  );
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

/**
 * A file for the public media route: only while its post is publishing (or uncertain: a relay that
 * did accept it may still be fetching), and only before its bytes are dropped.
 */
export async function mediaByToken(token: string): Promise<{ contentType: string; bytes: Buffer } | null> {
  const { rows } = await query<{ content_type: string; bytes: Buffer }>(
    `SELECT m.content_type, m.bytes FROM social_post_media m JOIN social_posts p ON p.id = m.post_id
     WHERE m.public_token = $1 AND m.bytes IS NOT NULL AND p.status IN ('publishing', 'uncertain')`,
    [token],
  );
  return rows[0] ? { contentType: rows[0].content_type, bytes: rows[0].bytes } : null;
}

/** How long a claim may sit without a write-ahead attempt before the sweeper takes it back. */
export const LEASE_MS = 15 * 60_000;
/** Pre-send failures (proven: no provider call went out) are retried this many times in all. */
export const MAX_PRE_SEND_ATTEMPTS = 3;

export type ClaimedPost = Omit<QueuedPost, 'media'> & { claimToken: string };

/**
 * Takes the next due post for one worker: a single UPDATE over a
 * `FOR UPDATE SKIP LOCKED` pick, so overlapping workers never take the same
 * post. Every later write by the worker is conditional on `claimToken`.
 * `skip`: posts this pass already tried (a requeued pre-send failure waits for the next pass).
 */
export async function claimNextDue(now: Date, skip: number[] = []): Promise<ClaimedPost | null> {
  const token = randomUUID();
  const { rows } = await query<{ id: number; account_id: number; body: string; options: PostOptions; attempt_count: number }>(
    `UPDATE social_posts SET status = 'publishing', publishing_started_at = $1, claim_token = $2
     WHERE id = (SELECT id FROM social_posts WHERE status = 'queued' AND scheduled_for <= $1 AND NOT (id = ANY($3::bigint[]))
                 ORDER BY scheduled_for, id LIMIT 1 FOR UPDATE SKIP LOCKED)
       AND status = 'queued'
     RETURNING id, account_id, body, options, attempt_count`,
    [now, token, skip],
  );
  const r = rows[0];
  return r ? { id: Number(r.id), accountId: Number(r.account_id), body: r.body, options: r.options, attemptCount: r.attempt_count, claimToken: token } : null;
}

/**
 * The write-ahead record, committed before the provider call starts: under the
 * post's row lock, and only while this worker still holds its claim (a sweeper
 * that took the claim back, or a newer worker, makes this return null and the
 * caller must not send). Returns the attempt id. From this commit on, the post
 * may be out, whatever happens to the process.
 */
export async function beginAttempt(postId: number, claimToken: string, now: Date): Promise<number | null> {
  return withTransaction(async (c) => {
    const held = await c.query(
      `SELECT 1 FROM social_posts WHERE id = $1 AND status = 'publishing' AND claim_token = $2 AND handed_off_at IS NULL FOR UPDATE`,
      [postId, claimToken],
    );
    if (!held.rows[0]) return null;
    const inFlight = await c.query(`SELECT 1 FROM social_post_attempts WHERE post_id = $1 AND state = 'sending'`, [postId]);
    if (inFlight.rows[0]) return null;
    const { rows } = await c.query<{ id: number }>(
      `INSERT INTO social_post_attempts (post_id, attempt_no, claim_token, state, started_at)
       VALUES ($1, (SELECT coalesce(max(attempt_no), 0) + 1 FROM social_post_attempts WHERE post_id = $1), $2, 'sending', $3)
       RETURNING id`,
      [postId, claimToken, now],
    );
    return Number(rows[0]!.id);
  });
}

/** Drops a post's public media URLs and, once it is out, its video bytes (the network has the file now). */
async function releaseMedia(c: { query: typeof query }, postId: number, now: Date, posted: boolean): Promise<void> {
  if (!posted) {
    await c.query(`UPDATE social_post_media SET public_token = NULL WHERE post_id = $1`, [postId]);
    return;
  }
  await c.query(
    `UPDATE social_post_media SET public_token = NULL,
       bytes = CASE WHEN content_type LIKE 'video/%' THEN NULL ELSE bytes END,
       purged_at = CASE WHEN content_type LIKE 'video/%' THEN $2::timestamptz ELSE purged_at END
     WHERE post_id = $1`,
    [postId, now],
  );
}

export type AttemptOutcome =
  | { kind: 'sent'; remoteId: string; url?: string }
  | { kind: 'handed_off'; remoteId: string }
  | { kind: 'not_sent'; message: string }
  | { kind: 'rejected'; message: string }
  | { kind: 'uncertain'; message: string };

/**
 * Records how a write-ahead attempt ended, once: a second finish of the same
 * attempt changes nothing. The post moves only if this attempt is its latest
 * and the post is still in flight ('publishing') or was marked 'uncertain' by
 * the sweeper while the call was out; a post a human already reconciled keeps
 * its state and the attempt row keeps the late answer for the record.
 */
export async function finishAttempt(attemptId: number, outcome: AttemptOutcome, now: Date): Promise<void> {
  await withTransaction(async (c) => {
    // Lock order is post, then attempt, the same as recoverStaleClaims, so the two never deadlock.
    const owner = await c.query<{ post_id: number }>(`SELECT post_id FROM social_post_attempts WHERE id = $1`, [attemptId]);
    if (!owner.rows[0]) return;
    await c.query(`SELECT 1 FROM social_posts WHERE id = $1 FOR UPDATE`, [owner.rows[0].post_id]);
    const { rows } = await c.query<{ post_id: number; claim_token: string; state: string; finished_at: Date | null }>(
      `SELECT post_id, claim_token, state, finished_at FROM social_post_attempts WHERE id = $1 FOR UPDATE`,
      [attemptId],
    );
    const a = rows[0];
    // A swept attempt can still return; recording that it returned also proves
    // this worker cannot initiate its provider call later.
    if (!a || !(a.state === 'sending' || (a.state === 'uncertain' && a.finished_at === null && ['sent', 'handed_off', 'uncertain'].includes(outcome.kind)))) return;
    const remoteId = 'remoteId' in outcome ? outcome.remoteId : null;
    const error = 'message' in outcome ? outcome.message : null;
    await c.query(`UPDATE social_post_attempts SET state = $2, finished_at = $3, remote_id = $4, error = coalesce($5, error) WHERE id = $1`, [
      attemptId,
      outcome.kind,
      now,
      remoteId,
      error,
    ]);
    const post = await c.query<{ status: string }>(
      `SELECT p.status FROM social_posts p
       WHERE p.id = $1 AND p.status IN ('publishing', 'uncertain') AND p.handed_off_at IS NULL
         AND $2::bigint = (SELECT max(id) FROM social_post_attempts WHERE post_id = p.id)
       FOR UPDATE`,
      [a.post_id, attemptId],
    );
    if (!post.rows[0]) return;
    const id = a.post_id;
    switch (outcome.kind) {
      case 'sent':
        await c.query(
          `UPDATE social_posts SET status = 'posted', posted_at = $2, remote_id = $3, remote_url = $4, claim_token = NULL, last_error = NULL WHERE id = $1`,
          [id, now, outcome.remoteId, outcome.url ?? null],
        );
        await releaseMedia(c, id, now, true);
        return;
      case 'handed_off':
        // The relay has it; pollHandedOff resolves it from here. Media stay public for the relay to fetch.
        await c.query(`UPDATE social_posts SET status = 'publishing', handed_off_at = $2, remote_id = $3, claim_token = NULL WHERE id = $1`, [
          id,
          now,
          outcome.remoteId,
        ]);
        return;
      case 'uncertain':
        // Media stay public: a relay that did accept the post may still need to fetch them.
        await c.query(`UPDATE social_posts SET status = 'uncertain', last_error = $2, claim_token = NULL WHERE id = $1`, [id, outcome.message]);
        return;
      case 'rejected':
        await c.query(`UPDATE social_posts SET status = 'failed', last_error = $2, claim_token = NULL WHERE id = $1`, [id, outcome.message]);
        await releaseMedia(c, id, now, false);
        return;
      case 'not_sent':
        if (post.rows[0].status !== 'publishing') return;
        await retryOrFail(c, id, outcome.message);
        await releaseMedia(c, id, now, false);
        return;
    }
  });
}

async function retryOrFail(c: { query: typeof query }, postId: number, message: string): Promise<void> {
  await c.query(
    `UPDATE social_posts SET status = CASE WHEN attempt_count + 1 >= $3 THEN 'failed' ELSE 'queued' END,
       last_error = $2, attempt_count = attempt_count + 1, claim_token = NULL
     WHERE id = $1`,
    [postId, message, MAX_PRE_SEND_ATTEMPTS],
  );
}

/**
 * A failure before the write-ahead (account lookup, token refresh, media): no
 * provider call can have gone out, so the post is retried, up to
 * MAX_PRE_SEND_ATTEMPTS in all. Only the claim holder may do this.
 */
export async function releaseClaimForRetry(postId: number, claimToken: string, message: string): Promise<boolean> {
  return withTransaction(async (c) => {
    const held = await c.query(`SELECT 1 FROM social_posts WHERE id = $1 AND status = 'publishing' AND claim_token = $2 FOR UPDATE`, [postId, claimToken]);
    if (!held.rows[0]) return false;
    await retryOrFail(c, postId, message);
    return true;
  });
}

/**
 * Claims whose lease ran out. A claim with an attempt still 'sending' may have
 * reached the provider (an expired lease does not prove the worker is dead; it
 * may be paused mid-call), so the post and attempt become 'uncertain' and are
 * never retried automatically. A claim with no write-ahead never sent anything:
 * it is requeued (or failed after MAX_PRE_SEND_ATTEMPTS), and the stale worker,
 * if it wakes, can no longer write ahead. A 'publishing' row with no claim
 * token (left by the code before this change) is uncertain too.
 */
export async function recoverStaleClaims(now: Date): Promise<{ requeued: number; uncertain: number }> {
  return withTransaction(async (c) => {
    const { rows } = await c.query<{ id: number; claim_token: string | null; sending: number | null }>(
      `SELECT p.id, p.claim_token,
              (SELECT a.id FROM social_post_attempts a WHERE a.post_id = p.id AND a.state = 'sending') AS sending
       FROM social_posts p
       WHERE p.status = 'publishing' AND p.handed_off_at IS NULL
         AND (p.publishing_started_at IS NULL OR p.publishing_started_at < $1::timestamptz - make_interval(secs => $2))
       ORDER BY p.id
       FOR UPDATE OF p SKIP LOCKED`,
      [now, LEASE_MS / 1000],
    );
    let requeued = 0;
    let uncertain = 0;
    for (const r of rows) {
      if (r.sending !== null || r.claim_token === null) {
        const message = r.claim_token === null
          ? 'interrupted while publishing (before this version recorded attempts); the provider may have the post: check it, then reconcile'
          : 'the worker stopped answering after the provider call began; the provider may have the post: check it, then reconcile';
        if (r.sending !== null) {
          await c.query(`UPDATE social_post_attempts SET state = 'uncertain', error = $2 WHERE id = $1`, [r.sending, 'lease expired while sending']);
        }
        await c.query(`UPDATE social_posts SET status = 'uncertain', last_error = $2, claim_token = NULL WHERE id = $1`, [r.id, message]);
        uncertain++;
      } else {
        await retryOrFail(c, r.id, 'the worker stopped before calling the provider; requeued');
        requeued++;
      }
    }
    return { requeued, uncertain };
  });
}

/** A post is out: its public URLs stop working and its video bytes go (the network has the file now). */
export async function markPosted(id: number, now: Date, remoteId: string, url: string | undefined): Promise<void> {
  await withTransaction(async (c) => {
    await c.query(`UPDATE social_posts SET status = 'posted', posted_at = $2, remote_id = $3, remote_url = $4, claim_token = NULL WHERE id = $1`, [id, now, remoteId, url ?? null]);
    await releaseMedia(c, id, now, true);
  });
}

export interface AttemptRow {
  id: number;
  post_id: number;
  attempt_no: number;
  state: string;
  started_at: Date;
  finished_at: Date | null;
  remote_id: string | null;
  error: string | null;
}

export async function listAttempts(postId: number): Promise<AttemptRow[]> {
  const { rows } = await query<AttemptRow>(
    `SELECT id::int AS id, post_id::int AS post_id, attempt_no, state, started_at, finished_at, remote_id, error
     FROM social_post_attempts WHERE post_id = $1 ORDER BY attempt_no`,
    [postId],
  );
  return rows;
}

export interface ReconcileInput {
  outcome: 'posted' | 'not_posted';
  /** Required for 'posted': the network's id for the post someone found there. */
  remoteId?: string;
  url?: string;
  /** For 'not_posted': queue it again (one new send) instead of failing it. */
  requeue?: boolean;
  /** Why: what was checked, where. Required. */
  note: string;
  actor: string;
  via: 'cli' | 'api';
}

export interface ReconciliationRow {
  id: number;
  post_id: number;
  attempt_id: number | null;
  prior_status: string;
  outcome: string;
  new_status: string;
  remote_id: string | null;
  remote_url: string | null;
  note: string;
  actor: string;
  via: string;
  created_at: Date;
}

/**
 * A human's answer for an 'uncertain' post, with an audit row in the same
 * transaction. 'posted' needs the remote id; 'not_posted' fails the post or,
 * with `requeue`, queues it for exactly one new send. Only an uncertain post
 * can be reconciled, and concurrent calls resolve it once.
 */
export async function reconcilePost(id: number, input: ReconcileInput, now: Date): Promise<PostRow> {
  const note = input.note.trim();
  if (!note) throw new HttpError(400, 'a reconciliation needs a note: what you checked and where');
  if (note.length > 2000) throw new HttpError(400, 'the note is over 2000 characters');
  const actor = input.actor.trim();
  if (!actor || actor.length > 200) throw new HttpError(400, 'a reconciliation needs an actor of 1 to 200 characters');
  const remoteId = input.remoteId?.trim() || null;
  if (input.outcome === 'posted' && !remoteId) throw new HttpError(400, 'a posted outcome needs the remote id of the post you found');
  if (input.outcome === 'not_posted' && remoteId) throw new HttpError(400, 'a not-posted outcome takes no remote id');
  await withTransaction(async (c) => {
    const { rows } = await c.query<{ status: string }>(`SELECT status FROM social_posts WHERE id = $1 FOR UPDATE`, [id]);
    if (!rows[0]) throw new HttpError(404, `no post ${id}`);
    if (rows[0].status !== 'uncertain') throw new HttpError(409, `post ${id} is ${rows[0].status}, not uncertain; only an uncertain post is reconciled`);
    const attempt = await c.query<{ id: number; state: string; finished_at: Date | null }>(
      `SELECT id, state, finished_at FROM social_post_attempts WHERE post_id = $1 ORDER BY id DESC LIMIT 1 FOR UPDATE`, [id],
    );
    // A lease expiry does not stop a process paused between the write-ahead
    // and the provider call. Only an attempt whose call returned can be retried.
    if (input.outcome === 'not_posted' && input.requeue &&
        (!attempt.rows[0] || attempt.rows[0].state !== 'uncertain' || attempt.rows[0].finished_at === null)) {
      throw new HttpError(409, 'the original sender may still resume; requeue is blocked until its attempt has returned');
    }
    const newStatus = input.outcome === 'posted' ? 'posted' : input.requeue ? 'queued' : 'failed';
    if (newStatus === 'posted') {
      await c.query(
        `UPDATE social_posts SET status = 'posted', posted_at = $2, remote_id = $3, remote_url = $4, last_error = NULL, claim_token = NULL WHERE id = $1`,
        [id, now, remoteId, input.url ?? null],
      );
      await releaseMedia(c, id, now, true);
    } else if (newStatus === 'queued') {
      // A fresh start for the pre-send retry budget: this is a new, human-approved send.
      await c.query(
        `UPDATE social_posts SET status = 'queued', attempt_count = 0, handed_off_at = NULL, remote_id = NULL, claim_token = NULL,
           scheduled_for = least(scheduled_for, $2::timestamptz), last_error = $3 WHERE id = $1`,
        [id, now, `reconciled as not posted: ${note}`],
      );
      await releaseMedia(c, id, now, false);
    } else {
      await c.query(`UPDATE social_posts SET status = 'failed', last_error = $2, claim_token = NULL WHERE id = $1`, [id, `reconciled as not posted: ${note}`]);
      await releaseMedia(c, id, now, false);
    }
    await c.query(
      `INSERT INTO social_post_reconciliations (post_id, attempt_id, prior_status, outcome, new_status, remote_id, remote_url, note, actor, via, created_at)
       VALUES ($1, $2, 'uncertain', $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, attempt.rows[0]?.id ?? null, input.outcome, newStatus, remoteId, input.url ?? null, note, actor, input.via, now],
    );
  });
  return readPost(id);
}

export async function listReconciliations(postId: number): Promise<ReconciliationRow[]> {
  const { rows } = await query<ReconciliationRow>(
    `SELECT id::int AS id, post_id::int AS post_id, attempt_id::int AS attempt_id, prior_status, outcome, new_status, remote_id, remote_url, note, actor, via, created_at
     FROM social_post_reconciliations WHERE post_id = $1 ORDER BY id`,
    [postId],
  );
  return rows;
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

/**
 * Final: no retry. The relay already has the post, so queueing it again could post it twice.
 * Only a post still in flight moves, so an overlapping poll can't turn a posted post failed.
 */
export async function markFailed(id: number, message: string, now = new Date()): Promise<void> {
  await withTransaction(async (c) => {
    const res = await c.query(`UPDATE social_posts SET status = 'failed', last_error = $2, claim_token = NULL WHERE id = $1 AND status = 'publishing'`, [id, message]);
    if (res.rowCount) await releaseMedia(c, id, now, false);
  });
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
