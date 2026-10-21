import { config } from '../config.js';
import { query } from '../db.js';
import { decryptToken, encryptToken } from '../social/crypto.js';
import { settings, type SecondBrainSettings } from '../settings.js';
import { curlGet, type HttpGet } from './collect.js';

/**
 * Per-post daily stats into social_post_stats, from the official YouTube and
 * Instagram APIs and fxtwitter. Run by `cli-metrics collect` after the account
 * totals. A network with no key or no account configured is skipped, never an
 * error; a failing one writes nothing, and a number the platform didn't give
 * is stored as null, never 0.
 */

export interface PostStat {
  platform: 'youtube' | 'instagram' | 'x';
  account: string;
  externalId: string;
  url: string | null;
  postedAt: string | null;
  kind: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  reach: number | null;
  source: string;
  raw?: unknown;
}

export interface PostSource {
  name: string;
  run: () => Promise<PostStat[]>;
}

export interface PostResult { source: string; rows?: number; skipped?: string; error?: string }

const YT = 'https://www.googleapis.com/youtube/v3';
const IG = 'https://graph.instagram.com';
const IG_VERSION = 'v23.0';
/** Pages of 50 uploads read per channel: 200 videos, 4 + 4 units a day. */
const YT_MAX_PAGES = 4;
const IG_REFRESH_BELOW_DAYS = 15;

const num = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const json = <T>(r: { status: number; body: string }, what: string): T => {
  if (r.status !== 200) {
    let detail = '';
    try { detail = (JSON.parse(r.body) as { error?: { message?: string } }).error?.message ?? ''; } catch { /* not JSON */ }
    throw new Error(`${what}: HTTP ${r.status}${detail ? ` (${detail.slice(0, 120)})` : ''}`);
  }
  try { return JSON.parse(r.body) as T; } catch { throw new Error(`${what}: bad JSON`); }
};

// ------------------------------------------------------------------ YouTube

interface YtChannel {
  id: string;
  statistics?: { subscriberCount?: string; viewCount?: string; videoCount?: string; hiddenSubscriberCount?: boolean };
  contentDetails?: { relatedPlaylists?: { uploads?: string } };
}

export function parseYouTubeChannels(body: unknown): YtChannel[] {
  return ((body as { items?: YtChannel[] }).items ?? []).filter((c) => c && typeof c.id === 'string');
}

/** Subscribers for one channel; YouTube rounds above 1,000 and may hide the count. */
export function youtubeSubscribers(channel: YtChannel): number {
  if (channel.statistics?.hiddenSubscriberCount) throw new Error('YouTube: the channel hides its subscriber count');
  const n = num(channel.statistics?.subscriberCount);
  if (n === null) throw new Error('YouTube: no subscriberCount in the response');
  return n;
}

interface YtVideo {
  id: string;
  snippet?: { publishedAt?: string; channelId?: string; title?: string };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
}

export function parseYouTubeVideos(body: unknown, channelId: string): PostStat[] {
  return ((body as { items?: YtVideo[] }).items ?? []).map((v) => ({
    platform: 'youtube' as const,
    account: v.snippet?.channelId ?? channelId,
    externalId: v.id,
    url: `https://www.youtube.com/watch?v=${v.id}`,
    postedAt: v.snippet?.publishedAt ?? null,
    kind: null,
    views: num(v.statistics?.viewCount),
    likes: num(v.statistics?.likeCount),
    comments: num(v.statistics?.commentCount),
    shares: null,
    saves: null,
    reach: null,
    source: 'youtube-data-api',
  }));
}

const ytGet = (get: HttpGet, key: string, path: string, params: Record<string, string>) =>
  get(`${YT}/${path}?${new URLSearchParams(params)}`, { 'x-goog-api-key': key });

export async function youtubeChannel(get: HttpGet, key: string, id: string): Promise<YtChannel> {
  const ch = parseYouTubeChannels(json(await ytGet(get, key, 'channels', { part: 'statistics', id }), 'YouTube channels'))[0];
  if (!ch) throw new Error(`YouTube: no channel ${id}`);
  return ch;
}

async function resolveChannels(get: HttpGet, key: string, ids: string[], handles: string[]): Promise<YtChannel[]> {
  const out: YtChannel[] = [];
  if (ids.length) {
    out.push(...parseYouTubeChannels(json(await ytGet(get, key, 'channels', { part: 'contentDetails', id: ids.join(',') }), 'YouTube channels')));
  }
  for (const h of handles) {
    const found = parseYouTubeChannels(json(await ytGet(get, key, 'channels', { part: 'contentDetails', forHandle: h }), `YouTube channel ${h}`));
    if (!found[0]) throw new Error(`YouTube: no channel for handle ${h}`);
    out.push(found[0]);
  }
  return [...new Map(out.map((c) => [c.id, c])).values()];
}

