import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db.js';
import {
  addManualSession,
  buildSummary,
  fetchKickLive,
  fetchTwitchLive,
  fetchYouTubeLive,
  parseLivePage,
  recordObservation,
  writeSummary,
} from '../src/livestream.js';

// Channels come from settings or env; tests name a fake one.
process.env.LIVESTREAM_TWITCH = 'example-channel';
import { truncateAll } from './helpers.js';

// The shapes YouTube served the droplet on 2026-10-13, cut down to the fields we read.
function page(data: unknown): string {
  return `<html><script nonce="x">var ytInitialPlayerResponse = {"playabilityStatus":{"status":"LOGIN_REQUIRED"}};</script>
<script nonce="x">var ytInitialData = ${JSON.stringify(data)};</script></html>`;
}
function watchPage(videoId: string, counter: Record<string, unknown>, title = 'Building Argo {live} "day 2"'): string {
  return page({
    currentVideoEndpoint: { watchEndpoint: { videoId } },
    contents: {
      twoColumnWatchNextResults: {
        results: {
          results: {
            contents: [
              { videoPrimaryInfoRenderer: { title: { runs: [{ text: title }] }, viewCount: { videoViewCountRenderer: counter } } },
              { videoSecondaryInfoRenderer: {} },
            ],
          },
        },
      },
    },
  });
}
const LIVE = watchPage('abc123', {
  viewCount: { runs: [{ text: '6,123' }, { text: ' watching now' }] },
  isLive: true,
  originalViewCount: '6123',
});
const OFFLINE = page({ contents: { twoColumnBrowseResultsRenderer: { tabs: [] } } });

describe('parseLivePage', () => {
  it('reads the video id, title and exact viewer count from a live watch page', () => {
    expect(parseLivePage(LIVE)).toEqual({ live: true, videoId: 'abc123', title: 'Building Argo {live} "day 2"', viewers: 6123 });
  });

  it('falls back to the "N watching now" text when originalViewCount is missing', () => {
    const html = watchPage('v1', { viewCount: { runs: [{ text: '1,204' }, { text: ' watching now' }] }, isLive: true });
    expect(parseLivePage(html)).toMatchObject({ live: true, viewers: 1204 });
  });

  it('a channel page means not live', () => {
    expect(parseLivePage(OFFLINE)).toEqual({ live: false });
  });

  it('an upcoming or finished stream (watch page, no isLive) means not live', () => {
    const html = watchPage('v2', { viewCount: { simpleText: '12 waiting' }, originalViewCount: '0' });
    expect(parseLivePage(html)).toEqual({ live: false });
  });

  it('throws on a page it does not understand instead of reporting offline', () => {
    expect(() => parseLivePage('<html>consent.youtube.com</html>')).toThrow(/no ytInitialData/);
    expect(() => parseLivePage(page({ contents: {} }))).toThrow(/neither a watch page nor a channel page/);
  });

  it('fetchYouTubeLive throws on an HTTP error', async () => {
    const f = (async () => new Response('nope', { status: 429 })) as typeof fetch;
    await expect(fetchYouTubeLive('https://example.test/live', f)).rejects.toThrow(/HTTP 429/);
  });
});

function fakeFetch(routes: Record<string, () => Response>): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const key = `${url} ${(init?.headers as Record<string, string> | undefined)?.['client-id'] ?? ''}`.trim();
    calls.push(key);
    const hit = routes[key] ?? routes[url];
    if (!hit) throw new Error(`unexpected fetch ${key}`);
    return hit();
  }) as typeof fetch & { calls: string[] };
  f.calls = calls;
  return f;
}

