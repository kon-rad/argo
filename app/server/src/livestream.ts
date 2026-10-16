import { execFile } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { query, withTransaction } from './db.js';
import { settings } from './settings.js';

/**
 * Livestream viewers and hours for a public livestream page, with no API key
 * on any platform. The channels come from `livestream` in secondbrain.json
 * (or LIVESTREAM_YOUTUBE / _TWITCH / _KICK); a platform with none is skipped.
 *  - YouTube: the /live page embeds `ytInitialData` with the live video's id,
 *    title and exact viewer count. The player response is bot-blocked from
 *    datacenter IPs (seen 2026-10-13), so nothing depends on it, and the
 *    session starts at our first sample.
 *  - Twitch: the public GraphQL endpoint the twitch.tv web player uses, with
 *    the site's own public client id (re-read from the channel page if Twitch
 *    rotates it). Gives the stream's real start time.
 *  - Kick: the JSON channel endpoint kick.com's own page calls. Also gives the
 *    start time. Fetched with curl: Cloudflare answered Node's fetch with 403
 *    from a datacenter IP but let curl through (2026-10-14).
 */

/** The configured channel per platform: env wins over secondbrain.json. */
export function channels(): { youtube?: string; twitch?: string; kick?: string } {
  const s = settings().livestream;
  return {
    youtube: process.env.LIVESTREAM_YOUTUBE || s.youtube,
    twitch: process.env.LIVESTREAM_TWITCH || s.twitch,
    kick: process.env.LIVESTREAM_KICK || s.kick,
  };
}

/** A YouTube handle (with or without @) or a full /live URL. */
export function youtubeLiveUrl(channel: string): string {
  if (/^https?:\/\//.test(channel)) return channel;
  return `https://www.youtube.com/@${channel.replace(/^@/, '')}/live`;
}

export type LiveObservation =
  | { live: true; videoId: string; title: string | null; viewers: number; startedAt?: Date }
  | { live: false };

export type Platform = 'youtube' | 'twitch' | 'kick' | 'x';
type Fetch = typeof fetch;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

/** The JSON object assigned to `name` in the page's inline scripts. */
function inlineJson(html: string, name: string): Record<string, unknown> | null {
  const m = new RegExp(`(?:var\\s+)?${name}\\s*=\\s*\\{`).exec(html);
  if (!m) return null;
  const start = m.index + m[0].length - 1;
  // Scan to the matching brace, skipping strings; JSON.parse can't stop early.
  let depth = 0;
  let inString = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(html.slice(start, i + 1)) as Record<string, unknown>;
  }
  return null;
}

const get = (o: unknown, ...path: (string | number)[]): unknown =>
  path.reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string | number, unknown>)[k] : undefined), o);

function runsText(t: unknown): string | null {
  const simple = get(t, 'simpleText');
  if (typeof simple === 'string') return simple;
  const runs = get(t, 'runs');
  return Array.isArray(runs) ? runs.map((r) => get(r, 'text') ?? '').join('') : null;
}

/**
 * Reads a YouTube /live page. A channel that isn't live renders its channel
 * page (a browse result); a live one renders the watch page. Anything else
 * throws, so a page we don't understand is never logged as "offline".
 */
export function parseLivePage(html: string): LiveObservation {
  const data = inlineJson(html, 'ytInitialData');
  if (!data) throw new Error('no ytInitialData on the page (consent wall or a layout change?)');

  const watch = get(data, 'contents', 'twoColumnWatchNextResults', 'results', 'results', 'contents');
  if (!Array.isArray(watch)) {
    if (get(data, 'contents', 'twoColumnBrowseResultsRenderer')) return { live: false };
    throw new Error('ytInitialData is neither a watch page nor a channel page');
  }
  const primary = watch.map((c) => get(c, 'videoPrimaryInfoRenderer')).find(Boolean);
  const counter = get(primary, 'viewCount', 'videoViewCountRenderer');
  // An upcoming or finished stream also renders a watch page, without isLive.
  if (!counter || get(counter, 'isLive') !== true) return { live: false };

  const videoId = get(data, 'currentVideoEndpoint', 'watchEndpoint', 'videoId');
  if (typeof videoId !== 'string') throw new Error('live watch page without a video id');
  const exact = get(counter, 'originalViewCount');
  const digits = (typeof exact === 'string' ? exact : runsText(get(counter, 'viewCount')) ?? '').replace(/[^0-9]/g, '');
  if (!digits) throw new Error(`live watch page without a viewer count (${videoId})`);
  return { live: true, videoId, title: runsText(get(primary, 'title')), viewers: Number(digits) };
}