export function youtubeSource(get: HttpGet, key: string, cfg: SecondBrainSettings['postStats']['youtube']): PostSource {
  return {
    name: 'youtube',
    run: async () => {
      const stats: PostStat[] = [];
      for (const ch of await resolveChannels(get, key, cfg.channelIds, cfg.handles)) {
        const uploads = ch.contentDetails?.relatedPlaylists?.uploads;
        if (!uploads) throw new Error(`YouTube: channel ${ch.id} has no uploads playlist`);
        const ids: string[] = [];
        let pageToken: string | undefined;
        for (let page = 0; page < YT_MAX_PAGES; page++) {
          const body = json<{ items?: { contentDetails?: { videoId?: string } }[]; nextPageToken?: string }>(
            await ytGet(get, key, 'playlistItems', { part: 'contentDetails', playlistId: uploads, maxResults: '50', ...(pageToken ? { pageToken } : {}) }),
            'YouTube playlistItems',
          );
          for (const i of body.items ?? []) if (i.contentDetails?.videoId) ids.push(i.contentDetails.videoId);
          pageToken = body.nextPageToken;
          if (!pageToken) break;
        }
        for (let i = 0; i < ids.length; i += 50) {
          const body = json(await ytGet(get, key, 'videos', { part: 'statistics,snippet', id: ids.slice(i, i + 50).join(',') }), 'YouTube videos');
          stats.push(...parseYouTubeVideos(body, ch.id));
        }
      }
      return stats;
    },
  };
}

// ---------------------------------------------------------------- Instagram

interface IgMedia {
  id: string;
  media_type?: string;
  media_product_type?: string;
  permalink?: string;
  timestamp?: string;
  like_count?: number;
  comments_count?: number;
}

export function parseInstagramProfile(body: unknown): { username: string | null; followers: number } {
  const d = body as { username?: string; followers_count?: number };
  if (typeof d.followers_count !== 'number') throw new Error('Instagram: no followers_count (token or account type?)');
  return { username: d.username ?? null, followers: d.followers_count };
}

/** Media insights come back as `{ data: [{ name, values: [{ value }] }] }` (or `total_value`). */
export function parseInstagramInsights(body: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of (body as { data?: { name?: string; values?: { value?: unknown }[]; total_value?: { value?: unknown } }[] }).data ?? []) {
    const n = num(m.values?.[0]?.value ?? m.total_value?.value);
    if (m.name && n !== null) out[m.name] = n;
  }
  return out;
}

export function instagramStat(account: string, m: IgMedia, insights: Record<string, number>): PostStat {
  const kind = m.media_product_type === 'REELS' ? 'reel' : m.media_product_type === 'STORY' ? 'story' : m.media_type === 'VIDEO' ? 'video' : 'post';
  return {
    platform: 'instagram',
    account,
    externalId: m.id,
    url: m.permalink ?? null,
    postedAt: m.timestamp ?? null,
    kind,
    views: insights.views ?? null,
    likes: num(m.like_count) ?? insights.likes ?? null,
    comments: num(m.comments_count) ?? insights.comments ?? null,
    shares: insights.shares ?? null,
    saves: insights.saved ?? insights.saves ?? null,
    reach: insights.reach ?? null,
    source: 'instagram-api',
    raw: { insights },
  };
}

const igUrl = (path: string, token: string, params: Record<string, string> = {}) =>
  `${IG}/${IG_VERSION}/${path}?${new URLSearchParams({ ...params, access_token: token })}`;

export async function instagramFollowers(get: HttpGet, token: string): Promise<{ username: string | null; followers: number }> {
  return parseInstagramProfile(json(await get(igUrl('me', token, { fields: 'username,followers_count,media_count' })), 'Instagram profile'));
}

/** Insights ask for different metrics per media type; ask for the common set and fall back to none on a refusal. */
async function mediaInsights(get: HttpGet, token: string, id: string): Promise<Record<string, number>> {
  const r = await get(igUrl(`${id}/insights`, token, { metric: 'views,reach,saved,shares' }));
  if (r.status !== 200) return {};
  try { return parseInstagramInsights(JSON.parse(r.body)); } catch { return {}; }
}

