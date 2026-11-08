import type { SocialMetricsSettings } from '../../settings.js';
import type { SocialAccount } from './accounts.js';
import { chunks, count, getJson, redact } from './http.js';
import { emptyResult, type PostStat, type SocialDeps, type SocialResult } from './types.js';

/**
 * YouTube Data API v3 with an API key (public data, any channel). Quota: each
 * call below costs 1 unit of the free 10,000 a day; channels and videos are
 * read 50 ids per call. Subscriber counts above 1,000 are rounded by YouTube.
 * The key travels in the `x-goog-api-key` header, never in a URL.
 */

const API = 'https://www.googleapis.com/youtube/v3';
export const YOUTUBE_SOURCE = 'youtube-data-api';

type YouTubeAccount = Extract<SocialAccount, { platform: 'youtube' }>;

interface Channel {
  id: string;
  statistics?: { subscriberCount?: string; viewCount?: string; videoCount?: string; hiddenSubscriberCount?: boolean };
  contentDetails?: { relatedPlaylists?: { uploads?: string } };
}
interface PlaylistPage { nextPageToken?: string; items?: { contentDetails?: { videoId?: string; videoPublishedAt?: string } }[] }
interface Video { id: string; snippet?: { publishedAt?: string; title?: string }; statistics?: { viewCount?: string; likeCount?: string; commentCount?: string } }

export const MISSING_YOUTUBE_KEY =
  'YOUTUBE_API_KEY is not set: create a key for "YouTube Data API v3" in a Google Cloud project, put it in the server env file, and run `secondbrain metrics collect` (docs/social-metrics.md)';

export async function collectYouTube(accounts: YouTubeAccount[], s: SocialMetricsSettings, deps: SocialDeps): Promise<SocialResult[]> {
  const results = accounts.map((a) => emptyResult(a));
  if (!accounts.length) return results;
  const key = deps.youtubeApiKey;
  if (!key) {
    for (const r of results) r.error = MISSING_YOUTUBE_KEY;
    return results;
  }
  const secrets = [key];
  const headers = { 'x-goog-api-key': key };
  const call = <T>(path: string, what: string) => getJson<T>(deps.get, `${API}/${path}`, what, secrets, headers);

  // One channels.list call for up to 50 channels: a failure here fails every YouTube account, and only those.
  const channels = new Map<string, Channel>();
  try {
    for (const ids of chunks([...new Set(accounts.map((a) => a.cfg.channelId))], 50)) {
      const j = await call<{ items?: Channel[] }>(`channels?part=statistics,contentDetails&maxResults=50&id=${ids.join(',')}`, 'YouTube channels.list');
      for (const c of j.items ?? []) channels.set(c.id, c);
    }
  } catch (err) {
    for (const r of results) r.error = (err as Error).message;
    return results;
  }

  const cutoff = deps.now.getTime() - s.postDays * 86_400_000;
  for (const [i, a] of accounts.entries()) {
    const r = results[i]!;
    try {
      const ch = channels.get(a.cfg.channelId);
      if (!ch) throw new Error(`YouTube channel ${a.cfg.channelId} not found (check channelId in socialMetrics.youtube)`);
      const st = ch.statistics ?? {};
      const subs = st.hiddenSubscriberCount ? null : count(st.subscriberCount);
      if (subs === null) r.warnings.push('subscriber count is hidden on this channel');
      else r.samples.push({ metric: `${a.key}.subscribers`, unit: 'subscribers', value: subs, source: YOUTUBE_SOURCE });
      const views = count(st.viewCount);
      if (views !== null) r.samples.push({ metric: `${a.key}.views`, unit: 'count', value: views, source: YOUTUBE_SOURCE });
      const videos = count(st.videoCount);
      if (videos !== null) r.samples.push({ metric: `${a.key}.videos`, unit: 'count', value: videos, source: YOUTUBE_SOURCE });
      if (!a.cfg.posts) continue;

      const uploads = ch.contentDetails?.relatedPlaylists?.uploads;
      if (!uploads) throw new Error('YouTube: the channel has no uploads playlist');
      // Uploads come newest first: page until a video is older than postDays or maxPosts is reached.
      const ids: string[] = [];
      let page: string | undefined;
      paging: do {
        const j = await call<PlaylistPage>(
          `playlistItems?part=contentDetails&maxResults=50&playlistId=${uploads}${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`,
          'YouTube playlistItems.list');
        for (const it of j.items ?? []) {
          const id = it.contentDetails?.videoId;
          const at = it.contentDetails?.videoPublishedAt; // absent on private videos
          if (!id || !at) continue;
          if (Date.parse(at) <= cutoff || ids.length >= s.maxPosts) break paging;
          ids.push(id);
        }
        page = j.nextPageToken;
      } while (page);

      for (const batch of chunks(ids, 50)) {
        const j = await call<{ items?: Video[] }>(`videos?part=statistics,snippet&maxResults=50&id=${batch.join(',')}`, 'YouTube videos.list');
        for (const v of j.items ?? []) r.posts.push(videoStat(a, v));
      }
    } catch (err) {
      r.error = redact((err as Error).message, secrets);
    }
  }
  return results;
}

function videoStat(a: YouTubeAccount, v: Video): PostStat {
  const st = v.statistics ?? {};
  return {
    platform: 'youtube', account: a.account, externalId: v.id,
    url: `https://www.youtube.com/watch?v=${v.id}`,
    postedAt: v.snippet?.publishedAt ? new Date(v.snippet.publishedAt) : null,
    kind: 'video',
    // likeCount is absent when likes are hidden, commentCount when comments are off: null, not 0.
    views: count(st.viewCount), likes: count(st.likeCount), comments: count(st.commentCount),
    shares: null, saves: null, reach: null,
    source: YOUTUBE_SOURCE, raw: { title: v.snippet?.title ?? null, statistics: st },
  };
}
