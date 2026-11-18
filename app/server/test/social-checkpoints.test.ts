import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db.js';
import type { HttpGet } from '../src/metrics/collect.js';
import { checkpointAt, collectCheckpoints, duePosts } from '../src/metrics/social/checkpoints.js';
import { saveToken } from '../src/metrics/social/tokens.js';
import type { SocialDeps } from '../src/metrics/social/types.js';
import { parseSettings, type SocialMetricsSettings } from '../src/settings.js';
import { truncateAll } from './helpers.js';

// Fake accounts, ids and keys only.
const CH1 = 'UC' + 'a'.repeat(22);
const ENC = '0'.repeat(63) + '1';
const YT_KEY = 'yt-secret-key-123'; // gitleaks:allow (fake)
const IG_TOKEN = 'IGtokenSECRET0001'; // gitleaks:allow (fake)
const NOW = new Date('2026-11-08T01:00:00Z');
const HOUR = 3_600_000;
const hoursAgo = (h: number, from = NOW) => new Date(from.getTime() - h * HOUR);
const later = (h: number) => new Date(NOW.getTime() + h * HOUR);

const cfg = (raw: Record<string, unknown>): SocialMetricsSettings => parseSettings({ socialMetrics: raw }).socialMetrics;
const deps = (get: HttpGet, extra: Partial<SocialDeps> = {}): SocialDeps =>
  ({ get, publicGet: get, now: NOW, youtubeApiKey: YT_KEY, encKey: ENC, env: {}, vaultRoot: tmpdir(), ...extra });

type Calls = { url: string; headers: Record<string, string> }[];
function fakeGet(route: (url: string) => { status: number; body: unknown } | undefined): HttpGet & { calls: Calls } {
  const calls: Calls = [];
  const get = (async (url: string, headers: Record<string, string> = {}) => {
    calls.push({ url, headers });
    const hit = route(url) ?? { status: 404, body: { error: { message: `no route for ${url}` } } };
    return { status: hit.status, body: JSON.stringify(hit.body) };
  }) as HttpGet & { calls: Calls };
  get.calls = calls;
  return get;
}

/** videos.list answering with fixed statistics for every id asked, optionally without likes. */
const youtube = (opts: { views?: string; hiddenLikes?: boolean } = {}) => (url: string) => {
  if (!url.startsWith('https://www.googleapis.com/youtube/v3/videos?')) return undefined;
  const ids = new URL(url).searchParams.get('id')!.split(',');
  return { status: 200, body: { items: ids.map((id) => ({ id, statistics: { viewCount: opts.views ?? '480', commentCount: '2', ...(opts.hiddenLikes ? {} : { likeCount: '31' }) } })) } };
};

async function statRow(platform: string, account: string, id: string, postedAt: Date, socialPostId: number | null = null) {
  await query(
    `INSERT INTO social_post_stats (platform, account, external_id, day, posted_at, views, source, social_post_id)
     VALUES ($1, $2, $3, $4::date, $4, 1, 'test', $5)`, [platform, account, id, postedAt, socialPostId]);
}

async function rows(id: string) {
  const r = await query<{ checkpoint: string; metric: string; value: string | null; error: string | null; social_post_id: string | null; account: string | null }>(
    `SELECT checkpoint, metric, value::text, error, social_post_id::text, account FROM social_post_metrics WHERE remote_id = $1 ORDER BY checkpoint, metric`, [id]);
  return r.rows;
}

describe('checkpoint windows', () => {
  it('takes each checkpoint only inside its own window', () => {
    expect(checkpointAt(hoursAgo(23.9), NOW)).toBeNull();
    expect(checkpointAt(hoursAgo(24), NOW)).toBe('24h');
    expect(checkpointAt(hoursAgo(71.9), NOW)).toBe('24h');
    expect(checkpointAt(hoursAgo(72), NOW)).toBe('72h');
    expect(checkpointAt(hoursAgo(167), NOW)).toBe('72h');
    expect(checkpointAt(hoursAgo(168), NOW)).toBe('7d');
    expect(checkpointAt(hoursAgo(191.9), NOW)).toBe('7d');
    expect(checkpointAt(hoursAgo(192), NOW)).toBeNull();
  });
});