export async function fetchYouTubeLive(url: string, f: Fetch = fetch): Promise<LiveObservation> {
  const res = await f(url, {
    headers: {
      'user-agent': UA,
      'accept-language': 'en-US,en;q=0.9',
      // Skips the EU cookie-consent interstitial if YouTube ever geolocates us there.
      cookie: 'SOCS=CAI',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`YouTube /live HTTP ${res.status}`);
  return parseLivePage(await res.text());
}

// The twitch.tv web client's public id (in every page as clientId="...").
const TWITCH_WEB_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'; // gitleaks:allow (public)

async function twitchClientIdFromPage(login: string, f: Fetch): Promise<string> {
  const res = await f(`https://www.twitch.tv/${login}`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20_000) });
  const m = /clientId\s*=\s*"([a-z0-9]{20,40})"/.exec(await res.text());
  if (!m) throw new Error('Twitch: no clientId on the channel page');
  return m[1]!;
}

export async function fetchTwitchLive(login: string, f: Fetch = fetch): Promise<LiveObservation> {
  const body = JSON.stringify({
    query: `query($l:String!){ user(login:$l){ login stream { id title viewersCount createdAt } } }`,
    variables: { l: login },
  });
  const ask = (clientId: string) =>
    f('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: { 'client-id': clientId, 'content-type': 'application/json', 'user-agent': UA },
      body,
      signal: AbortSignal.timeout(20_000),
    });
  let res = await ask(TWITCH_WEB_CLIENT_ID);
  // A rotated client id answers 400 "Client-ID header is invalid": read the current one off the page once.
  if (res.status === 400) res = await ask(await twitchClientIdFromPage(login, f));
  if (!res.ok) throw new Error(`Twitch GQL HTTP ${res.status}`);
  const json = (await res.json()) as { data?: { user?: { stream?: { id: string; title: string | null; viewersCount: number; createdAt: string } | null } | null }; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(`Twitch GQL: ${json.errors[0]!.message}`);
  const user = json.data?.user;
  if (!user) throw new Error(`Twitch: no user ${login}`);
  const st = user.stream;
  if (!st) return { live: false };
  if (typeof st.viewersCount !== 'number') throw new Error('Twitch: stream without viewersCount');
  return { live: true, videoId: st.id, title: st.title, viewers: st.viewersCount, startedAt: new Date(st.createdAt) };
}

