import { query } from '../../db.js';
import type { Platform } from './accounts.js';
import type { AccountSample, PostStat, SocialResult } from './types.js';

/** The UTC day of a reading: the per-post row it lands in. */
export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function insertAccountSamples(samples: AccountSample[], sampledAt: Date): Promise<void> {
  for (const s of samples) {
    await query(
      `INSERT INTO metric_samples (metric, source, value, unit, raw, sampled_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [s.metric, s.source, s.value, s.unit, s.raw === undefined ? null : JSON.stringify(s.raw), sampledAt],
    );
  }
}

/**
 * One row per post per UTC day. A second reading the same day replaces the
 * first, except that a metric the new reading lacks (null) keeps the earlier
 * value: a failed insights call never wipes a good number.
 */
export async function upsertPostStats(posts: PostStat[], day: string, sampledAt: Date, matches: Map<string, number> = new Map()): Promise<void> {
  for (const p of posts) {
    await query(
      `INSERT INTO social_post_stats AS s (platform, account, external_id, day, url, posted_at, kind, views, likes, comments, shares, saves, reach,
                                           social_post_id, source, raw, sampled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       ON CONFLICT (platform, external_id, day) DO UPDATE SET
         account = excluded.account,
         url = COALESCE(excluded.url, s.url),
         posted_at = COALESCE(excluded.posted_at, s.posted_at),
         kind = COALESCE(excluded.kind, s.kind),
         views = COALESCE(excluded.views, s.views),
         likes = COALESCE(excluded.likes, s.likes),
         comments = COALESCE(excluded.comments, s.comments),
         shares = COALESCE(excluded.shares, s.shares),
         saves = COALESCE(excluded.saves, s.saves),
         reach = COALESCE(excluded.reach, s.reach),
         social_post_id = COALESCE(excluded.social_post_id, s.social_post_id),
         source = excluded.source,
         raw = excluded.raw,
         sampled_at = excluded.sampled_at`,
      [p.platform, p.account, p.externalId, day, p.url, p.postedAt, p.kind, p.views, p.likes, p.comments, p.shares, p.saves, p.reach,
        matchPost(matches, p.platform, p.externalId, p.url), p.source, p.raw === undefined ? null : JSON.stringify(p.raw), sampledAt],
    );
  }
}

export async function recordStatus(r: SocialResult, at: Date): Promise<void> {
  const ok = !r.error;
  await query(
    `INSERT INTO social_metric_status (collector, platform, account, last_run_at, last_ok_at, last_error, last_error_at, posts_written)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (collector) DO UPDATE SET
       platform = excluded.platform, account = excluded.account, last_run_at = excluded.last_run_at,
       last_ok_at = COALESCE(excluded.last_ok_at, social_metric_status.last_ok_at),
       last_error = excluded.last_error,
       last_error_at = COALESCE(excluded.last_error_at, social_metric_status.last_error_at),
       posts_written = excluded.posts_written`,
    [r.collector, r.platform, r.account, at, ok ? at : null, ok ? null : r.error!.slice(0, 1000), ok ? null : at, r.posts.length],
  );
}

/**
 * The key a post is known by on its platform, from an id or a URL: an X
 * status id, a YouTube video id, an Instagram shortcode. Lets a stat row find
 * the social_posts row that published it, whether that row kept the
 * network's id (direct) or only its URL (Buffer).
 */
export function postKey(platform: Platform, idOrUrl: string | null | undefined): string | null {
  if (!idOrUrl) return null;
  const s = idOrUrl.trim();
  let m: RegExpExecArray | null;
  switch (platform) {
    case 'x':
      m = /status(?:es)?\/(\d+)/.exec(s) ?? /^(\d+)$/.exec(s);
      return m ? m[1]! : null;
    case 'youtube':
      m = /(?:[?&]v=|\/shorts\/|youtu\.be\/|\/embed\/|\/live\/)([A-Za-z0-9_-]{11})/.exec(s) ?? /^([A-Za-z0-9_-]{11})$/.exec(s);
      return m ? m[1]! : null;
    case 'instagram':
      m = /instagram\.com\/(?:[A-Za-z0-9_.]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/.exec(s);
      return m ? `sc:${m[1]}` : null;
    case 'linkedin':
      m = /(?:activity|ugcPost|share)[:-](\d+)/.exec(s);
      return m ? m[1]! : null;
  }
}

/** Posted social_posts for a platform, by postKey of their remote id and URL. */
export async function publishedPosts(platform: Platform): Promise<Map<string, number>> {
  const { rows } = await query<{ id: string; remote_id: string | null; remote_url: string | null }>(
    `SELECT p.id::text, p.remote_id, p.remote_url FROM social_posts p JOIN social_accounts a ON a.id = p.account_id
      WHERE a.provider = $1 AND p.status = 'posted' ORDER BY p.id`,
    [platform],
  );
  const out = new Map<string, number>();
  for (const r of rows) {
    for (const v of [r.remote_url, r.remote_id]) {
      const k = postKey(platform, v);
      if (k && !out.has(k)) out.set(k, Number(r.id));
    }
  }
  return out;
}

/** Published X post URLs, the only X posts the collector can know about besides postIdsFile. */
export async function publishedUrls(platform: Platform): Promise<string[]> {
  const { rows } = await query<{ remote_url: string }>(
    `SELECT p.remote_url FROM social_posts p JOIN social_accounts a ON a.id = p.account_id
      WHERE a.provider = $1 AND p.status = 'posted' AND p.remote_url IS NOT NULL ORDER BY p.id`,
    [platform],
  );
  return rows.map((r) => r.remote_url);
}

function matchPost(matches: Map<string, number>, platform: Platform, externalId: string, url: string | null): number | null {
  for (const v of [externalId, url]) {
    const k = postKey(platform, v);
    if (k && matches.has(k)) return matches.get(k)!;
  }
  return null;
}
