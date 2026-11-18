import { query } from '../../db.js';
import type { SocialMetricsSettings } from '../../settings.js';
import { socialAccounts, type SocialAccount } from './accounts.js';
import { chunks, count, getJson, redact } from './http.js';
import { INSTAGRAM_SOURCE, resolveToken } from './instagram.js';
import { postKey } from './store.js';
import { emptyResult, type SocialDeps } from './types.js';
import { MISSING_YOUTUBE_KEY, YOUTUBE_SOURCE } from './youtube.js';

/**
 * Fixed-age readings per post (social_post_metrics): each YouTube and
 * Instagram post is read once it is 24 hours, 72 hours and 7 days old, so
 * posts can be ranked at the same age (social growth loop: 72 h is the
 * comparison point, 24 h and 7 d show the curve).
 *
 * Runs hourly. A checkpoint is taken in its own window only (24h until the
 * post is 72 hours old, 72h until 7 days, 7d until 8 days): a missed window
 * leaves no row rather than a mislabelled one, and sampled_at minus posted_at
 * is the exact age. A failed or refused read writes the metrics as NULL with
 * the redacted error, and is retried each run while its window is open; a
 * good reading is never overwritten.
 *
 * Posts come from the daily collector's social_post_stats (every upload on a
 * configured channel or account, found within a day of posting) plus YouTube
 * posts the social module published (their video id is in the URL, and an API
 * key reads any public video). An Instagram post needs its account's token, so
 * only posts on a configured Instagram account are read.
 */

export type Checkpoint = '24h' | '72h' | '7d';
const HOUR = 3_600_000;
/** Each checkpoint and the age range in which it may be taken. */
export const CHECKPOINTS: readonly { name: Checkpoint; from: number; until: number }[] = [
  { name: '24h', from: 24 * HOUR, until: 72 * HOUR },
  { name: '72h', from: 72 * HOUR, until: 168 * HOUR },
  { name: '7d', from: 168 * HOUR, until: 192 * HOUR },
];
const OLDEST = CHECKPOINTS[CHECKPOINTS.length - 1]!.until;

export const YOUTUBE_METRICS = ['views', 'likes', 'comments'] as const;
export const INSTAGRAM_METRICS = ['views', 'reach', 'likes', 'comments', 'shares', 'saves'] as const;

/** The checkpoint whose window holds this age, or null when none does. */
export function checkpointAt(postedAt: Date, now: Date): Checkpoint | null {
  const age = now.getTime() - postedAt.getTime();
  return CHECKPOINTS.find((c) => age >= c.from && age < c.until)?.name ?? null;
}

export interface DuePost {
  platform: 'youtube' | 'instagram';
  account: string | null;
  remoteId: string;
  postedAt: Date;
  socialPostId: number | null;
  checkpoint: Checkpoint;
}

export interface CheckpointReading extends DuePost {
  source: string;
  values: Record<string, number | null>;
  /** Set when the whole read, or part of it, failed: the metrics it lacks stay NULL. */
  error: string | null;
  /** Metrics the error applies to; the others were read. */
  failed: string[];
}

/** Posts with a checkpoint due now and no good reading for it yet. */
export async function duePosts(now: Date): Promise<DuePost[]> {
  const since = new Date(now.getTime() - OLDEST);
  const { rows: stats } = await query<{ platform: 'youtube' | 'instagram'; account: string; remote_id: string; posted_at: Date; social_post_id: string | null }>(
    `SELECT DISTINCT ON (platform, external_id) platform, account, external_id AS remote_id, posted_at, social_post_id::text
       FROM social_post_stats
      WHERE platform IN ('youtube', 'instagram') AND posted_at IS NOT NULL AND posted_at > $1
      ORDER BY platform, external_id, day DESC`,
    [since],
  );
  const { rows: published } = await query<{ id: string; remote_id: string | null; remote_url: string | null; posted_at: Date }>(
    `SELECT p.id::text, p.remote_id, p.remote_url, p.posted_at FROM social_posts p JOIN social_accounts a ON a.id = p.account_id
      WHERE a.provider = 'youtube' AND p.status = 'posted' AND p.posted_at > $1 ORDER BY p.id`,
    [since],
  );
  const { rows: done } = await query<{ platform: string; remote_id: string; checkpoint: string }>(
    `SELECT platform, remote_id, checkpoint FROM social_post_metrics
      WHERE posted_at > $1 GROUP BY platform, remote_id, checkpoint HAVING bool_and(error IS NULL)`,
    [since],
  );
  const taken = new Set(done.map((r) => `${r.platform}:${r.remote_id}:${r.checkpoint}`));

  const posts = new Map<string, Omit<DuePost, 'checkpoint'>>();
  for (const r of stats) {
    posts.set(`${r.platform}:${r.remote_id}`, {
      platform: r.platform, account: r.account, remoteId: r.remote_id, postedAt: new Date(r.posted_at),
      socialPostId: r.social_post_id === null ? null : Number(r.social_post_id),
    });
  }
  for (const r of published) {
    const id = postKey('youtube', r.remote_url) ?? postKey('youtube', r.remote_id);
    if (!id) continue;
    const seen = posts.get(`youtube:${id}`);
    if (seen) seen.socialPostId ??= Number(r.id);
    else posts.set(`youtube:${id}`, { platform: 'youtube', account: null, remoteId: id, postedAt: new Date(r.posted_at), socialPostId: Number(r.id) });
  }

  const out: DuePost[] = [];
  for (const p of posts.values()) {
    const checkpoint = checkpointAt(p.postedAt, now);
    if (checkpoint && !taken.has(`${p.platform}:${p.remoteId}:${checkpoint}`)) out.push({ ...p, checkpoint });
  }
  return out.sort((a, b) => a.postedAt.getTime() - b.postedAt.getTime());
}

