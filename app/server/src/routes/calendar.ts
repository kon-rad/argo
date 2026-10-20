import { Router } from 'express';
import { z } from 'zod';
import { parseCalendar, toIcs, type CalendarEvent } from '../calendar.js';
import { query } from '../db.js';
import { parseOr400, wrap } from './http.js';

/**
 * The calendar module: every `<!-- calendar -->` table in the vault's notes,
 * read from the index (so it is as fresh as the last scan), merged and sorted.
 * `GET /` is JSON for the /calendar page; `GET /ics` is the same events as an
 * iCalendar file to import into a phone calendar.
 */

const Q = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export async function loadEvents(): Promise<{ events: CalendarEvent[]; skipped: number; sources: string[] }> {
  const r = await query<{ path: string; body: string }>(
    `SELECT path, body FROM vault_files
     WHERE is_markdown AND body ~* '<!--\\s*calendar' ORDER BY path`,
  );
  const events: CalendarEvent[] = [];
  let skipped = 0;
  for (const row of r.rows) {
    const p = parseCalendar(row.body, row.path);
    events.push(...p.events);
    skipped += p.skipped;
  }
  events.sort((a, b) => a.date.localeCompare(b.date) || (a.start ?? '').localeCompare(b.start ?? '') || a.title.localeCompare(b.title));
  return { events, skipped, sources: r.rows.map((x) => x.path) };
}

export function calendarRouter(): Router {
  const router = Router();

  router.get(
    '/',
    wrap(async (req, res) => {
      const q = parseOr400(Q, req.query);
      const all = await loadEvents();
      const events = all.events.filter((e) => (!q.from || e.end_date >= q.from) && (!q.to || e.date <= q.to));
      res.json({ events, skipped: all.skipped, sources: all.sources });
    }),
  );

  router.get(
    '/ics',
    wrap(async (_req, res) => {
      const { events } = await loadEvents();
      res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="secondbrain.ics"');
      res.send(toIcs(events));
    }),
  );

  return router;
}
