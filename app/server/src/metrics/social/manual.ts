import type { SocialMetricsSettings } from '../../settings.js';
import { socialAccounts } from './accounts.js';
import { insertAccountSamples, postKey, upsertPostStats, utcDay } from './store.js';

/**
 * LinkedIn by hand. A personal profile's analytics API is offered to approved
 * partners only, so nothing here calls LinkedIn: the owner reads the numbers
 * off LinkedIn (weekly is enough) and records them. They are stored with
 * source `manual` and judged stale after 8 days unless the account says
 * otherwise.
 */

export interface LinkedInEntry {
  followers?: number;
  post?: { url: string; views?: number; likes?: number; comments?: number; shares?: number; reach?: number; postedAt?: Date };
  /** YYYY-MM-DD the numbers were read (UTC); default today. */
  date?: string;
}

export async function recordLinkedIn(s: SocialMetricsSettings, account: string, e: LinkedInEntry, now = new Date()): Promise<void> {
  const a = socialAccounts(s).find((x) => x.platform === 'linkedin' && x.account === account);
  if (!a) {
    throw new Error(`LinkedIn account "${account}" is not in socialMetrics.linkedin in secondbrain.json; configured: ${s.linkedin.map((l) => l.account).join(', ') || 'none'}`);
  }
  if (e.date && !/^\d{4}-\d{2}-\d{2}$/.test(e.date)) throw new Error('date must be YYYY-MM-DD');
  const at = e.date ? new Date(`${e.date}T12:00:00Z`) : now;
  if (Number.isNaN(at.getTime())) throw new Error(`not a date: ${e.date}`);
  if (e.followers === undefined && !e.post) throw new Error('nothing to record: give --followers and/or --post');
  for (const v of [e.followers, e.post?.views, e.post?.likes, e.post?.comments, e.post?.shares, e.post?.reach]) {
    if (v !== undefined && (!Number.isInteger(v) || v < 0)) throw new Error(`not a count: ${v}`);
  }

  if (e.followers !== undefined) {
    await insertAccountSamples([{ metric: a.followersMetric, unit: 'followers', value: e.followers, source: 'manual' }], at);
  }
  if (e.post) {
    const id = postKey('linkedin', e.post.url) ?? e.post.url;
    await upsertPostStats([{
      platform: 'linkedin', account: a.account, externalId: id, url: e.post.url, postedAt: e.post.postedAt ?? null, kind: 'post',
      views: e.post.views ?? null, likes: e.post.likes ?? null, comments: e.post.comments ?? null,
      shares: e.post.shares ?? null, saves: null, reach: e.post.reach ?? null, source: 'manual',
    }], utcDay(at), at);
  }
}
