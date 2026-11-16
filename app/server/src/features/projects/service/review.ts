import { query } from '../../../db.js';
import { day, SHIPPED, TrackerError, type Stage } from './common.js';
import { homeFolder, homeNotePath, kpiDefs, readNote } from './context.js';

/**
 * The weekly review: one markdown file per ISO week that says, area by area, what the
 * change history (`tracker_events`), the KPI readings, the board and the vault index hold
 * for that week. `cli-areas review` writes it; a timer runs it on Sunday evening.
 *
 * The generated part sits between two markers. Everything outside them is the owner's (a
 * `## Reflection` section, notes under the block) and a re-run never touches it. Areas
 * where nothing happened collapse into one "Quiet" line, so the review does not have to be
 * read in full to find the two things that changed.
 */

export const REVIEW_START = '<!-- review:start -->';
export const REVIEW_END = '<!-- review:end -->';
/** Columns the tracker sets on its own next to a change that is already reported (a ship date with the stage), or that say nothing (the sort order). */
const BOOKKEEPING = new Set(['sort', 'shipped_at']);
/** Rows shown of one list before it is cut with a count. */
const ROWS = 12;

// ---------------------------------------------------------------- weeks

const DAY_MS = 86_400_000;
const utc = (d: string): Date => new Date(`${d}T00:00:00Z`);
const ymd = (d: Date): string => d.toISOString().slice(0, 10);
const mondayIndex = (d: Date): number => (d.getUTCDay() + 6) % 7;
export const addDays = (d: string, n: number): string => ymd(new Date(utc(d).getTime() + n * DAY_MS));

