import { log } from '../logger.js';
import type { QueuedPost, SocialProvider, StoredAccount } from './providers/types.js';
import { NoRefreshTokenError } from './providers/types.js';
import {
  accountsNeedingReauth,
  assignPublicTokens,
  handedOffPosts,
  markFailed,
  markHandedOff,
  dueQueuedPosts,
  getAccount,
  markFailedOrRetry,
  markPosted,
  failStalePublishing,
  markPublishing,
  markReauthNotified,
  postMedia,
  updateAccountTokens,
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
  const stale = await failStalePublishing(now);
  if (stale) log.error(`social: ${stale} post(s) were interrupted while publishing; marked failed`);
  const started = clock();
  const due = await dueQueuedPosts(now);
  let posted = 0;
  let failed = 0;
  let handedOff = 0;
  for (const queued of due) {
    if (clock() - started > budgetMs) break; // the rest stay queued for the next run
    await markPublishing(queued.id, now);
    const post: QueuedPost = { ...queued, media: [] };
    try {
      const account = await getAccount(post.accountId, encKey);
      if (!account) throw new Error(`account ${post.accountId} not found or disconnected`);
      const provider = providerFor(providers, account);
      const fresh = await freshAccount(post.accountId, provider, encKey, now);
      post.media = await postMedia(post.id);
      if (account.transport === 'buffer' && post.media.length) {
        if (!pass.mediaBaseUrl) throw new Error('relayed media need a public base URL (SOCIAL_MEDIA_BASE_URL)');
        const tokens = await assignPublicTokens(post.id);
        post.media = post.media.map((m, i) => ({ ...m, publicUrl: publicMediaUrl(pass.mediaBaseUrl!, tokens.get(i)!, m.filename) }));
      }
      const result = await provider.publish(fresh, post);
      if (result.pending) {
        await markHandedOff(post.id, now, result.remoteId);
        handedOff++;
      } else {
        await markPosted(post.id, now, result.remoteId, result.url);
        posted++;
      }
    } catch (err) {
      const message = err instanceof NoRefreshTokenError ? err.message : err instanceof Error ? err.message : String(err);
      log.error(`social: post ${post.id} failed: ${message}`);
      await markFailedOrRetry(post.id, post.attemptCount, message);
      failed++;
    }
  }
  return { posted, failed, handedOff };
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
      await markFailed(h.id, message);
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
