import { describe, expect, it } from 'vitest';
import { parseCalendar, toIcs, zonedToUtc } from '../src/calendar.js';

const NOTE = `# Trip

Some prose.

<!-- calendar tz=Asia/Kolkata -->
| Date | Start | End | Event | Where | Link |
|---|---|---|---|---|---|
| 2026-11-03 to 2026-11-06 | | | **Devcon 8** | Jio World Centre | https://devcon.org |
| 2026-11-03 | 9:00 | 18:00 | [Opening](https://devcon.org/schedule) | Main hall | |
| 2026-13-01 | | | Bad date | | |
| 2026-11-04 | 25:00 | | Bad time | | |
<!-- /calendar -->

| Date | Event |
|---|---|
| 2026-11-09 | Outside any block |
`;

describe('parseCalendar', () => {
  it('reads rows inside the block only, with links, ranges and the zone', () => {
    const { events, skipped } = parseCalendar(NOTE, 'trip.md');
    expect(skipped).toBe(2);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      date: '2026-11-03', end_date: '2026-11-06', start: null, title: 'Devcon 8',
      where: 'Jio World Centre', link: 'https://devcon.org', tz: 'Asia/Kolkata', source: 'trip.md',
    });
    expect(events[1]).toMatchObject({ start: '09:00', end: '18:00', title: 'Opening', link: 'https://devcon.org/schedule' });
  });

  it('needs a date and an event column, skips a block with an unknown zone, accepts a quoted zone', () => {
    expect(parseCalendar('<!-- calendar -->\n| Start | Event |\n|---|---|\n| 09:00 | x |\n<!-- /calendar -->', 'a.md').events).toEqual([]);
    const r = parseCalendar('<!-- calendar tz=Mars/Base -->\n| Day | Title |\n|-|-|\n| 2026-01-02 | y |\n<!-- /calendar -->', 'b.md');
    expect(r.events).toEqual([]);
    expect(r.skipped).toBe(1);
    const u = parseCalendar('<!-- calendar tz="Europe/Warsaw" -->\n| Day | Title |\n|-|-|\n| 2026-01-02 | y |\n<!-- /calendar -->', 'c.md');
    expect(u).toMatchObject({ skipped: 0, events: [{ date: '2026-01-02', tz: 'Europe/Warsaw', title: 'y' }] });
  });

  it('ignores blocks quoted in code fences or inline code', () => {
    const doc = 'Use `<!-- calendar -->`.\n\n```\n<!-- calendar -->\n| Date | Event |\n|---|---|\n| 2026-01-02 | Example |\n<!-- /calendar -->\n```\n';
    expect(parseCalendar(doc, 'docs.md')).toEqual({ events: [], skipped: 0 });
  });

  it('keeps escaped pipes in a cell, drops unsafe links and rows with an end but no start', () => {
    const r = parseCalendar(
      '<!-- calendar -->\n| Date | Start | End | Event | Link |\n|--|--|--|--|--|\n'
      + '| 2026-01-02 | | | [[Note\\|Alias]] a \\| b | javascript:alert(1) |\n'
      + '| 2026-01-03 | | 10:00 | No start | |\n<!-- /calendar -->', 'd.md');
    expect(r.skipped).toBe(1);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ title: 'Alias a | b', link: null, id: 'd.md#1.1' });
  });
});

describe('zonedToUtc and toIcs', () => {
  it('converts IST wall-clock to UTC', () => {
    expect(zonedToUtc('2026-11-03', '09:00', 'Asia/Kolkata').toISOString()).toBe('2026-11-03T03:30:00.000Z');
  });

  it('handles a DST zone on both sides of the change', () => {
    expect(zonedToUtc('2026-07-01', '12:00', 'Europe/Warsaw').toISOString()).toBe('2026-07-01T10:00:00.000Z');
    expect(zonedToUtc('2026-12-01', '12:00', 'Europe/Warsaw').toISOString()).toBe('2026-12-01T11:00:00.000Z');
  });

  it('writes timed events in UTC and all-day events with an exclusive end date', () => {
    const { events } = parseCalendar(NOTE, 'trip.md');
    const ics = toIcs(events, new Date('2026-10-20T00:00:00Z'));
    expect(ics).toContain('DTSTART;VALUE=DATE:20261103\r\nDTEND;VALUE=DATE:20261107');
    expect(ics).toContain('DTSTART:20261103T033000Z\r\nDTEND:20261103T123000Z');
    expect(ics).toContain('LOCATION:Main hall');
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
  });

  it('folds long lines at 75 octets, gives each row its own UID, and runs overnight rows past midnight', () => {
    const body = '<!-- calendar tz=Asia/Kolkata -->\n| Date | Start | End | Event |\n|---|---|---|---|\n'
      + `| 2026-11-03 | 18:00 | 02:00 | ${'Zażółć gęślą jaźń '.repeat(8)} |\n`
      + `| 2026-11-03 | 18:00 | 02:00 | ${'Zażółć gęślą jaźń '.repeat(8)} |\n<!-- /calendar -->`;
    const ics = toIcs(parseCalendar(body, 'e.md').events);
    for (const line of ics.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    const uids = ics.match(/^UID:.*$/gm) ?? [];
    expect(new Set(uids).size).toBe(2);
    expect(ics).toContain('DTSTART:20261103T123000Z\r\nDTEND:20261103T203000Z');
  });
});
