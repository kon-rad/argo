import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { query } from './db.js';
import { recordObservation } from './livestream.js';

/**
 * X (Twitter) live broadcasts. Reading a broadcast needs no login: X's public
 * web-client bearer plus a guest token opens `1.1/broadcasts/show`, which
 * returns its state, concurrent viewers and start time (tested 2026-10-14).
 * Finding which broadcast is live does need a login (logged-out timelines come
 * back empty), so the owner pastes the link to their agent and the
 * `livestream-x` skill registers it. When another platform goes live and no X
 * link has arrived, the timer pings the owner once on Telegram.
 */

// The bearer x.com's own web app sends for logged-out visitors. Public, not a secret.
const X_WEB_BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

/** Give a registration this long to go RUNNING before the timer stops polling it. */
const REGISTRATION_TTL_MS = 24 * 3_600_000;
/** How long another platform must be live before the "paste the X link" ping. */
const REMIND_AFTER_MS = 3 * 60_000;

type Fetch = typeof fetch;

/** Accepts x.com/i/broadcasts/<id>, twitter.com/..., with or without query string, or the bare id. */
export function parseBroadcastId(input: string): string {
  const s = input.trim();
  const m = /(?:x|twitter)\.com\/i\/broadcasts\/([A-Za-z0-9]{8,24})/.exec(s) ?? /^([A-Za-z0-9]{8,24})$/.exec(s);
  if (!m) throw new Error(`not an X broadcast link: ${s.slice(0, 80)} (expected x.com/i/broadcasts/<id>)`);
  return m[1]!;
}

export interface XBroadcast {
  id: string;
  state: string;
  title: string | null;
  viewers: number | null;
  startedAt: Date | null;
  endedAt: Date | null;
}

const ms = (v: unknown): Date | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? new Date(n) : null;
};

