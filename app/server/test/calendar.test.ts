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

  it('needs a date and an event column, and falls back to UTC for an unknown zone', () => {
    expect(parseCalendar('<!-- calendar -->\n| Start | Event |\n|---|---|\n| 09:00 | x |\n<!-- /calendar -->', 'a.md').events).toEqual([]);
    const r = parseCalendar('<!-- calendar tz=Mars/Base -->\n| Day | Title |\n|-|-|\n| 2026-01-02 | y |\n<!-- /calendar -->', 'b.md');
    expect(r.events[0]).toMatchObject({ date: '2026-01-02', tz: 'UTC', title: 'y' });
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
});
