import { afterEach, describe, expect, it } from 'vitest';
import { bucketEnd } from '../src/routes/usage/format.js';
import { appTimezone, browserTimezone, setAppTimezone, span, startedStamp, zoned } from '../src/lib/time.js';

afterEach(() => setAppTimezone(null));

describe('time helpers in the shared zone', () => {
  it('Started is YYYYMMDD HH:mm, 24-hour, in the given zone, across date lines', () => {
    const iso = '2026-11-09T23:30:00Z';
    expect(startedStamp(iso, 'UTC')).toBe('20261109 23:30');
    expect(startedStamp(iso, 'Asia/Singapore')).toBe('20261110 07:30');      // the next day
    expect(startedStamp(iso, 'America/Los_Angeles')).toBe('20261109 15:30');
    expect(startedStamp('2026-11-10T16:00:00Z', 'Asia/Singapore')).toBe('20261111 00:00'); // midnight is 00, not 24
    expect(startedStamp(null, 'UTC')).toBe('');
  });

  it('handles the DST change: the repeated hour keeps its true offset', () => {
    // US clocks fall back at 02:00 PDT on 2026-11-01: 08:30Z and 09:30Z are both 01:30 local.
    expect(startedStamp('2026-11-01T08:30:00Z', 'America/Los_Angeles')).toBe('20261101 01:30');
    expect(startedStamp('2026-11-01T09:30:00Z', 'America/Los_Angeles')).toBe('20261101 01:30');
    expect(startedStamp('2026-03-08T10:30:00Z', 'America/Los_Angeles')).toBe('20260308 03:30'); // spring forward skips 02:xx
    // Day buckets end at the next local midnight, 25 or 23 hours later.
    expect(bucketEnd('2026-11-01T07:00:00Z', 'day', 'America/Los_Angeles')).toBe('2026-11-02T08:00:00.000Z');
    expect(bucketEnd('2026-03-08T08:00:00Z', 'day', 'America/Los_Angeles')).toBe('2026-03-09T07:00:00.000Z');
    expect(bucketEnd('2026-11-09T16:00:00Z', 'day', 'Asia/Singapore')).toBe('2026-11-10T16:00:00.000Z');
  });

  it('the vault zone drives the default; an invalid or missing one falls back to the browser', () => {
    expect(setAppTimezone('Asia/Singapore')).toBe('Asia/Singapore');
    expect(startedStamp('2026-11-09T23:30:00Z')).toBe('20261110 07:30');
    expect(zoned('2026-11-09T23:30:00Z')).toMatch(/Nov 10, 2026/);
    expect(setAppTimezone('Mars/Olympus')).toBe(browserTimezone());
    expect(setAppTimezone(null)).toBe(browserTimezone());
    expect(appTimezone()).toBe(browserTimezone());
  });

  it('duration is the elapsed span, shown apart from Started; unknown when an end is missing', () => {
    expect(span('2026-11-10T07:13:00Z', '2026-11-10T07:13:40Z')).toBe('40 s');
    expect(span('2026-11-10T07:13:00Z', '2026-11-10T07:43:00Z')).toBe('30 min');
    expect(span('2026-11-10T07:13:00Z', '2026-11-10T09:18:00Z')).toBe('2 h 05 min');
    expect(span('2026-11-10T07:13:00Z', '2026-11-12T11:13:00Z')).toBe('2 d 4 h');
    expect(span('2026-11-10T07:13:00Z', null)).toBeNull();
  });
});

