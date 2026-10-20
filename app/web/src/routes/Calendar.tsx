import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { calendarApi, type CalendarEvent } from '../lib/api.js';

/**
 * Calendar: every `<!-- calendar -->` table in the vault, as a month grid and
 * an agenda. Times show in the event's own zone (the zone the note gives),
 * because that is where you will be when it happens. Events are edited in
 * their note; the source link on each one opens it.
 */

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** The 6x7 grid of UTC dates covering the month, weeks starting Monday. */
export function monthGrid(year: number, month: number): string[] {
  const first = new Date(Date.UTC(year, month, 1));
  const lead = (first.getUTCDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, i) => iso(new Date(Date.UTC(year, month, 1 - lead + i))));
}

const covers = (e: CalendarEvent, day: string) => e.date <= day && day <= e.end_date;

function timeLabel(e: CalendarEvent): string {
  if (!e.start) return e.date === e.end_date ? 'All day' : `${e.date.slice(5)} to ${e.end_date.slice(5)}`;
  return `${e.start}${e.end ? `-${e.end}` : ''}`;
}

export default function Calendar() {
  const today = new Date().toLocaleDateString('en-CA'); // the viewer's local day, YYYY-MM-DD
  const cal = useQuery({ queryKey: ['calendar'], queryFn: calendarApi.list });
  const events = cal.data?.events ?? [];

  // Open on the month of the next event (or this month when nothing is ahead).
  // Set once, when the events first arrive, so a refetch never moves the view.
  const [cursor, setCursor] = useState<{ y: number; m: number } | null>(null);
  useEffect(() => {
    if (cursor || !cal.data) return;
    const firstAhead = cal.data.events.find((e) => e.end_date >= today)?.date ?? today;
    setCursor({ y: Number(firstAhead.slice(0, 4)), m: Number(firstAhead.slice(5, 7)) - 1 });
  }, [cal.data, cursor, today]);
  const shown = cursor ?? { y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) - 1 };
  const grid = useMemo(() => monthGrid(shown.y, shown.m), [shown.y, shown.m]);
  const monthKey = `${shown.y}-${String(shown.m + 1).padStart(2, '0')}`;
  const [selected, setSelected] = useState<string | null>(null);

  const move = (step: number) => {
    const d = new Date(Date.UTC(shown.y, shown.m + step, 1));
    setCursor({ y: d.getUTCFullYear(), m: d.getUTCMonth() });
    setSelected(null);
  };

  const agenda = selected
    ? events.filter((e) => covers(e, selected))
    : events.filter((e) => e.end_date >= `${monthKey}-01` && e.date <= `${monthKey}-31`);
  const byDay = new Map<string, CalendarEvent[]>();
  for (const e of agenda) {
    const key = selected ?? (e.date < `${monthKey}-01` ? `${monthKey}-01` : e.date);
    byDay.set(key, [...(byDay.get(key) ?? []), e]);
  }

  const title = new Date(Date.UTC(shown.y, shown.m, 1)).toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' });

  return (
    <div className="flex h-full flex-col overflow-auto">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--rule)] px-4 py-2">
        <h1 className="mr-2 text-xl font-semibold">Calendar</h1>
        <button type="button" onClick={() => move(-1)} className="rounded px-2 py-1 text-sm hover:bg-[var(--paper-sunk)]" aria-label="Previous month">‹</button>
        <span className="min-w-36 text-center text-sm font-medium">{title}</span>
        <button type="button" onClick={() => move(1)} className="rounded px-2 py-1 text-sm hover:bg-[var(--paper-sunk)]" aria-label="Next month">›</button>
        <button
          type="button"
          onClick={() => { setCursor({ y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) - 1 }); setSelected(null); }}
          className="rounded px-2 py-1 text-sm text-[var(--ink-dim)] hover:text-[var(--ink)]"
        >
          Today
        </button>
        <a href={calendarApi.icsUrl()} className="ml-auto rounded px-2 py-1 text-sm text-[var(--ink-dim)] hover:text-[var(--ink)]" download>
          Download .ics
        </a>
      </div>

      {cal.isError && <p className="p-4 text-sm text-red-600">Couldn't load the calendar.</p>}
      {cal.data && events.length === 0 && (
        <p className="p-4 text-sm text-[var(--ink-dim)]">
          No events yet. Add a <code>&lt;!-- calendar tz=Asia/Kolkata --&gt;</code> table to any note (see the calendar module in the engine docs).
        </p>
      )}

      <div className="grid shrink-0 grid-cols-7 border-b border-[var(--rule)] text-xs">
        {WEEKDAYS.map((w) => (
          <div key={w} className="px-1 py-1 text-center text-[var(--ink-dim)]">{w}</div>
        ))}
        {grid.map((day) => {
          const inMonth = day.startsWith(monthKey);
          const dayEvents = events.filter((e) => covers(e, day));
          const isSel = selected === day;
          return (
            <button
              key={day}
              type="button"
              onClick={() => setSelected(isSel ? null : day)}
              className={`min-h-16 border-t border-[var(--rule)] p-1 text-left align-top sm:min-h-20 ${inMonth ? '' : 'opacity-40'} ${isSel ? 'bg-[var(--paper-sunk)]' : 'hover:bg-[var(--paper-sunk)]'}`}
            >
              <div className={`mb-0.5 text-[11px] ${day === today ? 'font-bold text-[var(--accent)]' : 'text-[var(--ink-dim)]'}`}>{Number(day.slice(8))}</div>
              {dayEvents.slice(0, 3).map((e, i) => (
                <div key={i} className="truncate rounded bg-[var(--paper-sunk)] px-1 text-[10px] leading-4 sm:text-[11px]" title={e.title}>
                  {e.start ? `${e.start} ` : ''}{e.title}
                </div>
              ))}
              {dayEvents.length > 3 && <div className="text-[10px] text-[var(--ink-dim)]">+{dayEvents.length - 3} more</div>}
            </button>
          );
        })}
      </div>

      <div className="px-4 py-3">
        <h2 className="mb-2 text-sm font-semibold text-[var(--ink-dim)]">
          {selected ? new Date(`${selected}T00:00:00Z`).toLocaleDateString('en', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }) : `Events in ${title}`}
        </h2>
        {agenda.length === 0 && <p className="text-sm text-[var(--ink-dim)]">Nothing on.</p>}
        {[...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, list]) => (
          <div key={day} className="mb-3">
            {!selected && (
              <div className="text-xs font-medium text-[var(--ink-dim)]">
                {new Date(`${day}T00:00:00Z`).toLocaleDateString('en', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}
              </div>
            )}
            <ul>
              {list.map((e) => (
                <li key={e.id} className="flex flex-wrap items-baseline gap-x-2 border-b border-[var(--rule)] py-1.5 text-sm">
                  <span className="w-24 shrink-0 font-mono text-xs text-[var(--ink-dim)]">{timeLabel(e)}</span>
                  <span className="font-medium">
                    {e.link ? <a href={e.link} target="_blank" rel="noreferrer" className="underline decoration-dotted">{e.title}</a> : e.title}
                  </span>
                  {e.where && <span className="text-[var(--ink-dim)]">{e.where}</span>}
                  <span className="ml-auto flex gap-2 text-xs text-[var(--ink-dim)]">
                    {e.start && <span>{e.tz}</span>}
                    <Link to={`/file/${e.source}`} className="hover:text-[var(--ink)]">note</Link>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {cal.data && cal.data.skipped > 0 && (
          <p className="mt-2 text-xs text-[var(--ink-dim)]">{cal.data.skipped} table rows skipped (bad date or time).</p>
        )}
      </div>
    </div>
  );
}
