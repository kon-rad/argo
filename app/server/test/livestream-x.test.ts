import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db.js';
import { buildSummary, recordObservation } from '../src/livestream.js';
import { fetchXBroadcast, parseBroadcastId, pollX, registerXBroadcast, remindXLink } from '../src/livestream-x.js';
import { truncateAll } from './helpers.js';

// broadcasts/show as X served it to the droplet on 2026-10-14, cut down to the fields we read.
function xFetch(broadcasts: Record<string, Record<string, unknown>>, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/guest/activate.json')) return Response.json({ guest_token: '2110040000' });
    const id = new URL(url).searchParams.get('ids')!;
    return Response.json({ broadcasts: { [id]: broadcasts[id] ?? {} }, events: {} });
  }) as typeof fetch;
}
const T0 = Date.UTC(2026, 9, 14, 12, 0);
const at = (min: number) => new Date(T0 + min * 60_000);
const running = (viewers: number) => ({ state: 'RUNNING', status: 'Building Argo', total_watching: String(viewers), start_ms: String(T0) });

describe('parseBroadcastId', () => {
  it('takes a link in any of its forms, or the bare id', () => {
    expect(parseBroadcastId('https://x.com/i/broadcasts/1qKVmyeOlzZxB')).toBe('1qKVmyeOlzZxB');
    expect(parseBroadcastId('twitter.com/i/broadcasts/1qKVmyeOlzZxB?s=20')).toBe('1qKVmyeOlzZxB');
    expect(parseBroadcastId('live now! https://x.com/i/broadcasts/1qKVmyeOlzZxB ')).toBe('1qKVmyeOlzZxB');
    expect(parseBroadcastId('1qKVmyeOlzZxB')).toBe('1qKVmyeOlzZxB');
    expect(() => parseBroadcastId('https://x.com/example/status/123')).toThrow(/not an X broadcast link/);
  });
});

describe('fetchXBroadcast', () => {
  it('gets a guest token, then reads state, viewers and start', async () => {
    const calls: string[] = [];
    const b = await fetchXBroadcast('abc12345', xFetch({ abc12345: running(17) }, calls));
    expect(b).toMatchObject({ state: 'RUNNING', viewers: 17, title: 'Building Argo', startedAt: at(0) });
    expect(calls[0]).toMatch(/guest\/activate/);
  });

  it('an unknown broadcast is an error', async () => {
    await expect(fetchXBroadcast('nope1234', xFetch({}))).rejects.toThrow(/no broadcast nope1234/);
  });
});

describe('pollX', () => {
  beforeEach(truncateAll);

  it('samples a running broadcast from X’s start time, then closes it at X’s end and stops polling', async () => {
    await registerXBroadcast('https://x.com/i/broadcasts/abc12345');
    await pollX(at(2), xFetch({ abc12345: running(5) }));
    await pollX(at(3), xFetch({ abc12345: running(9) }));
    let s = await buildSummary(at(3));
    expect(s.live?.platforms).toEqual([
      expect.objectContaining({ platform: 'x', viewers: 9, since: '2026-10-14T12:00:00Z', url: 'https://x.com/i/broadcasts/abc12345' }),
    ]);

    const ended = { abc12345: { state: 'ENDED', status: 'Building Argo', total_watching: '0', start_ms: String(T0), end_ms: String(at(4).getTime()) } };
    const r = await pollX(at(5), xFetch(ended));
    expect(r.lines).toEqual(['x: abc12345 ended']);
    s = await buildSummary(at(5));
    expect(s.live).toBeNull();
    expect(s.sessions[0]).toMatchObject({ platform: 'x', ended_at: '2026-10-14T12:04:00Z', minutes: 4, peak_viewers: 9 });

    // Done: the next poll doesn't call X at all.
    const calls: string[] = [];
    await pollX(at(6), xFetch(ended, calls));
    expect(calls).toEqual([]);
  });

  it('a link pasted after the stream ended still logs its hours from X’s own times', async () => {
    await registerXBroadcast('late5678');
    await pollX(at(90), xFetch({ late5678: { state: 'TIMED_OUT', total_watching: '40', start_ms: String(T0), timedout_ms: String(at(75).getTime()) } }));
    const s = await buildSummary(at(90));
    expect(s.sessions[0]).toMatchObject({ platform: 'x', minutes: 75, peak_viewers: null, ended_at: '2026-10-14T13:15:00Z' });
  });

  it('a broadcast that never starts is dropped after 24 hours', async () => {
    await registerXBroadcast('wait1234');
    await query(`UPDATE livestream_x_broadcasts SET added_at = $1`, [at(0)]);
    const r = await pollX(at(25 * 60), xFetch({ wait1234: { state: 'NOT_STARTED' } }));
    expect(r.lines[0]).toMatch(/stopped polling/);
  });
});

describe('remindXLink', () => {
  beforeEach(truncateAll);
  const twitch = (min: number) =>
    recordObservation('twitch', { live: true, videoId: 't1', title: 't', viewers: 1, startedAt: at(0) }, at(min));

  it('pings once per stream after 3 minutes live with no X link', async () => {
    const sent: string[] = [];
    const notify = async (t: string) => void sent.push(t);
    await twitch(1);
    expect(await remindXLink(at(1), notify)).toBeNull(); // too early
    await twitch(4);
    expect(await remindXLink(at(4), notify)).toMatch(/live on Twitch.*x\.com\/i\/broadcasts/);
    await twitch(5);
    expect(await remindXLink(at(5), notify)).toBeNull(); // already pinged
    expect(sent).toHaveLength(1);
  });

  it('stays quiet when the link was already sent (even before going live)', async () => {
    await registerXBroadcast('early123');
    await query(`UPDATE livestream_x_broadcasts SET added_at = $1`, [at(-30)]);
    await twitch(10);
    expect(await remindXLink(at(10), async () => {})).toBeNull();
  });

  it('a failed send is retried next minute', async () => {
    await twitch(4);
    await expect(remindXLink(at(4), async () => { throw new Error('Telegram HTTP 502'); })).rejects.toThrow(/502/);
    expect(await remindXLink(at(5), async () => {})).not.toBeNull();
  });
});
