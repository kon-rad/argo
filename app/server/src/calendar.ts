import { createHash } from 'node:crypto';

/**
 * The calendar module's parser: events live in vault notes, as a markdown
 * table between two comments, so the note that explains an event is also the
 * record of when it happens (one fact, one place).
 *
 *   <!-- calendar tz=Asia/Kolkata -->
 *   | Date | Start | End | Event | Where | Link |
 *   |---|---|---|---|---|---|
 *   | 2026-11-03 | 09:00 | 18:00 | Devcon day 1 | Jio World Centre | https://devcon.org |
 *   | 2026-11-03 to 2026-11-06 | | | Devcon 8 | Mumbai | |
 *   <!-- /calendar -->
 *
 * Columns are found by header name, in any order: `date` and `event` (or
 * `title`) are required; `start`, `end`, `where` (`venue`, `location`) and
 * `link` (`url`) are optional. Times are wall-clock in the block's `tz` (an
 * IANA zone, default UTC); a row without a start time is an all-day event.
 * Rows that don't parse are skipped and counted, never guessed.
 */

export interface CalendarEvent {
  /** Stable per row: the note, the block and the row's place in it. */
  id: string;
  /** First day, YYYY-MM-DD, in the event's zone. */
  date: string;
  /** Last day for a multi-day event, else the same as `date`. */
  end_date: string;
  /** HH:MM wall-clock, or null for all-day. */
  start: string | null;
  end: string | null;
  tz: string;
  title: string;
  where: string | null;
  link: string | null;
  /** Vault path of the note the row came from. */
  source: string;
}

const BLOCK = /<!--\s*calendar\b([^>]*)-->([\s\S]*?)<!--\s*\/calendar\s*-->/gi;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const MD_LINK = /\[([^\]]*)\]\(([^)\s]+)\)/;

const COLUMNS: Record<string, keyof Omit<CalendarEvent, 'tz' | 'source' | 'end_date'>> = {
  date: 'date',
  day: 'date',
  start: 'start',
  from: 'start',
  time: 'start',
  end: 'end',
  until: 'end',
  event: 'title',
  title: 'title',
  what: 'title',
  where: 'where',
  venue: 'where',
  location: 'where',
  link: 'link',
  url: 'link',
};

export function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** A real calendar day in YYYY-MM-DD form (2026-13-01 and 2026-02-30 are not). */
function validDate(s: string | undefined): s is string {
  if (!s || !DATE.test(s)) return false;
  const t = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === s;
}

