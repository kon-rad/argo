import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db.js';
import type { HttpGet } from '../src/metrics/collect.js';
import {
  collectPostStats,
  instagramSource,
  instagramToken,
  parseFxStatus,
  parseInstagramInsights,
  parseInstagramProfile,
  parseYouTubeVideos,
  postSources,
  scrub,
  upsertPostStats,
  xSource,
  youtubeSource,
  youtubeSubscribers,
  type PostStat,
} from '../src/metrics/posts.js';
import { parseSettings } from '../src/settings.js';
import { truncateAll } from './helpers.js';

// Fixture feeds shaped like the documented API responses. No network.
type Route = (url: URL) => { status?: number; body: unknown } | undefined;
const fakeGet = (...routes: Route[]): HttpGet & { urls: string[]; headers: Record<string, string>[] } => {
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  const fn = (async (url: string, h?: Record<string, string>) => {
    urls.push(url);
    headers.push(h ?? {});
    for (const r of routes) {
      const hit = r(new URL(url));
      if (hit) return { status: hit.status ?? 200, body: JSON.stringify(hit.body) };
    }
    return { status: 404, body: JSON.stringify({ error: { message: `no fixture for ${url}` } }) };
  }) as HttpGet & { urls: string[]; headers: Record<string, string>[] };
  fn.urls = urls;
  fn.headers = headers;
  return fn;
};

const NOW = new Date('2026-10-21T06:00:00Z');

const ytRoute: Route = (u) => {
  if (u.pathname.endsWith('/channels')) {
    return { body: { items: [{ id: 'UC1', statistics: { subscriberCount: '36' }, contentDetails: { relatedPlaylists: { uploads: 'UU1' } } }] } };
  }
  if (u.pathname.endsWith('/playlistItems')) {
    return u.searchParams.get('pageToken')
      ? { body: { items: [{ contentDetails: { videoId: 'v3' } }] } }
      : { body: { items: [{ contentDetails: { videoId: 'v1' } }, { contentDetails: { videoId: 'v2' } }], nextPageToken: 'p2' } };
  }
  if (u.pathname.endsWith('/videos')) {
    return {
      body: {
        items: [
          { id: 'v1', snippet: { publishedAt: '2026-10-19T10:00:00Z', channelId: 'UC1' }, statistics: { viewCount: '120', likeCount: '9', commentCount: '2' } },
          { id: 'v2', snippet: { publishedAt: '2026-10-01T10:00:00Z', channelId: 'UC1' }, statistics: { viewCount: '0' } },
          { id: 'v3', snippet: { publishedAt: '2026-09-01T10:00:00Z', channelId: 'UC1' }, statistics: { viewCount: '5', likeCount: '0', commentCount: '0' } },
        ],
      },
    };
  }
  return undefined;
};

describe('parsers', () => {
  it('reads YouTube videos; a hidden like count is null, a zero stays 0', () => {
    const [a, b] = parseYouTubeVideos(ytRoute(new URL('https://x/videos'))!.body, 'UC1');
    expect(a).toMatchObject({ platform: 'youtube', externalId: 'v1', views: 120, likes: 9, comments: 2, url: 'https://www.youtube.com/watch?v=v1' });
    expect(b).toMatchObject({ views: 0, likes: null, comments: null });
  });

  it('refuses a hidden or missing subscriber count rather than storing 0', () => {
    expect(youtubeSubscribers({ id: 'a', statistics: { subscriberCount: '4' } })).toBe(4);
    expect(() => youtubeSubscribers({ id: 'a', statistics: { hiddenSubscriberCount: true } })).toThrow(/hides/);
    expect(() => youtubeSubscribers({ id: 'a' })).toThrow(/no subscriberCount/);
  });

  it('reads Instagram profile and insights (values[] or total_value)', () => {
    expect(parseInstagramProfile({ username: 'myargoquestcommunity', followers_count: 41 })).toEqual({ username: 'myargoquestcommunity', followers: 41 });
    expect(() => parseInstagramProfile({ error: 'x' })).toThrow(/followers_count/);
    expect(parseInstagramInsights({ data: [{ name: 'views', values: [{ value: 7 }] }, { name: 'saved', total_value: { value: 2 } }, { name: 'reach' }] })).toEqual({ views: 7, saved: 2 });
  });

  it('reads an fxtwitter status: reposts + quotes are shares, missing views stay null', () => {
    const s = parseFxStatus({ tweet: { id: '9', url: 'https://x.com/a/status/9', created_at: 'Tue Oct 20 23:55:00 +0000 2026', views: 33, likes: 4, replies: 1, retweets: 2, quotes: 1 } }, 'a', '9');
    expect(s).toMatchObject({ platform: 'x', externalId: '9', views: 33, likes: 4, comments: 1, shares: 3, postedAt: '2026-10-20T23:55:00.000Z' });
    expect(parseFxStatus({ tweet: { id: '9', likes: 1 } }, 'a', '9')).toMatchObject({ views: null, shares: null });
    expect(() => parseFxStatus({ code: 404 }, 'a', '9')).toThrow(/no tweet/);
  });

  it('scrubs keys and tokens out of error text', () => {
    expect(scrub('curl: failed https://x/?access_token=SECRET1&a=1 key=KEY2', ['KEY2'])).toBe('curl: failed https://x/?access_token=***&a=1 key=***');
  });
});

