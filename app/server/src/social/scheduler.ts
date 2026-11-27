import { log } from '../logger.js';
import type { QueuedPost, SocialProvider, StoredAccount } from './providers/types.js';
import { NoRefreshTokenError, NotSentError, RejectedError } from './providers/types.js';
import {
  accountsNeedingReauth,
  assignPublicTokens,
  beginAttempt,
  claimNextDue,
  finishAttempt,
  handedOffPosts,
  markFailed,
  getAccount,
  markPosted,
  markReauthNotified,
  postMedia,
  recoverStaleClaims,
  releaseClaimForRetry,
  updateAccountTokens,
  type AttemptOutcome,
  type ClaimedPost,
} from './store.js';

export type Notify = (text: string) => Promise<void>;

/** The relay is registered under this key; an account with transport 'buffer' uses it whatever its network. */
export const BUFFER_PROVIDER_KEY = 'buffer';
/** A relay that hasn't confirmed a post within this long gets it marked failed for the owner to check. */
export const RELAY_CONFIRM_TIMEOUT_MS = 24 * 3600_000;

export interface PassOptions {
  /** Base of the public media URLs a relay fetches, e.g. https://brain.example.com. */
  mediaBaseUrl?: string;
}

export function publicMediaUrl(base: string, token: string, filename: string): string {
  return `${base.replace(/\/+$/, '')}/api/social/media/${token}/${encodeURIComponent(filename)}`;
}

function providerFor(providers: Record<string, SocialProvider>, account: StoredAccount): SocialProvider {
  const key = account.transport === 'buffer' ? BUFFER_PROVIDER_KEY : account.provider;
  const provider = providers[key];
  if (!provider) throw new Error(`no provider registered for ${key}${key === BUFFER_PROVIDER_KEY ? ' (set BUFFER_API_KEY)' : ''}`);
  return provider;
}

/** Refreshes the token if it's expiring soon and a refresh token exists; otherwise returns it as-is or throws. */
async function freshAccount(id: number, provider: SocialProvider, encKey: string | undefined, now: Date): Promise<StoredAccount> {
  const account = await getAccount(id, encKey);
  if (!account) throw new Error(`social account ${id} not found or disconnected`);
  const expiringSoon = account.accessTokenExpiresAt.getTime() - now.getTime() < 2 * 60_000;
  if (!expiringSoon) return account;

  const tokens = await provider.refresh(account); // throws NoRefreshTokenError when there's nothing to refresh with
  await updateAccountTokens(id, tokens, encKey);
  return { ...account, accessToken: tokens.accessToken, accessTokenExpiresAt: tokens.accessTokenExpiresAt, refreshToken: tokens.refreshToken, refreshTokenExpiresAt: tokens.refreshTokenExpiresAt };
}

/**
 * One pass over due posts: publishes each with its account's provider, up to
 * `limit` per call so a backlog can't block the next scheduled run. Not a
 * workflow engine — a cron-polled table, sized for a handful of posts a day
 * (see design doc §4 for why Temporal wasn't worth adopting here).
 */
export async function runDuePosts(
  providers: Record<string, SocialProvider>,
  encKey: string | undefined,
  now = new Date(),
  /** No new post starts after this many ms, so a pass with slow uploads ends before the next timer tick piles up. */
  budgetMs = 40_000,
  clock: () => number = Date.now,
  pass: PassOptions = {},
): Promise<{ posted: number; failed: number; handedOff: number }> {
  const stale = await recoverStaleClaims(now);
  if (stale.uncertain) log.error(`social: ${stale.uncertain} post(s) lost their worker after the provider call began; marked uncertain (reconcile them)`);
  if (stale.requeued) log.error(`social: ${stale.requeued} post(s) lost their worker before the provider call; requeued`);
  const started = clock();
  let posted = 0;
  let failed = 0;
  let handedOff = 0;
  // One post at a time, claimed atomically: an overlapping pass takes other posts, never this one.
  // A post that failed before sending is requeued; it waits for the next pass, not this one.
  const tried: number[] = [];
  for (let n = 0; n < MAX_PER_PASS; n++) {
    if (clock() - started > budgetMs) break; // the rest stay queued for the next run
    const claim = await claimNextDue(now, tried);
    if (!claim) break;
    tried.push(claim.id);
    const outcome = await publishClaimed(providers, encKey, now, pass, claim);
    if (outcome === 'posted') posted++;
    else if (outcome === 'handed_off') handedOff++;
    else if (outcome !== 'lost') failed++;
  }
  return { posted, failed, handedOff };
}

/** At most this many posts per pass, as before (the time budget usually ends a pass first). */
const MAX_PER_PASS = 10;

function errorText(err: unknown): string {
  return err instanceof Error ? (err.message || err.name) : String(err);
}

/**
 * Publishes one claimed post in three phases. (1) Pre-send: account, token,
 * media. A failure here is proven pre-send and is retried. (2) The write-ahead
 * attempt row, committed only while the claim is held. (3) The provider call:
 * an id is posted (or handed off), NotSentError is retried, RejectedError
 * fails, and everything else (timeout, reset, 5xx, an answer without an id,
 * a failure to record the answer) is 'uncertain' and never resent automatically.
 */