/** Kick's timestamps are UTC without a zone: "2026-10-13 15:40:43". */
function kickTime(s: unknown): Date | undefined {
  if (typeof s !== 'string') return undefined;
  const d = new Date(`${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export type HttpGet = (url: string) => Promise<{ status: number; body: string }>;

/** GET with the curl binary; the status code rides on the last line of stdout. */
export const curlGet: HttpGet = (url) =>
  new Promise((resolve, reject) => {
    execFile(
      'curl',
      ['-sS', '-m', '20', '-A', UA, '-H', 'Accept: application/json', '-w', '\n%{http_code}', url],
      { maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(new Error(`curl: ${err.message.split('\n')[0]}`));
        const cut = stdout.lastIndexOf('\n');
        resolve({ status: Number(stdout.slice(cut + 1)), body: stdout.slice(0, cut) });
      },
    );
  });

export async function fetchKickLive(slug: string, get: HttpGet = curlGet): Promise<LiveObservation> {
  const res = await get(`https://kick.com/api/v2/channels/${slug}`);
  if (res.status !== 200) throw new Error(`Kick HTTP ${res.status}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    throw new Error('Kick: the reply is not JSON (a challenge page?)');
  }
  const ch = parsed as { slug?: string; livestream?: { id: number; session_title: string | null; viewer_count: number; is_live: boolean; start_time?: string; created_at?: string } | null };
  if (!ch.slug) throw new Error(`Kick: no channel ${slug}`);
  const ls = ch.livestream;
  if (!ls || !ls.is_live) return { live: false };
  if (typeof ls.viewer_count !== 'number') throw new Error('Kick: livestream without viewer_count');
  return {
    live: true,
    videoId: String(ls.id),
    title: ls.session_title,
    viewers: ls.viewer_count,
    startedAt: kickTime(ls.start_time) ?? kickTime(ls.created_at),
  };
}

/** Where the public page links each platform while it is live. */
export function watchUrl(platform: string, videoId: string): string {
  if (platform === 'twitch') return `https://www.twitch.tv/${channels().twitch ?? ''}`;
  if (platform === 'kick') return `https://kick.com/${channels().kick ?? ''}`;
  if (platform === 'x') return `https://x.com/i/broadcasts/${videoId}`;
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/* X is polled separately (livestream-x.ts): it follows pasted broadcast links, not a channel. */
export function pollers(): Partial<Record<Exclude<Platform, 'x'>, () => Promise<LiveObservation>>> {
  const c = channels();
  return {
    ...(c.youtube ? { youtube: () => fetchYouTubeLive(youtubeLiveUrl(c.youtube!)) } : {}),
    ...(c.twitch ? { twitch: () => fetchTwitchLive(c.twitch!) } : {}),
    ...(c.kick ? { kick: () => fetchKickLive(c.kick!) } : {}),
  };
}

/**
 * Applies one poll to the tables, in one transaction. While live: a sample,
 * plus the broadcast's session opened or extended. When not live: the open
 * session is closed at the last time we saw it live. A failed poll never gets
 * here, so a network blip doesn't end a session.
 */
export async function recordObservation(platform: string, obs: LiveObservation, now = new Date()): Promise<void> {
  await withTransaction(async (tx) => {
    // Close whatever is open unless it is this same broadcast.
    await tx.query(
      `UPDATE livestream_sessions SET ended_at = last_seen_at
        WHERE platform = $1 AND source = 'collector' AND ended_at IS NULL
          AND ($2::text IS NULL OR video_id <> $2)`,
      [platform, obs.live ? obs.videoId : null],
    );
    if (!obs.live) return;

    // Same broadcast seen again after it was closed (a blip that read as offline): reopen it.
    await tx.query(
      `INSERT INTO livestream_sessions (platform, video_id, title, started_at, last_seen_at, peak_viewers)
       VALUES ($1, $2, $3, least(coalesce($6::timestamptz, $4), $4), $4, $5)
       ON CONFLICT (platform, video_id) DO UPDATE SET
         title = coalesce(EXCLUDED.title, livestream_sessions.title),
         started_at = least(livestream_sessions.started_at, EXCLUDED.started_at),
         last_seen_at = greatest(livestream_sessions.last_seen_at, EXCLUDED.last_seen_at),
         ended_at = NULL,
         peak_viewers = greatest(livestream_sessions.peak_viewers, EXCLUDED.peak_viewers)`,
      [platform, obs.videoId, obs.title, now, obs.viewers, obs.startedAt ?? null],
    );
    await tx.query(
      `INSERT INTO livestream_viewer_samples (platform, ts, video_id, viewers) VALUES ($1, $2, $3, $4)
       ON CONFLICT (platform, ts) DO NOTHING`,
      [platform, now, obs.videoId, obs.viewers],
    );
  });
}

/** A stream the collector never saw, entered by hand. */
export async function addManualSession(s: {
  platform: string;
  startedAt: Date;
  endedAt: Date;
  note?: string;
}): Promise<number> {
  if (!(s.endedAt > s.startedAt)) throw new Error('the end must be after the start');
  const { rows } = await query<{ id: number }>(
    `INSERT INTO livestream_sessions (platform, started_at, last_seen_at, ended_at, source, note)
     VALUES ($1, $2, $3, $3, 'manual', $4) RETURNING id`,
    [s.platform, s.startedAt, s.endedAt, s.note ?? null],
  );
  return rows[0]!.id;
}

export interface PublicSession {
  platform: string;
  video_id: string | null;
  title: string | null;
  started_at: string;
  ended_at: string | null;
  minutes: number;
  peak_viewers: number | null;
  avg_viewers: number | null;
  source: 'collector' | 'manual';
}

export interface LivePlatform {
  platform: string;
  video_id: string;
  title: string | null;
  viewers: number;
  since: string;
  url: string;
}

export interface LivestreamSummary {
  generated_at: string;
  /** Every platform live right now, plus their total. `url` and `title` are the first platform's. */
  live: { viewers: number; since: string; url: string; title: string | null; platforms: LivePlatform[] } | null;
  sessions: PublicSession[];
  /**
   * Viewers over the live (or else the most recent) stream: every collector
   * session that overlaps it, summed per minute across platforms, at most MAX_POINTS.
   */
  series: { start: string; end: string; platforms: string[]; points: { t: string; v: number; by: Record<string, number> }[] } | null;
  /** Set when the latest poll failed on any platform; the rest is the last good data. */
  poll_error: string | null;
}

const MAX_POINTS = 360;
const STALE_MS = 5 * 60_000;
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS"Z"'`;

/** Everything the public page needs, built from the tables. Nothing private goes in. */
export async function buildSummary(now = new Date(), days = 120, pollError: string | null = null): Promise<LivestreamSummary> {
  const { rows } = await query<PublicSession & { s0: Date; s1: Date }>(
    `SELECT s.platform, s.video_id, s.title,
            s.started_at AS s0, coalesce(s.ended_at, s.last_seen_at) AS s1,
            to_char(s.started_at AT TIME ZONE 'UTC', ${ISO}) AS started_at,
            to_char(s.ended_at AT TIME ZONE 'UTC', ${ISO}) AS ended_at,
            round(extract(epoch FROM coalesce(s.ended_at, s.last_seen_at) - s.started_at) / 60.0, 1)::float8 AS minutes,
            s.peak_viewers, a.avg_viewers, s.source
       FROM livestream_sessions s
       LEFT JOIN LATERAL (
         SELECT round(avg(viewers))::int AS avg_viewers FROM livestream_viewer_samples v
          WHERE v.platform = s.platform AND v.video_id = s.video_id
       ) a ON true
      WHERE s.started_at > $1::timestamptz - make_interval(days => $2)
      ORDER BY s.started_at DESC, s.platform`,
    [now, days],
  );
  const sessions = rows.map(({ s0: _s0, s1: _s1, ...s }) => s);

  // Live = an open collector session whose newest sample is fresh: a dead timer must not leave the page saying "live".
  const platforms: LivePlatform[] = [];
  for (const r of rows) {
    if (r.source !== 'collector' || r.ended_at !== null || !r.video_id) continue;
    const last = await query<{ viewers: number; ts: Date }>(
      `SELECT viewers, ts FROM livestream_viewer_samples WHERE platform = $1 AND video_id = $2 ORDER BY ts DESC LIMIT 1`,
      [r.platform, r.video_id],
    );
    const l = last.rows[0];
    if (!l || now.getTime() - l.ts.getTime() > STALE_MS) continue;
    platforms.push({
      platform: r.platform,
      video_id: r.video_id,
      title: r.title,
      viewers: l.viewers,
      since: r.started_at,
      url: watchUrl(r.platform, r.video_id),
    });
  }
  const order = ['youtube', 'twitch', 'kick', 'x'];
  platforms.sort((x, y) => order.indexOf(x.platform) - order.indexOf(y.platform));

  // The latest stream block: the newest collector session plus every one that overlaps it, transitively
  // (a multistream starts on each platform a few seconds apart).
  const collector = rows.filter((r) => r.source === 'collector').sort((x, y) => y.s1.getTime() - x.s1.getTime());
  let series: LivestreamSummary['series'] = null;
  if (collector.length) {
    let start = collector[0]!.s0.getTime();
    let end = collector[0]!.s1.getTime();
    for (const r of collector.slice(1)) {
      if (r.s1.getTime() >= start && r.s0.getTime() <= end) {
        start = Math.min(start, r.s0.getTime());
        end = Math.max(end, r.s1.getTime());
      }
    }
    const pts = await query<{ t: string; platform: string; viewers: number }>(
      `SELECT to_char(ts AT TIME ZONE 'UTC', ${ISO}) AS t, platform, viewers
         FROM livestream_viewer_samples WHERE ts BETWEEN $1 AND $2 ORDER BY ts`,
      [new Date(start), new Date(end)],
    );
    // One poll writes every platform with the same timestamp, so a minute is one key.
    const byT = new Map<string, Record<string, number>>();
    for (const p of pts.rows) {
      const m = byT.get(p.t) ?? {};
      m[p.platform] = p.viewers;
      byT.set(p.t, m);
    }
    const all = [...byT].map(([t, by]) => ({ t, v: Object.values(by).reduce((a, b) => a + b, 0), by }));
    // Keep every k-th point so an all-day stream stays a small file; always keep the last.
    const k = Math.ceil(all.length / MAX_POINTS);
    const points = k <= 1 ? all : all.filter((_, i) => i % k === 0 || i === all.length - 1);
    if (points.length) {
      series = {
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        platforms: order.filter((p) => pts.rows.some((r) => r.platform === p)),
        points,
      };
    }
  }

  return {
    generated_at: now.toISOString(),
    live: platforms.length
      ? {
          viewers: platforms.reduce((a, p) => a + p.viewers, 0),
          since: platforms.map((p) => p.since).sort()[0]!,
          url: platforms[0]!.url,
          title: platforms[0]!.title,
          platforms,
        }
      : null,
    sessions,
    series,
    poll_error: pollError,
  };
}

/** Atomic write: Caddy never serves a half-written file. */
export function writeSummary(dir: string, summary: LivestreamSummary): string {
  const file = join(dir, 'livestream.json');
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(summary), { mode: 0o644 });
  renameSync(tmp, file);
  return file;
}