describe('social post checkpoints', () => {
  beforeEach(async () => { await truncateAll(); });

  it('reads a YouTube video at 24 h, 72 h and 7 d, once each, with the key in a header', async () => {
    await statRow('youtube', CH1, 'vidAAAAAAAA', hoursAgo(25));
    const s = cfg({ youtube: [{ channelId: CH1 }] });
    const get = fakeGet(youtube());

    const first = await collectCheckpoints(s, deps(get));
    expect(first.map((r) => r.checkpoint)).toEqual(['24h']);
    expect(get.calls).toHaveLength(1);
    expect(get.calls[0]!.url).not.toContain(YT_KEY);
    expect(get.calls[0]!.headers['x-goog-api-key']).toBe(YT_KEY);
    expect(await rows('vidAAAAAAAA')).toEqual([
      { checkpoint: '24h', metric: 'comments', value: '2', error: null, social_post_id: null, account: CH1 },
      { checkpoint: '24h', metric: 'likes', value: '31', error: null, social_post_id: null, account: CH1 },
      { checkpoint: '24h', metric: 'views', value: '480', error: null, social_post_id: null, account: CH1 },
    ]);

    // An hour later the 24 h checkpoint is taken: nothing is due, no API call.
    expect(await collectCheckpoints(s, deps(get, { now: later(1) }))).toEqual([]);
    expect(get.calls).toHaveLength(1);

    await collectCheckpoints(s, deps(fakeGet(youtube({ views: '900' })), { now: later(48) }));
    await collectCheckpoints(s, deps(fakeGet(youtube({ views: '1500' })), { now: later(144) }));
    const views = (await rows('vidAAAAAAAA')).filter((r) => r.metric === 'views').map((r) => [r.checkpoint, r.value]);
    expect(views).toEqual([['24h', '480'], ['72h', '900'], ['7d', '1500']]);
    // Past 8 days nothing more is read.
    expect(await duePosts(later(170))).toEqual([]);
  });

  it('leaves no row for a missed window rather than a mislabelled one', async () => {
    await statRow('youtube', CH1, 'vidBBBBBBBB', hoursAgo(80));
    const res = await collectCheckpoints(cfg({}), deps(fakeGet(youtube())));
    expect(res.map((r) => r.checkpoint)).toEqual(['72h']);
    expect((await rows('vidBBBBBBBB')).every((r) => r.checkpoint === '72h')).toBe(true);
  });

  it('stores hidden likes as NULL without an error', async () => {
    await statRow('youtube', CH1, 'vidCCCCCCCC', hoursAgo(30));
    await collectCheckpoints(cfg({}), deps(fakeGet(youtube({ hiddenLikes: true }))));
    expect((await rows('vidCCCCCCCC')).find((r) => r.metric === 'likes')).toMatchObject({ value: null, error: null });
  });

  it('logs NULLs with the reason when access is missing, retries while the window is open, and never overwrites a good reading', async () => {
    await statRow('youtube', CH1, 'vidDDDDDDDD', hoursAgo(26));
    const none = await collectCheckpoints(cfg({}), deps(fakeGet(youtube()), { youtubeApiKey: undefined }));
    expect(none[0]!.error).toMatch(/YOUTUBE_API_KEY is not set/);
    expect((await rows('vidDDDDDDDD')).map((r) => [r.metric, r.value, Boolean(r.error)])).toEqual([
      ['comments', null, true], ['likes', null, true], ['views', null, true],
    ]);

    // A denied call (quota, bad key) is the same: NULLs, the API's reason, the key redacted.
    const denied = fakeGet(() => ({ status: 403, body: { error: { message: `quota exceeded for ${YT_KEY}`, errors: [{ reason: 'quotaExceeded' }] } } }));
    const r2 = await collectCheckpoints(cfg({}), deps(denied, { now: later(1) }));
    expect(r2[0]!.error).toMatch(/quotaExceeded/);
    const dump = JSON.stringify((await query(`SELECT * FROM social_post_metrics`)).rows);
    expect(dump).not.toContain(YT_KEY);

    await collectCheckpoints(cfg({}), deps(fakeGet(youtube()), { now: later(2) }));
    expect((await rows('vidDDDDDDDD')).map((r) => [r.metric, r.value, r.error])).toEqual([
      ['comments', '2', null], ['likes', '31', null], ['views', '480', null],
    ]);
    // Still in the 24 h window, but taken: a later run cannot replace it.
    expect(await duePosts(later(3))).toEqual([]);
  });

  it('reads a Short the social module published through Buffer, by the video id in its URL', async () => {
    const { rows: [acct] } = await query<{ id: number }>(
      `INSERT INTO social_accounts (provider, provider_account_id, display_name, access_token, access_token_expires_at, transport)
       VALUES ('youtube', 'buf-1', 'chan', 'x', now() + interval '1 year', 'buffer') RETURNING id`);
    const { rows: [post] } = await query<{ id: number }>(
      `INSERT INTO social_posts (account_id, body, status, scheduled_for, posted_at, remote_url)
       VALUES ($1, 'reel', 'posted', $2, $2, 'https://youtube.com/shorts/vidEEEEEEEE') RETURNING id`, [acct!.id, hoursAgo(73)]);
    await collectCheckpoints(cfg({}), deps(fakeGet(youtube())));
    const r = await rows('vidEEEEEEEE');
    expect(r).toHaveLength(3);
    expect(r.every((x) => x.checkpoint === '72h' && x.social_post_id === String(post!.id) && x.account === null)).toBe(true);
  });

  describe('Instagram', () => {
    const s = () => cfg({ instagram: [{ username: 'example.studio' }] });
    const ig = (insights: boolean) => (url: string) => {
      const u = new URL(url);
      if (u.origin !== 'https://graph.instagram.com') return undefined;
      if (u.pathname.endsWith('/m1/insights')) {
        return insights
          ? { status: 200, body: { data: [['views', 300], ['reach', 250], ['likes', 9], ['comments', 2], ['shares', 0], ['saved', 3]].map(([name, value]) => ({ name, total_value: { value } })) } }
          : { status: 400, body: { error: { message: `missing permission instagram_business_manage_insights (token ${u.searchParams.get('access_token')})` } } };
      }
      if (u.pathname.endsWith('/m1')) return { status: 200, body: { id: 'm1', like_count: 8, comments_count: 1 } };
      return undefined;
    };

    it('reads insights at the checkpoint with the stored token, without refreshing it', async () => {
      await saveToken('instagram', 'example.studio', IG_TOKEN, ENC, { expiresAt: later(24 * 30), refreshedAt: hoursAgo(24 * 30) });
      await statRow('instagram', 'example.studio', 'm1', hoursAgo(24.5));
      const get = fakeGet(ig(true));
      await collectCheckpoints(s(), deps(get));
      expect(get.calls.map((c) => new URL(c.url).pathname)).toEqual(['/v23.0/m1/insights']);
      expect(Object.fromEntries((await rows('m1')).map((r) => [r.metric, r.value]))).toEqual(
        { views: '300', reach: '250', likes: '9', comments: '2', shares: '0', saves: '3' });
    });

    it('when insights are refused, keeps likes and comments from the media fields and logs the rest as NULL', async () => {
      await saveToken('instagram', 'example.studio', IG_TOKEN, ENC, { expiresAt: later(24 * 30), refreshedAt: NOW });
      await statRow('instagram', 'example.studio', 'm1', hoursAgo(30));
      const [r] = await collectCheckpoints(s(), deps(fakeGet(ig(false))));
      expect(r!.error).toMatch(/instagram_business_manage_insights/);
      const got = Object.fromEntries((await rows('m1')).map((x) => [x.metric, [x.value, Boolean(x.error)]]));
      expect(got).toEqual({ views: [null, true], reach: [null, true], shares: [null, true], saves: [null, true], likes: ['8', false], comments: ['1', false] });
      expect(JSON.stringify((await query(`SELECT * FROM social_post_metrics`)).rows)).not.toContain(IG_TOKEN);
    });

    it('logs NULLs for a post on an account with no token or no config', async () => {
      await statRow('instagram', 'example.studio', 'm1', hoursAgo(30));
      await statRow('instagram', 'other.account', 'm9', hoursAgo(30));
      const res = await collectCheckpoints(s(), deps(fakeGet(ig(true))));
      expect(res.find((r) => r.remoteId === 'm1')!.error).toMatch(/no Instagram token for @example\.studio/);
      expect(res.find((r) => r.remoteId === 'm9')!.error).toMatch(/not in socialMetrics\.instagram/);
      expect((await rows('m9')).every((r) => r.value === null && r.error)).toBe(true);
    });
  });

  it('writes nothing on a dry run', async () => {
    await statRow('youtube', CH1, 'vidFFFFFFFF', hoursAgo(25));
    const res = await collectCheckpoints(cfg({}), deps(fakeGet(youtube())), false);
    expect(res).toHaveLength(1);
    expect(await rows('vidFFFFFFFF')).toEqual([]);
  });
});
