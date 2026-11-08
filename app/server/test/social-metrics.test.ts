import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db.js';
import type { HttpGet } from '../src/metrics/collect.js';
import { socialAccounts, socialMetricKeys } from '../src/metrics/social/accounts.js';
import { collectSocial, type SocialDeps } from '../src/metrics/social/collect.js';
import { redact } from '../src/metrics/social/http.js';
import { seedInstagramToken } from '../src/metrics/social/instagram.js';
import { recordLinkedIn } from '../src/metrics/social/manual.js';
import { formatSocialReport, socialReport } from '../src/metrics/social/report.js';
import { loadToken, saveToken } from '../src/metrics/social/tokens.js';
import { snowflakeTime } from '../src/metrics/social/x.js';
import { parseSettings, type SocialMetricsSettings } from '../src/settings.js';
import { truncateAll } from './helpers.js';

// Fake accounts only: no real handle, channel or post id appears in this file.
const CH1 = 'UC' + 'a'.repeat(22);
const CH2 = 'UC' + 'b'.repeat(22);
const ENC = '0'.repeat(63) + '1';
const YT_KEY = 'yt-secret-key-123'; // gitleaks:allow (fake)
const IG_TOKEN = 'IGtokenSECRET0001'; // gitleaks:allow (fake)
const NOW = new Date('2026-11-08T01:00:00Z');

function cfg(raw: Record<string, unknown>): SocialMetricsSettings {
  return parseSettings({ socialMetrics: raw }).socialMetrics;
}

type Route = (url: string, headers: Record<string, string>) => { status: number; body: unknown } | undefined;
function fakeGet(routes: Route[]): HttpGet & { calls: { url: string; headers: Record<string, string> }[] } {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const get = (async (url: string, headers: Record<string, string> = {}) => {
    calls.push({ url, headers });
    for (const r of routes) {
      const hit = r(url, headers);
      if (hit) return { status: hit.status, body: typeof hit.body === 'string' ? hit.body : JSON.stringify(hit.body) };
    }
    return { status: 404, body: JSON.stringify({ error: { message: `no route for ${url}` } }) };
  }) as HttpGet & { calls: typeof calls };
  get.calls = calls;
  return get;
}

const json = (status: number, body: unknown) => ({ status, body });
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

/** A YouTube channel with `n` uploads, newest first, one a day. */
function youtubeRoutes(n: number, opts: { hiddenLikes?: boolean } = {}): Route[] {
  const ids = Array.from({ length: n }, (_, i) => `vid${String(i).padStart(8, '0')}`);
  return [
    (url) => {
      if (!url.startsWith('https://www.googleapis.com/youtube/v3/channels?')) return undefined;
      const q = new URL(url).searchParams.get('id')!.split(',');
      return json(200, {
        items: q.filter((id) => id === CH1).map((id) => ({
          id,
          statistics: { subscriberCount: '36', viewCount: '1200', videoCount: String(n), hiddenSubscriberCount: false },
          contentDetails: { relatedPlaylists: { uploads: 'UU' + 'a'.repeat(22) } },
        })),
      });
    },
    (url) => {
      if (!url.startsWith('https://www.googleapis.com/youtube/v3/playlistItems?')) return undefined;
      const token = new URL(url).searchParams.get('pageToken');
      const start = token ? Number(token) : 0;
      const page = ids.slice(start, start + 50);
      return json(200, {
        nextPageToken: start + 50 < n ? String(start + 50) : undefined,
        items: page.map((id) => ({ contentDetails: { videoId: id, videoPublishedAt: daysAgo(ids.indexOf(id)) } })),
      });
    },
    (url) => {
      if (!url.startsWith('https://www.googleapis.com/youtube/v3/videos?')) return undefined;
      const q = new URL(url).searchParams.get('id')!.split(',');
      return json(200, {
        items: q.map((id, i) => ({
          id,
          snippet: { publishedAt: daysAgo(ids.indexOf(id)), title: `t${i}` },
          statistics: { viewCount: String(100 + ids.indexOf(id)), commentCount: '0', ...(opts.hiddenLikes ? {} : { likeCount: '5' }) },
        })),
      });
    },
  ];
}