describe('fetchTwitchLive', () => {
  const GQL = 'https://gql.twitch.tv/gql';
  const live = { data: { user: { login: 'example-channel', stream: { id: '316', title: 'AI Founder Coding', viewersCount: 4, createdAt: '2026-10-13T15:40:07Z' } } } };

  it('reads the live stream with its real start time', async () => {
    const f = fakeFetch({ [`${GQL} kimne78kx3ncx6brgo4mv6wki5h1ko`]: () => Response.json(live) });
    expect(await fetchTwitchLive('example-channel', f)).toEqual({
      live: true, videoId: '316', title: 'AI Founder Coding', viewers: 4, startedAt: new Date('2026-10-13T15:40:07Z'),
    });
  });

  it('a user with no stream is not live; an unknown user is an error', async () => {
    const off = fakeFetch({ [GQL]: () => Response.json({ data: { user: { login: 'example-channel', stream: null } } }) });
    expect(await fetchTwitchLive('example-channel', off)).toEqual({ live: false });
    const none = fakeFetch({ [GQL]: () => Response.json({ data: { user: null } }) });
    await expect(fetchTwitchLive('nobody', none)).rejects.toThrow(/no user nobody/);
  });

  it('re-reads a rotated client id from the channel page once', async () => {
    const f = fakeFetch({
      [`${GQL} kimne78kx3ncx6brgo4mv6wki5h1ko`]: () => Response.json({ message: 'The "Client-ID" header is invalid.' }, { status: 400 }),
      'https://www.twitch.tv/example-channel': () => new Response('<script>window.__x={clientId="newclientid0123456789abcd"}</script>'),
      [`${GQL} newclientid0123456789abcd`]: () => Response.json(live),
    });
    expect(await fetchTwitchLive('example-channel', f)).toMatchObject({ live: true, viewers: 4 });
    expect(f.calls).toHaveLength(3);
  });
});

describe('fetchKickLive', () => {
  const get = (status: number, body: unknown) => async () => ({ status, body: typeof body === 'string' ? body : JSON.stringify(body) });

  it('reads the live stream; Kick times are UTC without a zone', async () => {
    const res = get(200, {
      slug: 'example-channel',
      livestream: { id: 132126829, session_title: 'AI Agent Pro - Module 6', is_live: true, viewer_count: 2, start_time: '2026-10-13 15:40:43', created_at: '2026-10-13 15:40:45' },
    });
    expect(await fetchKickLive('example-channel', res)).toEqual({
      live: true, videoId: '132126829', title: 'AI Agent Pro - Module 6', viewers: 2, startedAt: new Date('2026-10-13T15:40:43Z'),
    });
  });

  it('no livestream means not live; a block page, non-JSON or missing channel is an error', async () => {
    expect(await fetchKickLive('example-channel', get(200, { slug: 'example-channel', livestream: null }))).toEqual({ live: false });
    await expect(fetchKickLive('example-channel', get(403, 'cf'))).rejects.toThrow(/HTTP 403/);
    await expect(fetchKickLive('example-channel', get(200, '<html>Just a moment</html>'))).rejects.toThrow(/not JSON/);
    await expect(fetchKickLive('example-channel', get(200, {}))).rejects.toThrow(/no channel/);
  });
});