function failedReading(p: DuePost, source: string, metrics: readonly string[], error: string): CheckpointReading {
  return { ...p, source, values: Object.fromEntries(metrics.map((m) => [m, null])), error, failed: [...metrics] };
}

interface Video { id: string; statistics?: { viewCount?: string; likeCount?: string; commentCount?: string } }

async function readYouTube(posts: DuePost[], deps: SocialDeps): Promise<CheckpointReading[]> {
  const key = deps.youtubeApiKey;
  if (!key) return posts.map((p) => failedReading(p, YOUTUBE_SOURCE, YOUTUBE_METRICS, MISSING_YOUTUBE_KEY));
  const out: CheckpointReading[] = [];
  for (const batch of chunks(posts, 50)) {
    let videos: Map<string, Video>;
    try {
      const ids = [...new Set(batch.map((p) => p.remoteId))].join(',');
      const j = await getJson<{ items?: Video[] }>(deps.get, `https://www.googleapis.com/youtube/v3/videos?part=statistics&maxResults=50&id=${ids}`,
        'YouTube videos.list', [key], { 'x-goog-api-key': key });
      videos = new Map((j.items ?? []).map((v) => [v.id, v]));
    } catch (err) {
      const msg = redact((err as Error).message, [key]);
      out.push(...batch.map((p) => failedReading(p, YOUTUBE_SOURCE, YOUTUBE_METRICS, msg)));
      continue;
    }
    for (const p of batch) {
      const v = videos.get(p.remoteId);
      if (!v) {
        out.push(failedReading(p, YOUTUBE_SOURCE, YOUTUBE_METRICS, 'YouTube: video not returned (deleted, private or not yet processed)'));
        continue;
      }
      const st = v.statistics ?? {};
      // likeCount is absent when likes are hidden, commentCount when comments are off: NULL without an error.
      out.push({ ...p, source: YOUTUBE_SOURCE, values: { views: count(st.viewCount), likes: count(st.likeCount), comments: count(st.commentCount) }, error: null, failed: [] });
    }
  }
  return out;
}

interface Insight { name: string; values?: { value?: number }[]; total_value?: { value?: number } }