export async function fetchXBroadcast(id: string, f: Fetch = fetch): Promise<XBroadcast> {
  const headers = { authorization: `Bearer ${X_WEB_BEARER}`, 'user-agent': UA };
  const act = await f('https://api.x.com/1.1/guest/activate.json', { method: 'POST', headers, signal: AbortSignal.timeout(15_000) });
  if (!act.ok) throw new Error(`X guest token HTTP ${act.status}`);
  const guest = ((await act.json()) as { guest_token?: string }).guest_token;
  if (!guest) throw new Error('X gave no guest token');

  const res = await f(`https://api.x.com/1.1/broadcasts/show.json?ids=${encodeURIComponent(id)}&include_events=false`, {
    headers: { ...headers, 'x-guest-token': guest },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`X broadcasts/show HTTP ${res.status}`);
  const b = ((await res.json()) as { broadcasts?: Record<string, Record<string, unknown>> }).broadcasts?.[id];
  if (!b || typeof b.state !== 'string') throw new Error(`X has no broadcast ${id}`);
  const watching = Number(b.total_watching ?? b.n_watching);
  return {
    id,
    state: b.state,
    title: typeof b.status === 'string' && b.status ? b.status : null,
    viewers: Number.isFinite(watching) ? watching : null,
    startedAt: ms(b.start_ms) ?? ms(b.created_at_ms),
    endedAt: ms(b.end_ms) ?? ms(b.timedout_ms) ?? (b.state === 'ENDED' ? ms(b.updated_at_ms) : null),
  };
}

/** Called by the skill when the owner pastes a link. Re-pasting an ended one polls it again once. */
export async function registerXBroadcast(input: string): Promise<string> {
  const id = parseBroadcastId(input);
  await query(
    `INSERT INTO livestream_x_broadcasts (broadcast_id) VALUES ($1)
     ON CONFLICT (broadcast_id) DO UPDATE SET done_at = NULL, added_at = now()`,
    [id],
  );
  return id;
}

/**
 * One poll of every registered broadcast that isn't done. RUNNING → a sample
 * through the same session logic as the other platforms. ENDED/TIMED_OUT →
 * the session is closed at X's own end time, or created from X's start and end
 * if the link came in after the stream (so its hours still count).
 */
export async function pollX(now = new Date(), f: Fetch = fetch): Promise<{ lines: string[]; errors: string[] }> {
  const lines: string[] = [];
  const errors: string[] = [];
  const { rows } = await query<{ broadcast_id: string; added_at: Date }>(
    `SELECT broadcast_id, added_at FROM livestream_x_broadcasts WHERE done_at IS NULL ORDER BY added_at`,
  );
  for (const r of rows) {
    const id = r.broadcast_id;
    let b: XBroadcast;
    try {
      b = await fetchXBroadcast(id, f);
    } catch (err) {
      errors.push(`x ${id}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    await query(`UPDATE livestream_x_broadcasts SET last_state = $2, last_checked_at = $3 WHERE broadcast_id = $1`, [id, b.state, now]);

    if (b.state === 'RUNNING') {
      if (b.viewers === null) {
        errors.push(`x ${id}: running without a viewer count`);
        continue;
      }
      await recordObservation('x', { live: true, videoId: id, title: b.title, viewers: b.viewers, startedAt: b.startedAt ?? undefined }, now);
      lines.push(`x: live ${id}, ${b.viewers} watching`);
    } else if (b.state === 'ENDED' || b.state === 'TIMED_OUT') {
      const end = b.endedAt ?? now;
      // X's own end time, but never earlier than our last live sample.
      const closed = await query(
        `UPDATE livestream_sessions SET last_seen_at = greatest(last_seen_at, least($2::timestamptz, $3::timestamptz)),
                ended_at = greatest(last_seen_at, least($2::timestamptz, $3::timestamptz))
          WHERE platform = 'x' AND video_id = $1 AND ended_at IS NULL`,
        [id, end, now],
      );
      if (!closed.rowCount && b.startedAt) {
        // Never seen live (pasted late): log it from X's own times so the hours count.
        await query(
          `INSERT INTO livestream_sessions (platform, video_id, title, started_at, last_seen_at, ended_at)
           VALUES ('x', $1, $2, $3, $4, $4) ON CONFLICT (platform, video_id) DO NOTHING`,
          [id, b.title, b.startedAt, end],
        );
      }
      await query(`UPDATE livestream_x_broadcasts SET done_at = $2 WHERE broadcast_id = $1`, [id, now]);
      lines.push(`x: ${id} ${b.state.toLowerCase()}`);
    } else if (now.getTime() - r.added_at.getTime() > REGISTRATION_TTL_MS) {
      await query(`UPDATE livestream_x_broadcasts SET done_at = $2 WHERE broadcast_id = $1`, [id, now]);
      lines.push(`x: ${id} still ${b.state} after 24 h, stopped polling`);
    } else {
      lines.push(`x: ${id} ${b.state.toLowerCase()}, waiting`);
    }
  }
  return { lines, errors };
}

export type Notify = (text: string) => Promise<void>;

/** Sends through the Hermes bot to its home channel. Reads only the two keys it needs from Hermes's env file. */
export function hermesTelegram(envFile = process.env.HERMES_ENV_FILE ?? join(process.env.HERMES_HOME ?? join(homedir(), '.hermes'), '.env')): Notify {
  return async (text) => {
    const env: Record<string, string> = {};
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const m = /^\s*(?:export\s+)?(TELEGRAM_BOT_TOKEN|TELEGRAM_HOME_CHANNEL)\s*=\s*(.*)$/.exec(line);
      if (m) env[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '');
    }
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_HOME_CHANNEL) throw new Error('Hermes env has no Telegram bot token or home channel');
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_HOME_CHANNEL, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Telegram HTTP ${res.status}`);
  };
}

const LABEL: Record<string, string> = { youtube: 'YouTube', twitch: 'Twitch', kick: 'Kick' };

/**
 * One ping per stream: another platform has been live for REMIND_AFTER_MS, no
 * X broadcast was registered for it (a link sent up to 2 hours before going
 * live counts), and this stream hasn't been pinged yet. Returns the text sent, or null.
 */
export async function remindXLink(now: Date, notify: Notify): Promise<string | null> {
  const live = await query<{ platform: string; started_at: Date }>(
    `SELECT platform, started_at FROM livestream_sessions
      WHERE platform <> 'x' AND source = 'collector' AND ended_at IS NULL
        AND last_seen_at > $1::timestamptz - interval '5 minutes'
      ORDER BY started_at`,
    [now],
  );
  if (!live.rows.length) return null;
  const start = live.rows[0]!.started_at;
  if (now.getTime() - start.getTime() < REMIND_AFTER_MS) return null;

  const has = await query(
    `SELECT 1 FROM livestream_x_broadcasts WHERE added_at >= $1::timestamptz - interval '2 hours'
     UNION ALL
     SELECT 1 FROM livestream_sessions WHERE platform = 'x' AND coalesce(ended_at, last_seen_at) >= $1::timestamptz
     LIMIT 1`,
    [start],
  );
  if (has.rowCount) return null;

  const key = `x-link:${start.toISOString()}`;
  const ins = await query(`INSERT INTO livestream_notices (key) VALUES ($1) ON CONFLICT DO NOTHING`, [key]);
  if (!ins.rowCount) return null;

  const where = [...new Set(live.rows.map((r) => LABEL[r.platform] ?? r.platform))].join(' and ');
  const text =
    `[livestream] You're live on ${where}. If you're also live on X, paste the broadcast link here ` +
    `(x.com/i/broadcasts/...) and I'll track its viewers and hours.`;
  try {
    await notify(text);
  } catch (err) {
    // Let the next minute retry rather than swallowing the ping.
    await query(`DELETE FROM livestream_notices WHERE key = $1`, [key]);
    throw err;
  }
  return text;
}