export function instagramSource(get: HttpGet, token: () => Promise<string>): PostSource {
  return {
    name: 'instagram',
    run: async () => {
      const t = await token();
      const { username } = await instagramFollowers(get, t);
      const account = username ?? 'me';
      const media = json<{ data?: IgMedia[] }>(
        await get(igUrl('me/media', t, { fields: 'id,media_type,media_product_type,permalink,timestamp,like_count,comments_count', limit: '50' })),
        'Instagram media',
      ).data ?? [];
      const out: PostStat[] = [];
      for (const m of media) out.push(instagramStat(account, m, await mediaInsights(get, t, m.id)));
      return out;
    },
  };
}

/**
 * The stored Instagram token (refreshed copy first, env as the seed). A token
 * with under 15 days left is swapped for a fresh 60-day one and saved
 * encrypted; a failed refresh keeps the old token and is reported.
 */
export async function instagramToken(
  get: HttpGet,
  seed: string | undefined,
  now = new Date(),
  key: string | undefined = config.socialTokenEncKey,
): Promise<string> {
  const row = (await query<{ token: string; expires_at: Date }>(`SELECT token, expires_at FROM metrics_tokens WHERE name = 'instagram'`)).rows[0];
  let token = seed;
  let expires: Date | null = null;
  if (row) {
    token = decryptToken(row.token, key);
    expires = new Date(row.expires_at);
  }
  if (!token) throw new Error('INSTAGRAM_ACCESS_TOKEN is not set');
  const daysLeft = expires ? (expires.getTime() - now.getTime()) / 86_400_000 : 0;
  if (!expires || daysLeft < IG_REFRESH_BELOW_DAYS) {
    const r = json<{ access_token?: string; expires_in?: number }>(
      await get(`${IG}/refresh_access_token?${new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: token })}`),
      'Instagram token refresh',
    );
    if (!r.access_token || !r.expires_in) throw new Error('Instagram token refresh: no token in the response');
    token = r.access_token;
    await query(
      `INSERT INTO metrics_tokens (name, token, expires_at) VALUES ('instagram', $1, $2)
       ON CONFLICT (name) DO UPDATE SET token = EXCLUDED.token, expires_at = EXCLUDED.expires_at, updated_at = now()`,
      [encryptToken(token, key), new Date(now.getTime() + r.expires_in * 1000)],
    );
  }
  return token;
}

// ------------------------------------------------------------------------ X

export function parseFxStatus(body: unknown, handle: string, id: string): PostStat {
  const t = (body as { tweet?: { id?: string; url?: string; created_at?: string; views?: number | null; likes?: number; replies?: number; retweets?: number; quotes?: number; bookmarks?: number } }).tweet;
  if (!t) throw new Error(`fxtwitter: no tweet ${id}`);
  const shares = num(t.retweets) === null && num(t.quotes) === null ? null : (num(t.retweets) ?? 0) + (num(t.quotes) ?? 0);
  return {
    platform: 'x', account: handle, externalId: t.id ?? id, url: t.url ?? `https://x.com/${handle}/status/${id}`,
    postedAt: t.created_at && !Number.isNaN(Date.parse(t.created_at)) ? new Date(t.created_at).toISOString() : null,
    kind: 'post', views: num(t.views), likes: num(t.likes), comments: num(t.replies), shares, saves: num(t.bookmarks), reach: null,
    source: 'fxtwitter',
  };
}

/** Our X posts of the last 30 days: the status id is in the URL Buffer reported. */
export async function ourXPosts(handles: string[], now = new Date()): Promise<{ handle: string; id: string }[]> {
  const { rows } = await query<{ remote_url: string }>(
    `SELECT p.remote_url FROM social_posts p JOIN social_accounts a ON a.id = p.account_id
      WHERE a.provider = 'x' AND p.status = 'posted' AND p.remote_url IS NOT NULL AND p.posted_at > $1::timestamptz - interval '30 days'`,
    [now.toISOString()],
  );
  const wanted = new Set(handles.map((h) => h.toLowerCase()));
  const out: { handle: string; id: string }[] = [];
  for (const r of rows) {
    const m = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([^/]+)\/status\/(\d+)/.exec(r.remote_url);
    if (m && wanted.has(m[1]!.toLowerCase())) out.push({ handle: m[1]!, id: m[2]! });
  }
  return out;
}

export function xSource(get: HttpGet, handles: string[], now = new Date()): PostSource {
  return {
    name: 'x',
    run: async () => {
      const out: PostStat[] = [];
      for (const p of await ourXPosts(handles, now)) {
        out.push(parseFxStatus(json(await get(`https://api.fxtwitter.com/${p.handle}/status/${p.id}`), `fxtwitter ${p.id}`), p.handle, p.id));
      }
      return out;
    },
  };
}