async function publishClaimed(
  providers: Record<string, SocialProvider>,
  encKey: string | undefined,
  now: Date,
  pass: PassOptions,
  claim: ClaimedPost,
): Promise<'posted' | 'handed_off' | 'retry' | 'failed' | 'uncertain' | 'lost'> {
  const { claimToken, ...queued } = claim;
  const post: QueuedPost = { ...queued, media: [] };
  let provider: SocialProvider;
  let fresh: StoredAccount;
  try {
    const account = await getAccount(post.accountId, encKey);
    if (!account) throw new Error(`account ${post.accountId} not found or disconnected`);
    provider = providerFor(providers, account);
    fresh = await freshAccount(post.accountId, provider, encKey, now);
    post.media = await postMedia(post.id);
    if (account.transport === 'buffer' && post.media.length) {
      if (!pass.mediaBaseUrl) throw new Error('relayed media need a public base URL (SOCIAL_MEDIA_BASE_URL)');
      const tokens = await assignPublicTokens(post.id);
      post.media = post.media.map((m, i) => ({ ...m, publicUrl: publicMediaUrl(pass.mediaBaseUrl!, tokens.get(i)!, m.filename) }));
    }
  } catch (err) {
    const message = err instanceof NoRefreshTokenError ? err.message : errorText(err);
    log.error(`social: post ${post.id} failed before sending: ${message}`);
    return (await releaseClaimForRetry(post.id, claimToken, message)) ? 'retry' : 'lost';
  }

  const attemptId = await beginAttempt(post.id, claimToken, now);
  if (attemptId === null) {
    log.error(`social: post ${post.id}: claim lost before sending (lease expired); not sent`);
    return 'lost';
  }

  let outcome: AttemptOutcome;
  try {
    const result = await provider.publish(fresh, post);
    if (!result || typeof result.remoteId !== 'string' || !result.remoteId.trim()) {
      outcome = { kind: 'uncertain', message: 'the provider answered without a post id; it may have the post: check it, then reconcile' };
    } else if (result.pending) {
      outcome = { kind: 'handed_off', remoteId: result.remoteId };
    } else {
      outcome = { kind: 'sent', remoteId: result.remoteId, url: result.url };
    }
  } catch (err) {
    if (err instanceof NotSentError) outcome = { kind: 'not_sent', message: err.message };
    else if (err instanceof RejectedError) outcome = { kind: 'rejected', message: err.message };
    else outcome = { kind: 'uncertain', message: `the provider call did not finish cleanly (${errorText(err)}); it may have the post: check it, then reconcile` };
  }
  try {
    await finishAttempt(attemptId, outcome, now);
  } catch (err) {
    // The attempt stays 'sending'; after the lease the sweeper marks it uncertain. Never resent.
    log.error(`social: post ${post.id}: could not record the provider's answer (${errorText(err)}); it will become uncertain`);
    return 'uncertain';
  }
  switch (outcome.kind) {
    case 'sent':
      return 'posted';
    case 'handed_off':
      return 'handed_off';
    case 'not_sent':
      log.error(`social: post ${post.id} failed before sending: ${outcome.message}`);
      return 'retry';
    case 'rejected':
      log.error(`social: post ${post.id} refused: ${outcome.message}`);
      return 'failed';
    case 'uncertain':
      log.error(`social: post ${post.id} uncertain: ${outcome.message}`);
      return 'uncertain';
  }
}

/**
 * Asks the relay about each post it accepted: sent → posted with the network's
 * URL, error → failed (never retried: the relay has the post), no answer for
 * 24 h → failed for the owner to check. Each final failure pings `notify`.
 */
export async function pollHandedOff(
  providers: Record<string, SocialProvider>,
  encKey: string | undefined,
  notify: Notify,
  now = new Date(),
): Promise<{ posted: number; failed: number }> {
  let posted = 0;
  let failed = 0;
  for (const h of await handedOffPosts()) {
    try {
      const account = await getAccount(h.account_id, encKey);
      if (!account) throw new Error(`account ${h.account_id} not found or disconnected`);
      const provider = providerFor(providers, account);
      if (!provider.status) throw new Error(`${account.transport} provider can't report post status`);
      const s = await provider.status(account, h.remote_id);
      if (s.state === 'sent') {
        await markPosted(h.id, now, h.remote_id, s.url);
        posted++;
        continue;
      }
      const timedOut = now.getTime() - h.handed_off_at.getTime() > RELAY_CONFIRM_TIMEOUT_MS;
      if (s.state === 'pending' && !timedOut) continue;
      const message = s.state === 'error' ? s.message : 'the relay never confirmed this post within 24 h; check it there before queueing again';
      await markFailed(h.id, message, now);
      failed++;
      await notify(`[social] ${account.provider} post ${h.id} failed: ${message}`).catch(() => undefined);
    } catch (err) {
      // A status check that errors (network, rate limit) is retried next minute; the 24 h timeout still applies.
      log.error(`social: status check for post ${h.id} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { posted, failed };
}

/**
 * Daily check: pings Telegram once per account when its access token expires
 * within 7 days and there's no refresh token (or it's expiring too) to save
 * it automatically. This is the expected steady state for LinkedIn without
 * Marketing Developer Platform approval, not an error condition.
 */
export async function checkReauthNeeded(notify: Notify, now = new Date()): Promise<void> {
  const candidates = await accountsNeedingReauth(now);
  for (const c of candidates) {
    await notify(`[social] ${c.provider} account "${c.display_name}" needs reauthorization within 7 days or scheduled posts will stop.`);
    await markReauthNotified(c.id, now);
  }
}