/** The calendar day it is in `tz` at `now`. */
export function localDay(now: Date, tz: string): string {
  // en-CA writes a date as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** The ISO week a day is in, e.g. `2026-W46`. A week belongs to the year its Thursday is in. */
export function isoWeekOf(d: string): string {
  const thursday = new Date(utc(d).getTime() + (3 - mondayIndex(utc(d))) * DAY_MS);
  const year = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week1Monday = jan4.getTime() - mondayIndex(jan4) * DAY_MS;
  const week = 1 + Math.floor((thursday.getTime() - week1Monday) / (7 * DAY_MS));
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** The Monday an ISO week starts on. Refuses anything that is not a week of that year (a W53 in a 52-week year). */
export function weekMonday(week: string): string {
  const m = /^(\d{4})-W(\d{2})$/.exec(week);
  const bad = new TrackerError(`"${week}" is not an ISO week (e.g. 2026-W46)`);
  if (!m) throw bad;
  const jan4 = new Date(Date.UTC(Number(m[1]), 0, 4));
  const monday = ymd(new Date(jan4.getTime() - mondayIndex(jan4) * DAY_MS + (Number(m[2]) - 1) * 7 * DAY_MS));
  if (isoWeekOf(monday) !== week) throw bad;
  return monday;
}

/**
 * The week a run is for. A week given as `2026-W46` is that week. `ending` is the week that
 * is ending or has just ended: what the Sunday timer asks for, and still the right week
 * when a missed run is caught up on Monday. Nothing given: the week it is now in `tz`.
 */
export function resolveWeek(arg: string | undefined, now: Date, tz: string): string {
  if (arg === undefined) return isoWeekOf(localDay(now, tz));
  if (arg === 'ending') return isoWeekOf(addDays(localDay(now, tz), -3));
  weekMonday(arg);
  return arg;
}

// ---------------------------------------------------------------- the data

export interface AreaReview {
  slug: string;
  title: string;
  shipped: string[];
  moved: string[];
  slipped: string[];
  /** New and dropped: projects created, archived, brought back. */
  added: string[];
  kpis: string[];
  /** Changed facts: frontmatter keys of the home notes, and tracker fields other than a stage. */
  facts: string[];
  cards: { total: number; rows: string[] };
  notes: { total: number; rows: string[] };
}

export interface WeeklyReview {
  week: string;
  /** Monday and Sunday of the week. */
  from: string;
  to: string;
  timezone: string;
  /** Areas where something happened, in the tracker's order. */
  areas: AreaReview[];
  /** Active areas where nothing did. */
  quiet: string[];
  /** Cards finished that name no area. */
  unfiled: { total: number; rows: string[] };
}

const one = (s: string): string => s.replace(/\s+/g, ' ').trim();
const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const val = (v: unknown): string => (v === null || v === undefined ? 'none' : clip(one(typeof v === 'string' ? v : JSON.stringify(v)), 100));
const fmt = (n: number): string => String(Math.round(n * 100) / 100);
const signed = (n: number): string => `${n > 0 ? '+' : ''}${fmt(n)}`;
const because = (note: string | null): string => (note ? ` (${clip(one(note), 120)})` : '');
/** The notes a write path adds on its own say nothing a reader needs. */
const said = (note: string | null): string | null => (note && !/^(added|imported)$/.test(note) ? note : null);

interface EventRow {
  area_slug: string; project_id: string | null; project: string | null; kind: string; field: string | null;
  from_value: unknown; to_value: unknown; note: string | null;
}

/**
 * Reads one week. The week runs from Monday 00:00 to the next Monday 00:00 in `tz`.
 *
 * Slipped is two things. A due date moved later during the week (a `due` change in the
 * log, from one date to a later one). And a due date that passed during the week while the
 * project was still open: its due day is in the week and before today, and the project was
 * not shipped, parked, done or archived at the end of the week. For a past week the state
 * at its end is read back from the log: the first later change of a field holds what the
 * field was.
 */
export async function buildWeeklyReview(vaultRoot: string, week: string, opts: { now?: Date; timezone?: string } = {}): Promise<WeeklyReview> {
  const now = opts.now ?? new Date();
  const tz = opts.timezone ?? 'UTC';
  const monday = weekMonday(week);
  const nextMonday = addDays(monday, 7);
  const bounds = (await query<{ s: Date; e: Date }>(`SELECT ($1::date::timestamp AT TIME ZONE $3) AS s, ($2::date::timestamp AT TIME ZONE $3) AS e`, [monday, nextMonday, tz])).rows[0]!;
  const range = [bounds.s, bounds.e];
  /** A due day before this one has passed: today, or the day after the week for a week that is over. */
  const today = localDay(now, tz);
  const passedBefore = today < nextMonday ? today : nextMonday;

  const areas = (await query<{ slug: string; title: string; status: string; home_path: string | null; archived_at: Date | null }>(
    `SELECT slug, title, status, home_path, archived_at FROM areas ORDER BY priority NULLS LAST, slug`,
  )).rows;
  const by = new Map<string, AreaReview>(areas.map((a) => [a.slug, { slug: a.slug, title: a.title, shipped: [], moved: [], slipped: [], added: [], kpis: [], facts: [], cards: { total: 0, rows: [] }, notes: { total: 0, rows: [] } }]));
  const touched = new Set<string>();

  const events = (await query<EventRow>(
    `SELECT e.area_slug, e.project_id, p.slug AS project, e.kind, e.field, e.from_value, e.to_value, e.note
       FROM tracker_events e LEFT JOIN projects p ON p.id = e.project_id
      WHERE e.at >= $1 AND e.at < $2 ORDER BY e.at, e.id`,
    range,
  )).rows;
  for (const e of events) {
    const r = by.get(e.area_slug);
    if (!r) continue;
    touched.add(e.area_slug);
    const who = e.project ?? 'the area';
    const note = because(said(e.note));
    const to = e.to_value as Record<string, unknown> | string | null;
    if (e.kind === 'created') {
      if (e.project) r.added.push(`New: ${e.project}, ${val((to as Record<string, unknown>)?.title)} [${val((to as Record<string, unknown>)?.stage)}]${note}`);
      else r.added.push(`The area was added${note}`);
    } else if (e.kind === 'archived') {
      r.added.push(e.project ? `Dropped: ${e.project}, archived${note}` : `The area was archived${note}`);
    } else if (e.kind === 'unarchived') {
      r.added.push(e.project ? `Back: ${e.project}, unarchived${note}` : `The area was unarchived${note}`);
    } else if (e.kind === 'stage') {
      const line = `${who}: ${val(e.from_value)} → ${val(e.to_value)}${note}`;
      const ships = (s: unknown): boolean => SHIPPED.includes(s as Stage);
      if (e.project && ships(e.to_value) && !ships(e.from_value)) r.shipped.push(line);
      else r.moved.push(line);
    } else if (e.kind === 'frontmatter') {
      r.facts.push(`${who}, ${e.field}: ${val(e.from_value)} → ${val(e.to_value)}`);
    } else if (e.kind === 'changed') {
      const later = e.field === 'due' && typeof e.from_value === 'string' && typeof e.to_value === 'string' && e.to_value > e.from_value;
      if (later) r.slipped.push(`${who}: due moved from ${e.from_value as string} to ${e.to_value as string}${note}`);
      else if (!BOOKKEEPING.has(e.field ?? '')) r.facts.push(`${who}, ${e.field}: ${val(e.from_value)} → ${val(e.to_value)}${note}`);
    }
    // A kpi_reading is read from kpi_readings below: it makes the area not quiet, and the KPI lines say the rest.
  }

  // Due dates that passed during the week while the project was open, as things stood at the end of the week.
  const projects = (await query<{ id: string; area_slug: string; slug: string; stage: Stage; due: unknown; archived_at: Date | null }>(
    `SELECT id, area_slug, slug, stage, due, archived_at FROM projects ORDER BY id`,
  )).rows;
  const later = (await query<{ project_id: string; kind: string; field: string | null; from_value: unknown }>(
    `SELECT project_id, kind, field, from_value FROM tracker_events
      WHERE project_id IS NOT NULL AND at >= $1 AND (kind IN ('created', 'stage', 'archived', 'unarchived') OR (kind = 'changed' AND field = 'due'))
      ORDER BY at, id`,
    [bounds.e],
  )).rows;
  const then = new Map<string, { born?: true; stage?: unknown; due?: unknown; archived?: boolean }>();
  for (const e of later) {
    const t = then.get(String(e.project_id)) ?? {};
    then.set(String(e.project_id), t);
    if (e.kind === 'created') t.born = true;
    else if (e.kind === 'stage' && !('stage' in t)) t.stage = e.from_value;
    else if (e.kind === 'changed' && !('due' in t)) t.due = e.from_value;
    else if ((e.kind === 'archived' || e.kind === 'unarchived') && !('archived' in t)) t.archived = e.kind === 'unarchived';
  }
  const passed: { area: string; due: string; line: string }[] = [];
  for (const p of projects) {
    const t = then.get(String(p.id)) ?? {};
    if (t.born) continue;
    const stage = ('stage' in t ? t.stage : p.stage) as Stage;
    const due = 'due' in t ? (typeof t.due === 'string' ? t.due : null) : day(p.due);
    const archived = 'archived' in t ? t.archived : Boolean(p.archived_at);
    if (!due || archived || SHIPPED.includes(stage) || stage === 'parked') continue;
    if (due < monday || due >= passedBefore) continue;
    passed.push({ area: p.area_slug, due, line: `${p.slug}: due ${due} passed, still ${stage}` });
  }
  // Oldest first; the sort is stable, so two projects due the same day stay in the order they were added.
  for (const p of passed.sort((a, b) => a.due.localeCompare(b.due))) {
    by.get(p.area)?.slipped.push(p.line);
    touched.add(p.area);
  }

  // KPIs: the reading the week started with (the last one before it, else the first one in it) and the one it ended with.
  const reading = async (where: string, order: 'ASC' | 'DESC', params: unknown[]): Promise<Map<string, number>> =>
    new Map(
      (await query<{ area_slug: string; kpi_key: string; value: number }>(
        `SELECT DISTINCT ON (area_slug, kpi_key) area_slug, kpi_key, value::float8 AS value FROM kpi_readings
          WHERE project_id IS NULL AND ${where} ORDER BY area_slug, kpi_key, at ${order}, id ${order}`,
        params,
      )).rows.map((r) => [`${r.area_slug}\n${r.kpi_key}`, r.value]),
    );
  const before = await reading('at < $1', 'DESC', [bounds.s]);
  const first = await reading('at >= $1 AND at < $2', 'ASC', range);
  const end = await reading('at < $1', 'DESC', [bounds.e]);

  const cards = (await query<{ id: string; title: string; area_slug: string | null; project_slug: string | null }>(
    `SELECT id, title, area_slug, project_slug FROM cards
      WHERE status IN ('done', 'archived') AND completed_at >= $1 AND completed_at < $2 ORDER BY completed_at, id`,
    range,
  )).rows;
  const unfiled = { total: 0, rows: [] as string[] };
  for (const c of cards) {
    const r = c.area_slug ? by.get(c.area_slug) : undefined;
    const into = r ? r.cards : unfiled;
    into.total++;
    if (into.rows.length < ROWS) into.rows.push(`${c.id} ${clip(one(c.title), 100)}${c.project_slug ? ` (${c.project_slug})` : ''}`);
    if (r) touched.add(r.slug);
  }

  for (const a of areas) {
    const r = by.get(a.slug)!;
    const folder = homeFolder(a.home_path);
    if (folder) {
      const notes = (await query<{ path: string; total: number }>(
        `SELECT path, count(*) OVER ()::int AS total FROM vault_files
          WHERE starts_with(path, $1) AND is_markdown AND mtime >= $2 AND mtime < $3 ORDER BY mtime DESC, path LIMIT $4`,
        [`${folder}/`, ...range, ROWS],
      )).rows;
      r.notes = { total: notes[0]?.total ?? 0, rows: notes.map((n) => n.path) };
      if (r.notes.total) touched.add(a.slug);
    }
    if (!touched.has(a.slug)) continue;
    const defs = kpiDefs(readNote(vaultRoot, homeNotePath(a.home_path))?.frontmatter ?? {});
    // A key that has readings but is no longer defined is still reported, without a target.
    const keys = new Set([...defs.map((d) => d.key), ...[...end.keys()].filter((k) => k.startsWith(`${a.slug}\n`)).map((k) => k.split('\n')[1]!)]);
    for (const key of keys) {
      const k = `${a.slug}\n${key}`;
      const last = end.get(k);
      if (last === undefined) continue;
      const def = defs.find((d) => d.key === key);
      const unit = def?.unit ? ` ${def.unit}` : '';
      const start = before.get(k) ?? first.get(k)!;
      const change = before.has(k) || first.get(k) !== last ? `${fmt(start)} → ${fmt(last)}${unit} (${signed(last - start)})` : `${fmt(last)}${unit} (first reading)`;
      const target = def?.target ?? null;
      const distance = target === null ? '' : last >= target ? `; target ${fmt(target)} reached` : `; ${fmt(target - last)} to the target of ${fmt(target)}${def?.by ? ` by ${def.by}` : ''}`;
      r.kpis.push(`${def?.name ?? key} (${key}): ${change}${distance}`);
    }
  }

  return {
    week, from: monday, to: addDays(monday, 6), timezone: tz,
    areas: areas.filter((a) => touched.has(a.slug)).map((a) => by.get(a.slug)!),
    quiet: areas.filter((a) => !touched.has(a.slug) && a.status === 'active' && !a.archived_at).map((a) => a.slug),
    unfiled,
  };
}

// ---------------------------------------------------------------- the file

const list = (title: string, rows: string[]): string[] => {
  if (!rows.length) return [];
  const shown = rows.slice(0, ROWS);
  return [`**${title}**`, '', ...shown.map((r) => `- ${r}`), ...(rows.length > shown.length ? [`- ... and ${rows.length - shown.length} more`] : []), ''];
};
const counted = (label: string, c: { total: number; rows: string[] }): string[] =>
  c.total ? [`- ${label} (${c.total}): ${c.rows.join('; ')}${c.total > c.rows.length ? `; ... and ${c.total - c.rows.length} more` : ''}`] : [];

/** The generated block, markers included. It holds nothing that changes between two runs over the same data. */
export function renderReviewBlock(r: WeeklyReview): string {
  const out: string[] = [
    REVIEW_START,
    `_Generated by \`cli-areas review --week ${r.week}\` (${r.from} to ${r.to}, ${r.timezone}). A re-run rewrites this block and nothing outside it._`,
    '',
  ];
  for (const a of r.areas) {
    out.push(`## ${a.title} (\`${a.slug}\`)`, '');
    out.push(...list('Shipped', a.shipped), ...list('Moved', a.moved), ...list('Slipped', a.slipped), ...list('New and dropped', a.added), ...list('KPIs', a.kpis), ...list('Changed facts', a.facts));
    const work = [...counted('Cards finished', a.cards), ...counted('Notes changed', a.notes)];
    if (work.length) out.push('**Work**', '', ...work, '');
  }
  if (!r.areas.length) out.push('Nothing changed in any area this week.', '');
  if (r.quiet.length) out.push(`**Quiet:** ${r.quiet.join(', ')}`, '');
  if (r.unfiled.total) out.push(`**Unfiled work:** ${counted('cards finished that name no area', r.unfiled)[0]!.slice(2)}`, '');
  while (out[out.length - 1] === '') out.pop();
  out.push(REVIEW_END);
  return out.join('\n');
}

/**
 * The review file with the block in place. A new file gets a title, an empty `## Reflection`
 * for the owner, then the block. An existing file keeps every character outside the
 * markers; when it has no markers (the owner wrote the file first) the block goes at the end.
 */
export function mergeReview(existing: string | null, block: string, r: Pick<WeeklyReview, 'week' | 'from' | 'to'>): string {
  if (existing === null || !existing.trim()) {
    return [`# Weekly review ${r.week}`, '', `${r.from} to ${r.to}`, '', '## Reflection', '', '', block, ''].join('\n');
  }
  const start = existing.indexOf(REVIEW_START);
  const end = start < 0 ? -1 : existing.indexOf(REVIEW_END, start);
  if (start < 0 || end < 0) return `${existing.trimEnd()}\n\n${block}\n`;
  return existing.slice(0, start) + block + existing.slice(end + REVIEW_END.length);
}