describe('sources with fixture feeds', () => {
  it('YouTube: walks the uploads pages and batches the video lookups, key in a header not the URL', async () => {
    const get = fakeGet(ytRoute);
    const stats = await youtubeSource(get, 'KEY', { channelIds: ['UC1'], handles: [] }).run();
    expect(stats.map((s) => s.externalId)).toEqual(['v1', 'v2', 'v3']);
    expect(get.urls.some((u) => u.includes('KEY'))).toBe(false);
    expect(get.headers.every((h) => h['x-goog-api-key'] === 'KEY')).toBe(true);
  });

  it('Instagram: followers + media + insights per post; a refused insights call leaves nulls', async () => {
    const get = fakeGet(
      (u) => (u.pathname.endsWith('/me/media') ? { body: { data: [
        { id: 'm1', media_product_type: 'REELS', permalink: 'https://instagram.com/reel/a', timestamp: '2026-10-20T10:00:00+0000', like_count: 3, comments_count: 1 },
        { id: 'm2', media_type: 'IMAGE', permalink: 'https://instagram.com/p/b', like_count: 0, comments_count: 0 },
      ] } } : undefined),
      (u) => (u.pathname.endsWith('/me') ? { body: { username: 'myargoquestcommunity', followers_count: 41 } } : undefined),
      (u) => (u.pathname.endsWith('/m1/insights') ? { body: { data: [{ name: 'views', values: [{ value: 90 }] }, { name: 'saved', values: [{ value: 2 }] }, { name: 'shares', values: [{ value: 1 }] }, { name: 'reach', values: [{ value: 70 }] }] } } : undefined),
      (u) => (u.pathname.endsWith('/m2/insights') ? { status: 400, body: { error: { message: 'unsupported' } } } : undefined),
    );
    const stats = await instagramSource(get, async () => 'TOK').run();
    expect(stats[0]).toMatchObject({ account: 'myargoquestcommunity', kind: 'reel', views: 90, likes: 3, comments: 1, saves: 2, shares: 1, reach: 70 });
    expect(stats[1]).toMatchObject({ kind: 'post', views: null, likes: 0, saves: null });
  });

  it('skips networks without a key or account, and says why', () => {
    const cfg = parseSettings({ postStats: { youtube: { channelIds: ['UC1'] }, instagram: true } }).postStats;
    const { sources, skipped } = postSources(fakeGet(), cfg, {});
    expect(sources).toEqual([]);
    expect(skipped.map((s) => `${s.source}: ${s.skipped}`)).toEqual([
      'youtube: YOUTUBE_API_KEY is not set',
      'instagram: INSTAGRAM_ACCESS_TOKEN is not set',
      'x: no postStats.x handles in secondbrain.json',
    ]);
    expect(postSources(fakeGet(), cfg, { youtubeApiKey: 'k', instagramAccessToken: 't' }).sources.map((s) => s.name)).toEqual(['youtube', 'instagram']);
    expect(postSources(fakeGet(), parseSettings({}).postStats, {}).sources).toEqual([]);
  });
});