// ------------------------------------------------------------------- write

export async function upsertPostStats(stats: PostStat[], now = new Date()): Promise<number> {
  for (const s of stats) {
    await query(
      `INSERT INTO social_post_stats
         (platform, account, external_id, day, url, posted_at, kind, views, likes, comments, shares, saves, reach, source, raw, sampled_at, social_post_id)
       VALUES ($1,$2,$3,($15::timestamptz AT TIME ZONE 'UTC')::date,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::timestamptz,
               (SELECT id FROM social_posts WHERE remote_url = $4 ORDER BY id LIMIT 1))
       ON CONFLICT (platform, external_id, day) DO UPDATE SET
         account = EXCLUDED.account,
         url = COALESCE(EXCLUDED.url, social_post_stats.url),
         posted_at = COALESCE(EXCLUDED.posted_at, social_post_stats.posted_at),
         kind = COALESCE(EXCLUDED.kind, social_post_stats.kind),
         views = COALESCE(EXCLUDED.views, social_post_stats.views),
         likes = COALESCE(EXCLUDED.likes, social_post_stats.likes),
         comments = COALESCE(EXCLUDED.comments, social_post_stats.comments),
         shares = COALESCE(EXCLUDED.shares, social_post_stats.shares),
         saves = COALESCE(EXCLUDED.saves, social_post_stats.saves),
         reach = COALESCE(EXCLUDED.reach, social_post_stats.reach),
         source = EXCLUDED.source,
         raw = COALESCE(EXCLUDED.raw, social_post_stats.raw),
         sampled_at = EXCLUDED.sampled_at,
         social_post_id = COALESCE(EXCLUDED.social_post_id, social_post_stats.social_post_id)`,
      [s.platform, s.account, s.externalId, s.url, s.postedAt, s.kind, s.views, s.likes, s.comments, s.shares, s.saves, s.reach, s.source,
        s.raw === undefined ? null : JSON.stringify(s.raw), now.toISOString()],
    );
  }
  return stats.length;
}

// -------------------------------------------------------------------- run

/** The sources this install has keys and accounts for, and a reason for each one it skips. */
export function postSources(
  get: HttpGet = curlGet,
  cfg: SecondBrainSettings['postStats'] = settings().postStats,
  env: { youtubeApiKey?: string; instagramAccessToken?: string } = config,
): { sources: PostSource[]; skipped: { source: string; skipped: string }[] } {
  const sources: PostSource[] = [];
  const skipped: { source: string; skipped: string }[] = [];
  if (!cfg.youtube.channelIds.length && !cfg.youtube.handles.length) skipped.push({ source: 'youtube', skipped: 'no postStats.youtube channels in secondbrain.json' });
  else if (!env.youtubeApiKey) skipped.push({ source: 'youtube', skipped: 'YOUTUBE_API_KEY is not set' });
  else sources.push(youtubeSource(get, env.youtubeApiKey, cfg.youtube));
  if (!cfg.instagram) skipped.push({ source: 'instagram', skipped: 'postStats.instagram is off in secondbrain.json' });
  else if (!env.instagramAccessToken) skipped.push({ source: 'instagram', skipped: 'INSTAGRAM_ACCESS_TOKEN is not set' });
  else sources.push(instagramSource(get, () => instagramToken(get, env.instagramAccessToken)));
  if (!cfg.x.handles.length) skipped.push({ source: 'x', skipped: 'no postStats.x handles in secondbrain.json' });
  else sources.push(xSource(get, cfg.x.handles));
  return { sources, skipped };
}

/** Removes secrets from an error before it is printed (curl's message carries the whole URL). */
export function scrub(message: string, secrets: (string | undefined)[]): string {
  let out = message;
  for (const s of secrets) if (s) out = out.split(s).join('***');
  return out.replace(/access_token=[^&\s]+/g, 'access_token=***');
}

export async function collectPostStats(
  sources: PostSource[],
  opts: { write?: boolean; now?: Date; secrets?: (string | undefined)[] } = {},
): Promise<PostResult[]> {
  const out: PostResult[] = [];
  for (const s of sources) {
    try {
      const stats = await s.run();
      if (opts.write !== false) await upsertPostStats(stats, opts.now);
      out.push({ source: s.name, rows: stats.length });
    } catch (err) {
      out.push({ source: s.name, error: scrub((err as Error).message, opts.secrets ?? [config.youtubeApiKey, config.instagramAccessToken]) });
    }
  }
  return out;
}
