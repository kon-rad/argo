import { log } from '../logger.js';
import type { SocialProvider, StoredAccount } from './providers/types.js';
import { NoRefreshTokenError } from './providers/types.js';
import {
  accountsNeedingReauth,
  dueQueuedPosts,
  getAccount,
  markFailedOrRetry,
  markPosted,
  markPublishing,
  markReauthNotified,
  updateAccountTokens,
} from './store.js';

export type Notify = (text: string) => Promise<void>;

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
export async function runDuePosts(providers: Record<string, SocialProvider>, encKey: string | undefined, now = new Date()): Promise<{ posted: number; failed: number }> {
  const due = await dueQueuedPosts(now);
  let posted = 0;
  let failed = 0;
  for (const post of due) {
    await markPublishing(post.id);
    try {
      const account = await getAccount(post.accountId, encKey);
      if (!account) throw new Error(`account ${post.accountId} not found or disconnected`);
      const provider = providers[account.provider];
      if (!provider) throw new Error(`no provider registered for ${account.provider}`);
      const fresh = await freshAccount(post.accountId, provider, encKey, now);
      const result = await provider.publish(fresh, post);
      await markPosted(post.id, now, result.remoteId, result.url);
      posted++;
    } catch (err) {
      const message = err instanceof NoRefreshTokenError ? err.message : err instanceof Error ? err.message : String(err);
      log.error(`social: post ${post.id} failed: ${message}`);
      await markFailedOrRetry(post.id, post.attemptCount, message);
      failed++;
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