async function readInstagram(posts: DuePost[], s: SocialMetricsSettings, deps: SocialDeps): Promise<CheckpointReading[]> {
  const accounts = socialAccounts(s).filter((a): a is Extract<SocialAccount, { platform: 'instagram' }> => a.platform === 'instagram');
  const out: CheckpointReading[] = [];
  const byAccount = new Map<string, DuePost[]>();
  for (const p of posts) byAccount.set(p.account ?? '', [...(byAccount.get(p.account ?? '') ?? []), p]);

  for (const [account, list] of byAccount) {
    const a = accounts.find((x) => x.account === account);
    if (!a) {
      out.push(...list.map((p) => failedReading(p, INSTAGRAM_SOURCE, INSTAGRAM_METRICS, `@${account} is not in socialMetrics.instagram, so there is no token to read it with`)));
      continue;
    }
    let token: string | undefined;
    try {
      // Read only: the daily collector owns token seeding and refresh.
      token = await resolveToken(a, { ...deps, readOnly: true }, emptyResult(a));
    } catch (err) {
      const msg = redact((err as Error).message, [token]);
      out.push(...list.map((p) => failedReading(p, INSTAGRAM_SOURCE, INSTAGRAM_METRICS, msg)));
      continue;
    }
    const tok = token;
    const unified = a.cfg.login === 'unified';
    const base = `${unified ? 'https://graph.facebook.com' : 'https://graph.instagram.com'}/${s.instagramApiVersion}`;
    const auth = unified ? '' : `&access_token=${encodeURIComponent(tok)}`;
    const headers: Record<string, string> = unified ? { Authorization: `Bearer ${tok}` } : {};
    const call = <T>(url: string, what: string) => getJson<T>(deps.get, url, what, [tok], headers);

    for (const p of list) {
      const id = encodeURIComponent(p.remoteId);
      try {
        const j = await call<{ data?: Insight[] }>(`${base}/${id}/insights?metric=views,reach,likes,comments,shares,saved${auth}`, 'Instagram insights');
        const ins = new Map((j.data ?? []).map((d) => [d.name, count(d.total_value?.value ?? d.values?.[0]?.value)]));
        const get = (n: string) => ins.get(n) ?? null;
        out.push({ ...p, source: INSTAGRAM_SOURCE, error: null, failed: [],
          values: { views: get('views'), reach: get('reach'), likes: get('likes'), comments: get('comments'), shares: get('shares'), saves: get('saved') } });
      } catch (err) {
        // Insights refused (usually a missing insights scope): likes and comments still come from the media fields.
        const msg = redact((err as Error).message, [tok]);
        let media: { like_count?: number; comments_count?: number } | null = null;
        try {
          media = await call(`${base}/${id}?fields=like_count,comments_count${auth}`, 'Instagram media');
        } catch { /* both failed: every metric NULL */ }
        const r = failedReading(p, INSTAGRAM_SOURCE, INSTAGRAM_METRICS, msg);
        if (media) {
          r.values.likes = count(media.like_count);
          r.values.comments = count(media.comments_count);
          r.failed = ['views', 'reach', 'shares', 'saves'];
        }
        out.push(r);
      }
    }
  }
  return out;
}

/** Reads every due checkpoint once. Never throws for a platform failure: those become NULL readings with an error. */
export async function readCheckpoints(due: DuePost[], s: SocialMetricsSettings, deps: SocialDeps): Promise<CheckpointReading[]> {
  const secrets = [deps.youtubeApiKey, deps.encKey];
  const out = [
    ...await readYouTube(due.filter((p) => p.platform === 'youtube'), deps),
    ...await readInstagram(due.filter((p) => p.platform === 'instagram'), s, deps),
  ];
  for (const r of out) if (r.error) r.error = redact(r.error, secrets).slice(0, 1000);
  return out;
}

/**
 * One row per metric. A good reading is final: a later run only fills rows
 * whose earlier read failed. piece_id is left as it is.
 */
export async function storeCheckpoints(readings: CheckpointReading[], sampledAt: Date): Promise<void> {
  for (const r of readings) {
    for (const [metric, value] of Object.entries(r.values)) {
      const error = r.failed.includes(metric) ? r.error : null;
      await query(
        `INSERT INTO social_post_metrics AS m (social_post_id, platform, account, remote_id, checkpoint, metric, value, posted_at, sampled_at, source, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (platform, remote_id, checkpoint, metric) DO UPDATE SET
           social_post_id = COALESCE(excluded.social_post_id, m.social_post_id),
           account = COALESCE(excluded.account, m.account),
           value = excluded.value, posted_at = excluded.posted_at, sampled_at = excluded.sampled_at,
           source = excluded.source, error = excluded.error
         WHERE m.error IS NOT NULL`,
        [r.socialPostId, r.platform, r.account, r.remoteId, r.checkpoint, metric, value, r.postedAt, sampledAt, r.source, error],
      );
    }
  }
}

/** The hourly run: find due checkpoints, read them, store them (unless a dry run). */
export async function collectCheckpoints(s: SocialMetricsSettings, deps: SocialDeps, write = true): Promise<CheckpointReading[]> {
  const due = await duePosts(deps.now);
  const readings = await readCheckpoints(due, s, write ? deps : { ...deps, readOnly: true });
  if (write) await storeCheckpoints(readings, deps.now);
  return readings;
}

/** One line per post for the timer's journal: counts and redacted errors only. */
export function describeCheckpoint(r: CheckpointReading): string {
  const vals = Object.entries(r.values).map(([k, v]) => `${k}=${v ?? 'null'}`).join(' ');
  return `${r.platform}:${r.remoteId}\t${r.checkpoint}\t${r.error ? `FAILED (${r.failed.join(',')}): ${r.error}\t` : ''}${vals}`;
}