function deps(get: HttpGet, extra: Partial<SocialDeps> = {}): SocialDeps {
  return { get, publicGet: get, now: NOW, youtubeApiKey: YT_KEY, encKey: ENC, env: {}, vaultRoot: tmpdir(), ...extra };
}

describe('social metrics settings', () => {
  it('collects nothing by default', () => {
    const s = parseSettings({}).socialMetrics;
    expect(s.youtube).toEqual([]);
    expect(s.instagram).toEqual([]);
    expect(s.x).toEqual([]);
    expect(s.linkedin).toEqual([]);
    expect(socialAccounts(s)).toEqual([]);
  });

  it('derives metric keys from the handle, so a corrected handle never writes into the old key', () => {
    const s = cfg({
      youtube: [{ channelId: CH1, key: 'yt.one' }],
      instagram: [{ username: 'Example.Studio' }],
      x: [{ handle: 'Example_X' }],
      linkedin: [{ account: 'me' }],
    });
    const keys = socialAccounts(s).map((a) => a.followersMetric);
    expect(keys).toEqual(['yt.one.subscribers', 'ig.example.studio.followers', 'x.example_x.followers', 'li.me.followers']);
    expect([...socialMetricKeys(s)]).toContain('yt.one.views');
    expect(socialAccounts(s).find((a) => a.platform === 'linkedin')!.staleHours).toBe(192);
  });
});