describe('recording and the public summary', () => {
  beforeEach(truncateAll);

  const at = (min: number) => new Date(Date.UTC(2026, 9, 13, 2, min));
  const live = (videoId: string, viewers: number) => ({ live: true as const, videoId, title: `t-${videoId}`, viewers });

  it('opens a session on the first live poll, extends it, and closes it at the last live sighting', async () => {
    await recordObservation('youtube', live('a', 5), at(0));
    await recordObservation('youtube', live('a', 9), at(1));
    await recordObservation('youtube', live('a', 7), at(2));

    let s = await buildSummary(at(2));
    expect(s.live).toMatchObject({ viewers: 7, since: '2026-10-13T02:00:00Z', url: 'https://www.youtube.com/watch?v=a' });
    expect(s.live?.platforms).toEqual([
      { platform: 'youtube', video_id: 'a', title: 't-a', viewers: 7, since: '2026-10-13T02:00:00Z', url: 'https://www.youtube.com/watch?v=a' },
    ]);
    expect(s.sessions).toHaveLength(1);
    expect(s.sessions[0]).toMatchObject({ minutes: 2, peak_viewers: 9, avg_viewers: 7, ended_at: null });
    expect(s.series?.points.map((p) => p.v)).toEqual([5, 9, 7]);

    await recordObservation('youtube', { live: false }, at(3));
    s = await buildSummary(at(3));
    expect(s.live).toBeNull();
    expect(s.sessions[0]).toMatchObject({ ended_at: '2026-10-13T02:02:00Z', minutes: 2 });
    // The finished stream's chart stays up until the next one starts.
    expect(s.series?.points).toHaveLength(3);
  });

  it('a new broadcast closes the old one', async () => {
    await recordObservation('youtube', live('a', 5), at(0));
    await recordObservation('youtube', live('b', 3), at(10));
    const { rows } = await query(`SELECT video_id, ended_at IS NULL AS open FROM livestream_sessions ORDER BY id`);
    expect(rows).toEqual([{ video_id: 'a', open: false }, { video_id: 'b', open: true }]);
  });

  it('a one-poll blip that read as offline reopens the same broadcast', async () => {
    await recordObservation('youtube', live('a', 5), at(0));
    await recordObservation('youtube', { live: false }, at(1));
    await recordObservation('youtube', live('a', 6), at(2));
    const s = await buildSummary(at(2));
    expect(s.sessions).toHaveLength(1);
    expect(s.sessions[0]).toMatchObject({ ended_at: null, minutes: 2 });
  });

  it('does not claim live when the last sample is stale (collector stopped)', async () => {
    await recordObservation('youtube', live('a', 5), at(0));
    expect((await buildSummary(at(30))).live).toBeNull();
  });

  it('sums a multistream minute by minute and uses the platform start time when there is one', async () => {
    const tw = (v: number) => ({ live: true as const, videoId: 't1', title: 'tw', viewers: v, startedAt: at(0) });
    await recordObservation('youtube', live('a', 5), at(1));
    await recordObservation('twitch', tw(3), at(1));
    await recordObservation('youtube', live('a', 6), at(2));
    await recordObservation('twitch', tw(4), at(2));
    await recordObservation('kick', { live: true, videoId: 'k1', title: 'k', viewers: 1 }, at(2));

    const s = await buildSummary(at(2));
    expect(s.live?.viewers).toBe(11);
    expect(s.live?.platforms.map((p) => p.platform)).toEqual(['youtube', 'twitch', 'kick']);
    expect(s.live?.platforms[1]).toMatchObject({ since: '2026-10-13T02:00:00Z', url: 'https://www.twitch.tv/example-channel' });
    expect(s.live?.since).toBe('2026-10-13T02:00:00Z');
    expect(s.series?.platforms).toEqual(['youtube', 'twitch', 'kick']);
    expect(s.series?.points).toEqual([
      { t: '2026-10-13T02:01:00Z', v: 8, by: { youtube: 5, twitch: 3 } },
      { t: '2026-10-13T02:02:00Z', v: 11, by: { youtube: 6, twitch: 4, kick: 1 } },
    ]);
    // Twitch started (per Twitch) a minute before our first sample.
    expect(s.sessions.find((x) => x.platform === 'twitch')).toMatchObject({ started_at: '2026-10-13T02:00:00Z', minutes: 2 });
  });

  it('manual sessions count toward the list but carry no viewers', async () => {
    await addManualSession({
      platform: 'youtube',
      startedAt: new Date('2026-10-12T02:00:00Z'),
      endedAt: new Date('2026-10-12T05:30:00Z'),
      note: 'day 1, before the collector',
    });
    const s = await buildSummary(at(0));
    expect(s.sessions[0]).toMatchObject({ source: 'manual', minutes: 210, peak_viewers: null, avg_viewers: null });
    expect(s.series).toBeNull();
    await expect(
      addManualSession({ platform: 'youtube', startedAt: at(5), endedAt: at(1) }),
    ).rejects.toThrow(/after the start/);
  });

  it('writes the summary atomically as world-readable JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'livestream-'));
    const file = writeSummary(dir, await buildSummary(at(0)));
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ live: null, sessions: [], poll_error: null });
  });
});