/** A table row's cells; `\|` is a literal pipe (as in `[[Note\|alias]]`), not a cell break. */
function cells(line: string): string[] {
  const t = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return t.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

/** `[text](url)` → its text and url; a bare URL is a link with no text. */
function splitLink(raw: string): { text: string; url: string | null } {
  const m = MD_LINK.exec(raw);
  if (m) return { text: (raw.replace(MD_LINK, m[1] ?? '')).trim(), url: m[2] && SAFE_URL.test(m[2]) ? m[2] : null };
  if (/^https?:\/\/\S+$/.test(raw)) return { text: '', url: raw };
  return { text: raw, url: null };
}

/** Strip the markdown a table cell commonly carries: bold, wikilink brackets. */
function plain(raw: string): string {
  return raw
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .trim();
}

export function parseCalendar(body: string, source: string): { events: CalendarEvent[]; skipped: number } {
  const events: CalendarEvent[] = [];
  let skipped = 0;
  let blockNo = 0;
  // A block quoted in a code fence or inline code is documentation (the
  // engine's own docs show one), not events.
  const live = body.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, '').replace(/`[^`\n]*`/g, '');
  for (const block of live.matchAll(BLOCK)) {
    blockNo++;
    const tz = /tz=["']?([\w/+-]+)/.exec(block[1] ?? '')?.[1] ?? 'UTC';
    const lines = (block[2] ?? '').split('\n').filter((l) => l.trim().startsWith('|'));
    if (lines.length < 2) continue;
    const header = cells(lines[0]!).map((h) => COLUMNS[h.toLowerCase().replace(/[^a-z]/g, '')]);
    // A block we can't read (no date or event column, a zone that doesn't
    // exist) is counted as skipped rather than shown at guessed times.
    if (!header.includes('date') || !header.includes('title') || !validZone(tz)) {
      skipped += lines.slice(1).filter((l) => !cells(l).every((c) => /^:?-+:?$/.test(c) || c === '')).length;
      continue;
    }
    let rowNo = 0;
    for (const line of lines.slice(1)) {
      const row = cells(line);
      if (row.every((c) => /^:?-+:?$/.test(c) || c === '')) continue; // the |---| rule
      rowNo++;
      const get = (k: string) => {
        const i = header.indexOf(k as never);
        return i >= 0 ? (row[i] ?? '').trim() : '';
      };
      const [d1, d2] = get('date').split(/\s+(?:to|-|–|until)\s+/).map((s) => s.trim());
      const start = get('start');
      const end = get('end');
      const title = splitLink(plain(get('title')));
      const link = splitLink(get('link')).url ?? title.url;
      if (!validDate(d1) || (d2 !== undefined && !validDate(d2)) || (d2 && d2 < d1) || !title.text
        || (start && !TIME.test(start)) || (end && !TIME.test(end)) || (end && !start)) {
        skipped++;
        continue;
      }
      events.push({
        id: `${source}#${blockNo}.${rowNo}`,
        date: d1,
        end_date: d2 ?? d1,
        start: start ? start.padStart(5, '0') : null,
        end: end ? end.padStart(5, '0') : null,
        tz,
        title: title.text,
        where: plain(get('where')) || null,
        link,
        source,
      });
    }
  }
  return { events, skipped };
}

/** Minutes the zone is ahead of UTC at that UTC instant. */
function offsetMinutes(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return Math.round((asUtc - utcMs) / 60000);
}

/** A wall-clock date and time in `tz` as a UTC Date. */
export function zonedToUtc(date: string, time: string, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = guess - offsetMinutes(guess, tz) * 60000;
  return new Date(guess - offsetMinutes(first, tz) * 60000);
}

function nextDay(date: string): string {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}

/** RFC 5545 line folding: at most 75 octets a line, never splitting a character. */
function fold(line: string): string {
  const out: string[] = [];
  let cur = '';
  let octets = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (octets + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = '';
      octets = 0;
    }
    cur += ch;
    octets += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

const icsText = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
const icsUtc = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** An iCalendar file of the events: timed ones in UTC, all-day ones as dates. */
export function toIcs(events: CalendarEvent[], stamp = new Date()): string {
  const out = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//secondbrain//calendar//EN', 'CALSCALE:GREGORIAN'];
  for (const e of events) {
    const uid = createHash('sha1').update(e.id).digest('hex');
    out.push('BEGIN:VEVENT', `UID:${uid}@secondbrain`, `DTSTAMP:${icsUtc(stamp)}`);
    if (e.start) {
      // One timed row is one stretch of time: from the first day's start to
      // the last day's end. An end at or before the start on a one-day row
      // runs past midnight (18:00 to 02:00); no end means one hour.
      const start = zonedToUtc(e.date, e.start, e.tz);
      const endDay = e.end && e.end_date === e.date && e.end <= e.start ? nextDay(e.date) : e.end_date;
      const end = e.end ? zonedToUtc(endDay, e.end, e.tz) : new Date(start.getTime() + 60 * 60000);
      out.push(`DTSTART:${icsUtc(start)}`, `DTEND:${icsUtc(end)}`);
    } else {
      out.push(`DTSTART;VALUE=DATE:${e.date.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${nextDay(e.end_date).replace(/-/g, '')}`);
    }
    out.push(`SUMMARY:${icsText(e.title)}`);
    if (e.where) out.push(`LOCATION:${icsText(e.where)}`);
    if (e.link) out.push(`URL:${e.link}`);
    out.push(`DESCRIPTION:${icsText(`From ${e.source}`)}`, 'END:VEVENT');
  }
  out.push('END:VCALENDAR');
  return out.map(fold).join('\r\n') + '\r\n';
}