describe('YouTube collector', () => {
  beforeEach(async () => { await truncateAll(); });

  it('reports a missing API key per account without throwing or touching other collectors', async () => {
    const get = fakeGet([(url) => (url.includes('fxtwitter.com/acct') ? json(200, { code: 200, user: { followers: 7 } }) : undefined)]);
    const s = cfg({ youtube: [{ channelId: CH1, key: 'yt.one' }], x: [{ handle: 'acct', posts: false }] });
    const res = await collectSocial(s, deps(get, { youtubeApiKey: undefined }));
    const yt = res.find((r) => r.platform === 'youtube')!;
    expect(yt.error).toMatch(/YOUTUBE_API_KEY is not set/);
    expect(yt.error).toMatch(/docs\/social-metrics\.md/);
    expect(res.find((r) => r.platform === 'x')!.error).toBeUndefined();
    expect(get.calls.some((c) => c.url.includes('googleapis'))).toBe(false);
    const { rows } = await query<{ metric: string }>(`SELECT metric FROM metric_samples`);
    expect(rows.map((r) => r.metric)).toEqual(['x.acct.followers']);
    const st = await query<{ collector: string; last_error: string | null; last_ok_at: Date | null }>(
      `SELECT collector, last_error, last_ok_at FROM social_metric_status ORDER BY collector`);
    expect(st.rows.map((r) => [r.collector, r.last_error !== null, r.last_ok_at !== null])).toEqual([
      ['x:x.acct', false, true], ['youtube:yt.one', true, false],
    ]);
  });

  it('paginates uploads, batches videos.list by 50, keeps the key in a header, and maps hidden counts to null', async () => {
    const get = fakeGet(youtubeRoutes(60, { hiddenLikes: true }));
    const s = cfg({ youtube: [{ channelId: CH1, key: 'yt.one' }] });
    const [r] = await collectSocial(s, deps(get));
    expect(r!.error).toBeUndefined();
    expect(r!.samples.map((x) => [x.metric, x.value])).toEqual([['yt.one.subscribers', 36], ['yt.one.views', 1200], ['yt.one.videos', 60]]);
    expect(r!.posts).toHaveLength(60);
    expect(get.calls.filter((c) => c.url.includes('/playlistItems?'))).toHaveLength(2);
    const videoCalls = get.calls.filter((c) => c.url.includes('/videos?'));
    expect(videoCalls.map((c) => new URL(c.url).searchParams.get('id')!.split(',').length)).toEqual([50, 10]);
    for (const c of get.calls) {
      expect(c.url).not.toContain(YT_KEY);
      expect(c.headers['x-goog-api-key']).toBe(YT_KEY);
    }
    const p = r!.posts.find((x) => x.externalId === 'vid00000003')!;
    expect(p).toMatchObject({ views: 103, likes: null, comments: 0, url: 'https://www.youtube.com/watch?v=vid00000003' });
  });

  it('stops paging at postDays', async () => {
    const get = fakeGet(youtubeRoutes(120));
    const s = cfg({ postDays: 10, youtube: [{ channelId: CH1, key: 'yt.one' }] });
    const [r] = await collectSocial(s, deps(get), false);
    expect(r!.posts).toHaveLength(10);
    expect(get.calls.filter((c) => c.url.includes('/playlistItems?'))).toHaveLength(1);
  });

  it('isolates a missing channel and redacts the key from API errors', async () => {
    const quota: Route = (url) => (url.includes('/playlistItems?')
      ? json(403, { error: { code: 403, message: `quota exceeded for key=${YT_KEY}`, errors: [{ reason: 'quotaExceeded' }] } })
      : undefined);
    const get = fakeGet([quota, ...youtubeRoutes(3)]);
    const s = cfg({ youtube: [{ channelId: CH1, key: 'yt.one' }, { channelId: CH2, key: 'yt.two' }] });
    const res = await collectSocial(s, deps(get));
    const one = res.find((r) => r.account === CH1)!;
    const two = res.find((r) => r.account === CH2)!;
    expect(two.error).toMatch(/not found/);
    expect(one.error).toMatch(/quotaExceeded/);
    expect(one.error).not.toContain(YT_KEY);
    // The channel numbers were read before the uploads failed, and are kept.
    expect(one.samples).toHaveLength(3);
    const { rows } = await query<{ last_error: string }>(`SELECT last_error FROM social_metric_status WHERE collector = 'youtube:yt.one'`);
    expect(rows[0]!.last_error).not.toContain(YT_KEY);
    const n = await query<{ n: number }>(`SELECT count(*)::int AS n FROM metric_samples WHERE metric LIKE 'yt.one.%'`);
    expect(n.rows[0]!.n).toBe(3);
  });
});

/** An Instagram account with three posts across two pages; the second post's insights fail. */
function instagramRoutes(opts: { username?: string; refreshed?: string } = {}): Route[] {
  const base = 'https://graph.instagram.com/v23.0';
  return [
    (url) => (url.startsWith('https://graph.instagram.com/refresh_access_token?')
      ? json(200, { access_token: opts.refreshed ?? 'IGtokenREFRESHED02', token_type: 'bearer', expires_in: 5_184_000 })
      : undefined),
    (url) => (url.startsWith(`${base}/me?`)
      ? json(200, { user_id: '17840000000000001', username: opts.username ?? 'example.studio', followers_count: 120, media_count: 3 })
      : undefined),
    (url) => {
      if (!url.startsWith(`${base}/me/media?`)) return undefined;
      const after = new URL(url).searchParams.get('after');
      const tok = new URL(url).searchParams.get('access_token');
      if (!after) {
        return json(200, {
          data: [
            { id: 'm1', media_type: 'VIDEO', media_product_type: 'REELS', permalink: 'https://www.instagram.com/reel/AAA111/', timestamp: daysAgo(1), like_count: 9, comments_count: 2 },
            { id: 'm2', media_type: 'IMAGE', media_product_type: 'FEED', permalink: 'https://www.instagram.com/p/BBB222/', timestamp: daysAgo(2), like_count: 4, comments_count: 0 },
          ],
          paging: { next: `${base}/me/media?after=c2&access_token=${tok}` },
        });
      }
      return json(200, { data: [{ id: 'm3', media_type: 'CAROUSEL_ALBUM', media_product_type: 'FEED', permalink: 'https://www.instagram.com/p/CCC333/', timestamp: daysAgo(3), like_count: 1, comments_count: 1 }] });
    },
    (url) => {
      const m = /\/v23\.0\/(m\d)\/insights\?/.exec(url);
      if (!m) return undefined;
      if (m[1] === 'm2') return json(400, { error: { message: `unsupported metric, token ${new URL(url).searchParams.get('access_token')}` } });
      return json(200, { data: [
        { name: 'views', values: [{ value: 300 }] },
        { name: 'reach', values: [{ value: 250 }] },
        { name: 'likes', values: [{ value: 9 }] },
        { name: 'comments', values: [{ value: 2 }] },
        { name: 'shares', total_value: { value: 0 } },
        { name: 'saved', values: [{ value: 3 }] },
      ] });
    },
  ];
}