describe('storage', () => {
  beforeEach(truncateAll);

  const stat = (over: Partial<PostStat> = {}): PostStat => ({
    platform: 'youtube', account: 'UC1', externalId: 'v1', url: 'https://www.youtube.com/watch?v=v1', postedAt: '2026-10-19T10:00:00Z', kind: null,
    views: 120, likes: 9, comments: 2, shares: null, saves: null, reach: null, source: 'youtube-data-api', ...over,
  });

  it('keeps one row per post per UTC day and never overwrites a known number with null', async () => {
    await upsertPostStats([stat()], NOW);
    await upsertPostStats([stat({ views: 150, likes: null })], new Date('2026-10-21T18:00:00Z'));
    await upsertPostStats([stat({ views: 200 })], new Date('2026-10-22T01:00:00Z'));
    const { rows } = await query(`SELECT day::text, views::int, likes::int FROM social_post_stats ORDER BY day`);
    expect(rows).toEqual([{ day: '2026-10-21', views: 150, likes: 9 }, { day: '2026-10-22', views: 200, likes: 9 }]);
  });

  it('links a stat to the social post we published at that URL', async () => {
    const acc = await query<{ id: string }>(
      `INSERT INTO social_accounts (provider, provider_account_id, display_name, access_token, access_token_expires_at, transport)
       VALUES ('x', 'buf1', 'Argo', 'placeholder', now() + interval '1 day', 'buffer') RETURNING id`,
    );
    const post = await query<{ id: string }>(
      `INSERT INTO social_posts (account_id, body, status, scheduled_for, posted_at, remote_id, remote_url)
       VALUES ($1, 'hi', 'posted', now(), $2, 'b1', 'https://x.com/myargoquest/status/9') RETURNING id`,
      [acc.rows[0]!.id, NOW.toISOString()],
    );
    await upsertPostStats([stat({ platform: 'x', account: 'myargoquest', externalId: '9', url: 'https://x.com/myargoquest/status/9', source: 'fxtwitter' }), stat()], NOW);
    const { rows } = await query(`SELECT external_id, social_post_id::text FROM social_post_stats ORDER BY external_id`);
    expect(rows).toEqual([{ external_id: '9', social_post_id: post.rows[0]!.id }, { external_id: 'v1', social_post_id: null }]);
  });

  it('X: reads the posts we published in the last 30 days for the configured handles only', async () => {
    const acc = await query<{ id: string }>(
      `INSERT INTO social_accounts (provider, provider_account_id, display_name, access_token, access_token_expires_at, transport)
       VALUES ('x', 'buf1', 'Argo', 'placeholder', now() + interval '1 day', 'buffer') RETURNING id`,
    );
    for (const [url, at] of [
      ['https://x.com/myargoquest/status/11', '2026-10-20T00:00:00Z'],
      ['https://x.com/someoneelse/status/12', '2026-10-20T00:00:00Z'],
      ['https://x.com/myargoquest/status/13', '2026-08-01T00:00:00Z'],
    ] as const) {
      await query(
        `INSERT INTO social_posts (account_id, body, status, scheduled_for, posted_at, remote_url) VALUES ($1,'b','posted',now(),$2,$3)`,
        [acc.rows[0]!.id, at, url],
      );
    }
    const get = fakeGet((u) => ({ body: { tweet: { id: u.pathname.split('/').pop(), views: 5, likes: 1 } } }));
    const stats = await xSource(get, ['MyArgoQuest'], NOW).run();
    expect(stats.map((s) => s.externalId)).toEqual(['11']);
  });

  it('collects, writes, and reports a failing source without losing the others', async () => {
    const results = await collectPostStats(
      [youtubeSource(fakeGet(ytRoute), 'KEY', { channelIds: ['UC1'], handles: [] }), { name: 'instagram', run: async () => { throw new Error('boom TOKEN9'); } }],
      { now: NOW, secrets: ['TOKEN9'] },
    );
    expect(results).toEqual([{ source: 'youtube', rows: 3 }, { source: 'instagram', error: 'boom ***' }]);
    expect((await query(`SELECT count(*)::int AS n FROM social_post_stats`)).rows[0]!.n).toBe(3);
    await collectPostStats([youtubeSource(fakeGet(ytRoute), 'KEY', { channelIds: ['UC1'], handles: [] })], { write: false, now: new Date('2026-10-23T00:00:00Z') });
    expect((await query(`SELECT count(*)::int AS n FROM social_post_stats`)).rows[0]!.n).toBe(3);
  });
});

describe('Instagram token', () => {
  beforeEach(truncateAll);
  const KEY = 'ab'.repeat(32);
  const refresh = (token: string, days = 60): Route => (u) =>
    u.pathname === '/refresh_access_token' ? { body: { access_token: token, token_type: 'bearer', expires_in: days * 86400 } } : undefined;

  it('refreshes the seed on first use, stores it encrypted, and reuses it until 15 days remain', async () => {
    const get = fakeGet(refresh('LONG1'));
    expect(await instagramToken(get, 'SEED', NOW, KEY)).toBe('LONG1');
    const stored = (await query<{ token: string }>(`SELECT token FROM metrics_tokens`)).rows[0]!.token;
    expect(stored).not.toContain('LONG1');
    expect(get.urls).toHaveLength(1);

    expect(await instagramToken(get, 'SEED', new Date(NOW.getTime() + 10 * 86_400_000), KEY)).toBe('LONG1');
    expect(get.urls).toHaveLength(1);

    const later = fakeGet(refresh('LONG2'));
    expect(await instagramToken(later, 'SEED', new Date(NOW.getTime() + 50 * 86_400_000), KEY)).toBe('LONG2');
    expect(later.urls[0]).toContain('access_token=LONG1');
  });

  it('keeps the old token and fails loudly when a refresh is refused; needs a seed', async () => {
    await expect(instagramToken(fakeGet(), undefined, NOW, KEY)).rejects.toThrow(/not set/);
    await expect(instagramToken(fakeGet(() => ({ status: 400, body: { error: { message: 'expired' } } })), 'SEED', NOW, KEY)).rejects.toThrow(/refresh/);
    expect((await query(`SELECT count(*)::int AS n FROM metrics_tokens`)).rows[0]!.n).toBe(0);
  });
});