describe('Instagram collector', () => {
  beforeEach(async () => { await truncateAll(); });
  const s = () => cfg({ instagram: [{ username: 'example.studio', tokenEnv: 'IG_TEST_TOKEN' }] });

  it('says how to supply a token when none is stored or in env', async () => {
    const get = fakeGet(instagramRoutes());
    const [r] = await collectSocial(s(), deps(get));
    expect(r!.error).toMatch(/no Instagram token for @example\.studio/);
    expect(r!.error).toMatch(/IG_TEST_TOKEN|metrics social token instagram example\.studio/);
    expect(get.calls).toHaveLength(0);
  });

  it('seeds the store from env, refreshes it encrypted, and keeps both tokens out of every error and log column', async () => {
    const get = fakeGet(instagramRoutes());
    const [r] = await collectSocial(s(), deps(get, { env: { IG_TEST_TOKEN: IG_TOKEN } }));
    expect(r!.samples.map((x) => [x.metric, x.value])).toEqual([['ig.example.studio.followers', 120], ['ig.example.studio.posts', 3]]);
    expect(r!.posts).toHaveLength(3);
    const m1 = r!.posts.find((p) => p.externalId === 'm1')!;
    expect(m1).toMatchObject({ views: 300, reach: 250, likes: 9, comments: 2, shares: 0, saves: 3, kind: 'reel' });
    // Insights failed for m2: likes and comments from the media fields, the rest null, not 0.
    const m2 = r!.posts.find((p) => p.externalId === 'm2')!;
    expect(m2).toMatchObject({ views: null, reach: null, shares: null, saves: null, likes: 4, comments: 0 });
    expect(r!.warnings.join(' ')).toMatch(/insights failed for 1 of 3/);
    expect(r!.warnings.join(' ')).not.toContain(IG_TOKEN);

    const { rows } = await query<{ access_token: string; expires_at: Date | null }>(`SELECT access_token, expires_at FROM social_metric_tokens`);
    expect(rows[0]!.access_token).not.toContain('IGtoken');
    expect(rows[0]!.expires_at).not.toBeNull();
    const stored = await loadToken('instagram', 'example.studio', ENC);
    expect(stored!.token).toBe('IGtokenREFRESHED02');
    const dump = JSON.stringify((await query(`SELECT * FROM social_post_stats`)).rows) + JSON.stringify((await query(`SELECT * FROM social_metric_status`)).rows);
    expect(dump).not.toContain(IG_TOKEN);
    expect(dump).not.toContain('IGtokenREFRESHED02');
  });

  it('records a failed refresh without the token and keeps collecting with the current one', async () => {
    await saveToken('instagram', 'example.studio', IG_TOKEN, ENC, { expiresAt: new Date(NOW.getTime() + 5 * 86_400_000), refreshedAt: new Date(daysAgo(30)) });
    const failRefresh: Route = (url) => (url.includes('refresh_access_token')
      ? json(400, { error: { message: `bad token ${IG_TOKEN}` } }) : undefined);
    const get = fakeGet([failRefresh, ...instagramRoutes()]);
    const [r] = await collectSocial(s(), deps(get));
    expect(r!.error).toBeUndefined();
    expect(r!.warnings.join(' ')).toMatch(/refresh failed/);
    expect(r!.warnings.join(' ')).not.toContain(IG_TOKEN);
    const { rows } = await query<{ last_error: string }>(`SELECT last_error FROM social_metric_tokens`);
    expect(rows[0]!.last_error).toMatch(/refresh failed/);
    expect(rows[0]!.last_error).not.toContain(IG_TOKEN);
  });

  it('refuses an expired token with recovery steps', async () => {
    await saveToken('instagram', 'example.studio', IG_TOKEN, ENC, { expiresAt: new Date(daysAgo(1)), refreshedAt: new Date(daysAgo(70)) });
    const get = fakeGet(instagramRoutes());
    const [r] = await collectSocial(s(), deps(get));
    expect(r!.error).toMatch(/expired/);
    expect(r!.error).toMatch(/metrics social token instagram example\.studio/);
  });

  it('writes nothing when the token belongs to a different account', async () => {
    const get = fakeGet(instagramRoutes({ username: 'other.account' }));
    const [r] = await collectSocial(s(), deps(get, { env: { IG_TEST_TOKEN: IG_TOKEN } }));
    expect(r!.error).toMatch(/belongs to @other\.account/);
    const { rows } = await query<{ n: number }>(`SELECT count(*)::int AS n FROM metric_samples`);
    expect(rows[0]!.n).toBe(0);
  });

  it('seeds a token by hand only for the configured account, and never echoes it', async () => {
    await expect(seedInstagramToken(s(), 'example.studio', IG_TOKEN, deps(fakeGet(instagramRoutes({ username: 'other.account' })))))
      .rejects.toThrow(/belongs to @other\.account/);
    expect(await loadToken('instagram', 'example.studio', ENC)).toBeNull();
    await expect(seedInstagramToken(s(), 'nobody', IG_TOKEN, deps(fakeGet(instagramRoutes())))).rejects.toThrow(/not in socialMetrics\.instagram/);
    const failing = fakeGet([(url) => json(401, { error: { message: `invalid ${url}` } })]);
    const err = await seedInstagramToken(s(), 'example.studio', IG_TOKEN, deps(failing)).catch((e: Error) => e);
    expect((err as Error).message).not.toContain(IG_TOKEN);
    const ok = await seedInstagramToken(s(), 'Example.Studio', IG_TOKEN, deps(fakeGet(instagramRoutes())));
    expect(ok).toEqual({ username: 'example.studio', followers: 120 });
    expect((await loadToken('instagram', 'example.studio', ENC))!.token).toBe(IG_TOKEN);
  });

  it('writes nothing on a dry run: no samples, no token seeded or refreshed', async () => {
    const get = fakeGet(instagramRoutes());
    const [r] = await collectSocial(s(), deps(get, { env: { IG_TEST_TOKEN: IG_TOKEN } }), false);
    expect(r!.samples).toHaveLength(2);
    expect(get.calls.some((c) => c.url.includes('refresh_access_token'))).toBe(false);
    for (const t of ['social_metric_tokens', 'metric_samples', 'social_post_stats', 'social_metric_status']) {
      const { rows } = await query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`);
      expect([t, rows[0]!.n]).toEqual([t, 0]);
    }
  });

  it('uses an env token as is, with a warning, when no encryption key is set', async () => {
    const get = fakeGet(instagramRoutes());
    const [r] = await collectSocial(s(), deps(get, { encKey: undefined, env: { IG_TEST_TOKEN: IG_TOKEN } }));
    expect(r!.error).toBeUndefined();
    expect(r!.warnings.join(' ')).toMatch(/SOCIAL_TOKEN_ENC_KEY is not set/);
    expect(get.calls.some((c) => c.url.includes('refresh_access_token'))).toBe(false);
  });
});

describe('redact', () => {
  it('strips secrets and token-shaped query parameters', () => {
    const out = redact(`GET https://x.test/a?access_token=abc123&key=k9 failed for abc123 and SECRET`, ['SECRET']);
    expect(out).not.toContain('abc123');
    expect(out).not.toContain('k9');
    expect(out).not.toContain('SECRET');
  });
});

describe('X collector', () => {
  beforeEach(async () => { await truncateAll(); });

  // Snowflake ids encode their time: (ms - 1288834974657) << 22.
  const idAt = (iso: string) => String((BigInt(new Date(iso).getTime() - 1288834974657) << 22n) + 5n);
  const recent = idAt(daysAgo(2));
  const listed = idAt(daysAgo(3));
  const old = idAt(daysAgo(200));
  const foreign = idAt(daysAgo(1));

  function xRoutes(): Route[] {
    return [
      (url) => (url === 'https://api.fxtwitter.com/acct' ? json(200, { code: 200, user: { followers: 43, screen_name: 'acct' } }) : undefined),
      (url) => {
        const m = /^https:\/\/api\.fxtwitter\.com\/status\/(\d+)$/.exec(url);
        if (!m) return undefined;
        const author = m[1] === foreign ? 'someoneelse' : 'acct';
        return json(200, { code: 200, tweet: {
          id: m[1], url: `https://x.com/${author}/status/${m[1]}`, created_timestamp: Math.floor(snowflakeTime(m[1]!)!.getTime() / 1000),
          views: m[1] === listed ? null : 33, likes: 4, replies: 1, retweets: 2, quotes: 1, bookmarks: 0, author: { screen_name: author },
        } });
      },
    ];
  }

  it('reads followers and only known post ids (published posts plus the ids file), never a timeline', async () => {
    const { rows: [acct] } = await query<{ id: number }>(
      `INSERT INTO social_accounts (provider, provider_account_id, display_name, access_token, access_token_expires_at, transport)
       VALUES ('x', 'buf-1', 'acct', 'x', now() + interval '1 year', 'buffer') RETURNING id`);
    const { rows: [post] } = await query<{ id: number }>(
      `INSERT INTO social_posts (account_id, body, status, scheduled_for, posted_at, remote_url)
       VALUES ($1, 'hello', 'posted', now(), now(), $2) RETURNING id`, [acct!.id, `https://x.com/acct/status/${recent}`]);
    const root = mkdtempSync(join(tmpdir(), 'sb-xposts-'));
    writeFileSync(join(root, 'x-posts.txt'), `# posts made outside the app\nhttps://x.com/acct/status/${listed}\n${old}\n${foreign}\nnot-an-id\n`);
    const get = fakeGet(xRoutes());
    const s = cfg({ x: [{ handle: 'acct', postIdsFile: 'x-posts.txt' }] });
    const [r] = await collectSocial(s, deps(get, { vaultRoot: root }));
    expect(r!.error).toBeUndefined();
    expect(r!.samples).toEqual([expect.objectContaining({ metric: 'x.acct.followers', value: 43, source: 'fxtwitter' })]);
    expect(r!.posts.map((p) => p.externalId).sort()).toEqual([listed, recent].sort());
    expect(get.calls.some((c) => c.url.includes(old))).toBe(false); // older than postDays, skipped by its id's time
    expect(r!.warnings.join(' ')).toMatch(/not-an-id/);
    expect(r!.warnings.join(' ')).toMatch(/someoneelse/);
    const { rows } = await query<{ external_id: string; views: string | null; comments: string; shares: string; social_post_id: string | null }>(
      `SELECT external_id, views::text, comments::text, shares::text, social_post_id::text FROM social_post_stats ORDER BY external_id`);
    const byId = new Map(rows.map((x) => [x.external_id, x]));
    expect(byId.get(recent)).toMatchObject({ views: '33', comments: '1', shares: '2', social_post_id: String(post!.id) });
    expect(byId.get(listed)).toMatchObject({ views: null, social_post_id: null });
  });
});

describe('post stats storage', () => {
  beforeEach(async () => { await truncateAll(); });

  it('upserts one row per post per day, keeping a good reading when a later run on the same day gets null', async () => {
    const s = cfg({ youtube: [{ channelId: CH1, key: 'yt.one' }] });
    await collectSocial(s, deps(fakeGet(youtubeRoutes(2))));
    await collectSocial(s, deps(fakeGet(youtubeRoutes(2, { hiddenLikes: true }))));
    const { rows } = await query<{ n: number; likes: string | null }>(
      `SELECT count(*)::int AS n, max(likes)::text AS likes FROM social_post_stats WHERE external_id = 'vid00000000'`);
    expect(rows[0]).toEqual({ n: 1, likes: '5' });
    // The next day is a new row.
    await collectSocial(s, deps(fakeGet(youtubeRoutes(2)), { now: new Date(NOW.getTime() + 86_400_000) }));
    const { rows: days } = await query<{ day: string }>(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day FROM social_post_stats WHERE external_id = 'vid00000000' ORDER BY day`);
    expect(days.map((d) => d.day)).toEqual(['2026-11-08', '2026-11-09']);
  });

  it('matches a YouTube Short published by the social module through its URL', async () => {
    const { rows: [acct] } = await query<{ id: number }>(
      `INSERT INTO social_accounts (provider, provider_account_id, display_name, access_token, access_token_expires_at, transport)
       VALUES ('youtube', 'buf-2', 'chan', 'x', now() + interval '1 year', 'buffer') RETURNING id`);
    const { rows: [post] } = await query<{ id: number }>(
      `INSERT INTO social_posts (account_id, body, status, scheduled_for, posted_at, remote_url)
       VALUES ($1, 'short', 'posted', now(), now(), 'https://youtube.com/shorts/vid00000001') RETURNING id`, [acct!.id]);
    await collectSocial(cfg({ youtube: [{ channelId: CH1, key: 'yt.one' }] }), deps(fakeGet(youtubeRoutes(2))));
    const { rows } = await query<{ social_post_id: string }>(`SELECT social_post_id::text FROM social_post_stats WHERE external_id = 'vid00000001'`);
    expect(rows[0]!.social_post_id).toBe(String(post!.id));
  });
});

describe('LinkedIn manual entries', () => {
  beforeEach(async () => { await truncateAll(); });
  const s = cfg({ linkedin: [{ account: 'me' }] });

  it('records followers and a post by hand, and rejects an unconfigured account', async () => {
    await recordLinkedIn(s, 'me', { followers: 512, date: '2026-11-07' });
    await recordLinkedIn(s, 'me', { post: { url: 'https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000001/', views: 900, likes: 12 }, date: '2026-11-07' });
    const m = await query<{ metric: string; value: string; source: string; at: string }>(
      `SELECT metric, value::text, source, to_char(sampled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS at FROM metric_samples`);
    expect(m.rows).toEqual([{ metric: 'li.me.followers', value: '512', source: 'manual', at: '2026-11-07' }]);
    const p = await query<{ external_id: string; views: string; comments: string | null; source: string }>(
      `SELECT external_id, views::text, comments::text, source FROM social_post_stats`);
    expect(p.rows).toEqual([{ external_id: '7000000000000000001', views: '900', comments: null, source: 'manual' }]);
    await expect(recordLinkedIn(s, 'someone', { followers: 1 })).rejects.toThrow(/not in socialMetrics\.linkedin/);
  });
});

describe('social report', () => {
  beforeEach(async () => { await truncateAll(); });

  const s = cfg({
    youtube: [{ channelId: CH1, key: 'yt.one', label: 'Channel one' }],
    x: [{ handle: 'acct' }],
    instagram: [{ username: 'example.studio' }],
  });
  const sample = (metric: string, value: number, at: string) =>
    query(`INSERT INTO metric_samples (metric, source, value, unit, sampled_at) VALUES ($1, 't', $2, 'followers', $3)`, [metric, value, at]);
  const stat = (id: string, day: string, views: number | null, postedAt: string, sampledAt = `${day}T00:30:00Z`) =>
    query(`INSERT INTO social_post_stats (platform, account, external_id, day, posted_at, views, likes, source, sampled_at)
           VALUES ('youtube', $1, $2, $3, $4, $5, 1, 't', $6)`, [CH1, id, day, postedAt, views, sampledAt]);

  it('reports deltas, flags stale and missing sources, and never totals them as current', async () => {
    await sample('yt.one.subscribers', 30, '2026-10-31T00:30:00Z');
    await sample('yt.one.subscribers', 36, '2026-11-08T00:30:00Z');
    await sample('x.acct.followers', 40, '2026-11-01T00:30:00Z');
    await sample('x.acct.followers', 43, '2026-11-05T00:30:00Z'); // 3 days old: stale at 36 h
    await query(`INSERT INTO social_metric_status (collector, platform, account, last_run_at, last_error, last_error_at)
                 VALUES ('instagram:ig.example.studio', 'instagram', 'example.studio', now(), 'no Instagram token', now())`);
    const r = await socialReport(s, { now: NOW, days: 7 });
    const yt = r.accounts.find((a) => a.metric === 'yt.one.subscribers')!;
    expect(yt).toMatchObject({ value: 36, delta: 6, stale: false });
    const x = r.accounts.find((a) => a.metric === 'x.acct.followers')!;
    expect(x).toMatchObject({ value: 43, delta: 3, stale: true });
    const ig = r.accounts.find((a) => a.metric === 'ig.example.studio.followers')!;
    expect(ig).toMatchObject({ value: null, missing: true, lastError: 'no Instagram token' });
    expect(r.total).toMatchObject({ value: 36, complete: false, counted: 1, of: 3 });
    expect(r.total.excluded.sort()).toEqual(['ig.example.studio.followers (no reading)', 'x.acct.followers (stale)'].sort());
    const text = formatSocialReport(r);
    expect(text).toMatch(/incomplete/);
    expect(text).toMatch(/STALE/);
    expect(text).toMatch(/no Instagram token/);
    expect(text).toMatch(/Definitions/);
    expect(text).not.toMatch(/—/);
  });

  it('ranks top posts by views gained in the window, leaving out null views and posts without a baseline', async () => {
    await stat('a', '2026-10-31', 100, '2026-10-01T00:00:00Z');
    await stat('a', '2026-11-08', 400, '2026-10-01T00:00:00Z'); // +300
    await stat('b', '2026-11-08', 150, '2026-11-05T00:00:00Z'); // new in window: +150
    await stat('c', '2026-11-08', 999, '2026-09-01T00:00:00Z'); // no baseline: excluded
    await stat('d', '2026-11-08', null, '2026-11-06T00:00:00Z'); // views unknown: excluded, not 0
    await stat('e', '2026-10-31', 10, '2026-10-01T00:00:00Z');
    await stat('e', '2026-11-04', 50, '2026-10-01T00:00:00Z', '2026-11-04T00:30:00Z'); // +40 but stale
    const r = await socialReport(s, { now: NOW, days: 7 });
    expect(r.topPosts.map((p) => [p.externalId, p.viewsGained, p.stale])).toEqual([['a', 300, false], ['b', 150, false], ['e', 40, true]]);
    expect(r.postsWithoutBaseline).toBe(1);
    expect(r.postsWithoutViews).toBe(1);
  });
});
