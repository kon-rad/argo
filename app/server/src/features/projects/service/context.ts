import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import matter from 'gray-matter';
import type { AreaContext, AreaContextEvent, AreaContextKpi } from '@secondbrain/contracts/projects';
import { query } from '../../../db.js';
import { day, iso, Slug, TrackerError } from './common.js';
import { inVault } from './projects.js';

/**
 * The context pack of an area: what an agent with a ticket on it needs before it starts.
 * What the area is, its links, its style guides and assets, its goals and KPIs, the roadmap
 * (the open projects, by due date) and what happened in the last 14 days. `cli-areas show`
 * prints it and `GET /api/areas/:slug/context` returns the same JSON.
 *
 * The pack names paths and never inlines a file: an agent opens only what its ticket needs.
 * The fixed facts come from Postgres; everything that differs per area comes from the
 * frontmatter of the area's home note, passed through as the owner wrote it.
 */

export const RECENT_DAYS = 14;
/** The text form stays under this many characters, about 2,000 tokens. */
export const TEXT_BUDGET = 8000;
/** The stages a roadmap item can be in: a project that is not shipped, parked or done. */
const OPEN_STAGES = ['idea', 'designing', 'building', 'testing'];
/** How many rows of each list the JSON carries; the `*_total` next to a list says how many there are. */
const LIST_CAP = { roadmap: 30, events: 30, cards: 20, files: 30, verifications: 5 };
const EXCERPT_CHARS = 600;
const NAMED_ONLY = new Set(['created', 'archived', 'unarchived']);

export interface HomeNote {
  /** Vault-relative path of the note. */
  path: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

/** The note a `home_path` names: itself when it is a note, else the README.md in that folder. Null when there is none. */
export function homeNotePath(homePath: string | null): string | null {
  const home = homePath ? inVault(homePath) : null;
  if (!home) return null;
  return /\.md$/i.test(home) ? home : join(home, 'README.md');
}

/** The folder an area's files live in: `home_path` itself, or the folder of the home note. Null for a note at the vault root. */
export function homeFolder(homePath: string | null): string | null {
  const home = homePath ? inVault(homePath) : null;
  if (!home) return null;
  const dir = /\.md$/i.test(home) ? dirname(home) : home;
  return dir === '.' ? null : dir.replace(/\/+$/, '');
}

/** Reads a note's frontmatter and body. Null when the file is missing; an unreadable frontmatter reads as none. */
export function readNote(vaultRoot: string, rel: string | null): HomeNote | null {
  if (!rel) return null;
  let text: string;
  try {
    text = readFileSync(join(vaultRoot, rel), 'utf8');
  } catch {
    return null;
  }
  try {
    const m = matter(text);
    return { path: rel, frontmatter: (m.data ?? {}) as Record<string, unknown>, body: m.content };
  } catch {
    return { path: rel, frontmatter: {}, body: text.replace(/^---\n[\s\S]*?\n---\n?/, '') };
  }
}

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…` : s);

/** The body's first section: the prose under the title, up to the next heading, on one line per paragraph. */
export function firstSection(body: string, max = EXCERPT_CHARS): string | null {
  const paragraphs: string[][] = [];
  let open = false;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (/^#{1,6}\s/.test(line)) {
      if (paragraphs.length) break;
      continue;
    }
    if (!line) {
      open = false;
      continue;
    }
    if (!open) paragraphs.push([]);
    open = true;
    paragraphs[paragraphs.length - 1]!.push(line);
  }
  const text = paragraphs.map((p) => p.join(' ')).join('\n\n');
  return text ? clip(text, max) : null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
/** YAML reads a bare 2027-03-31 as a date at UTC midnight; anything else is kept as the text it was. */
const dateish = (v: unknown): string | null => (v instanceof Date ? v.toISOString().slice(0, 10) : str(v));

export interface KpiDef {
  key: string;
  name: string | null;
  unit: string | null;
  target: number | null;
  by: string | null;
}

/** The KPIs an area defines in its `kpis:` frontmatter: a list of `{ key, name, unit, target, by }` (or bare keys), or a map by key. */
export function kpiDefs(frontmatter: Record<string, unknown>): KpiDef[] {
  const kpis = frontmatter.kpis;
  const def = (key: string, v: unknown): KpiDef => {
    const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
    return { key, name: str(o.name), unit: str(o.unit), target: num(o.target), by: dateish(o.by) };
  };
  if (Array.isArray(kpis)) {
    return kpis
      .map((k) => (typeof k === 'string' ? def(k, null) : k && typeof k === 'object' ? def(String((k as Record<string, unknown>).key ?? ''), k) : def('', null)))
      .filter((k) => k.key);
  }
  return kpis && typeof kpis === 'object' ? Object.entries(kpis).map(([key, v]) => def(key, v)) : [];
}

/** A frontmatter value as plain JSON: what the owner wrote, with YAML dates as days. */
function plain(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}
const given = (v: unknown): unknown => (v === undefined || v === null || v === '' ? null : plain(v));

/**
 * Builds the pack. `project` adds the project section: its row, an excerpt of its README
 * and its newest verifications. An unknown area or project is a 404.
 */
export async function buildAreaContext(vaultRoot: string, areaSlug: string, opts: { project?: string | null; now?: Date } = {}): Promise<AreaContext> {
  Slug.parse(areaSlug);
  if (opts.project) Slug.parse(opts.project);
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - RECENT_DAYS * 86_400_000);

  const a = (
    await query(
      `SELECT slug, title, status, team_slug, division_slug, home_path, design_path, devlog_path, goals, repos, paths, needs_owner, blocked_on, archived_at
         FROM areas WHERE slug = $1`,
      [areaSlug],
    )
  ).rows[0];
  if (!a) throw new TrackerError(`no area "${areaSlug}" (cli-areas list)`, 404);

  const note = readNote(vaultRoot, homeNotePath(a.home_path));
  const fm = note?.frontmatter ?? {};
  const folder = homeFolder(a.home_path);

  const defs = kpiDefs(fm);
  let kpis: AreaContextKpi[] | undefined;
  if (defs.length) {
    const latest = await query<{ kpi_key: string; value: number; at: Date }>(
      `SELECT DISTINCT ON (kpi_key) kpi_key, value::float8 AS value, at FROM kpi_readings
        WHERE area_slug = $1 AND project_id IS NULL AND at <= $2 ORDER BY kpi_key, at DESC, id DESC`,
      [areaSlug, now],
    );
    const by = new Map(latest.rows.map((r) => [r.kpi_key, r]));
    kpis = defs.map((d) => {
      const r = by.get(d.key);
      return { ...d, latest: r ? { value: r.value, at: iso(r.at) } : null };
    });
  }

  const roadmap = await query(
    `SELECT slug, title, outcome, stage, due, next_action, owner, notes_path, count(*) OVER ()::int AS total
       FROM projects WHERE area_slug = $1 AND archived_at IS NULL AND stage = ANY($2)
      ORDER BY due NULLS LAST, sort, id LIMIT $3`,
    [areaSlug, OPEN_STAGES, LIST_CAP.roadmap],
  );

  const events = await query(
    `SELECT e.at, e.actor, p.slug AS project, e.kind, e.field, e.from_value, e.to_value, e.note, count(*) OVER ()::int AS total
       FROM tracker_events e LEFT JOIN projects p ON p.id = e.project_id
      WHERE e.area_slug = $1 AND e.at >= $2 AND e.at <= $3
      ORDER BY e.at DESC, e.id DESC LIMIT $4`,
    [areaSlug, since, now, LIST_CAP.events],
  );

  const cards = await query(
    `SELECT id, title, project_slug, assignee, completed_at, count(*) OVER ()::int AS total
       FROM cards WHERE area_slug = $1 AND status IN ('done', 'archived') AND completed_at >= $2 AND completed_at <= $3
      ORDER BY completed_at DESC, id LIMIT $4`,
    [areaSlug, since, now, LIST_CAP.cards],
  );

  const files = folder
    ? await query(
        `SELECT path, mtime, count(*) OVER ()::int AS total FROM vault_files
          WHERE starts_with(path, $1) AND mtime >= $2 AND mtime <= $3 ORDER BY mtime DESC, path LIMIT $4`,
        [`${folder}/`, since, now, LIST_CAP.files],
      )
    : { rows: [] as { path: string; mtime: Date; total: number }[] };

  const ctx: AreaContext = {
    area: {
      slug: a.slug, title: a.title, status: a.status, team: a.team_slug, division: a.division_slug,
      home_path: a.home_path, home_note: note?.path ?? null, design_path: a.design_path, devlog_path: a.devlog_path,
      repos: a.repos ?? [], paths: a.paths ?? [], goal_codes: a.goals ?? [], needs_owner: a.needs_owner, blocked_on: a.blocked_on,
      archived_at: a.archived_at ? iso(a.archived_at) : null,
    },
    description: str(fm.description),
    summary: note ? firstSection(note.body) : null,
    links: given(fm.links),
    style: given(fm.style),
    ...(given(fm.goals) !== null ? { goals: given(fm.goals) } : {}),
    ...(kpis ? { kpis } : {}),
    roadmap: roadmap.rows.map((r) => ({
      slug: r.slug, title: r.title, outcome: r.outcome, stage: r.stage, due: day(r.due), next_action: r.next_action, owner: r.owner, notes_path: r.notes_path,
    })),
    roadmap_total: roadmap.rows[0]?.total ?? 0,
    recent: {
      days: RECENT_DAYS,
      since: since.toISOString(),
      events: events.rows.map((r): AreaContextEvent => ({
        at: iso(r.at), actor: r.actor, project: r.project, kind: r.kind, field: r.field,
        // A created row holds the whole row it was created with, and an archive row the time it happened, which is `at`:
        // the pack names these and leaves their values in the log.
        from: NAMED_ONLY.has(r.kind) ? null : (r.from_value ?? null),
        to: NAMED_ONLY.has(r.kind) ? null : (r.to_value ?? null),
        note: r.note,
      })),
      events_total: events.rows[0]?.total ?? 0,
      cards: cards.rows.map((r) => ({ id: r.id, title: r.title, project: r.project_slug, assignee: r.assignee, completed_at: iso(r.completed_at) })),
      cards_total: cards.rows[0]?.total ?? 0,
      files: files.rows.map((r) => ({ path: r.path, mtime: iso(r.mtime) })),
      files_total: files.rows[0]?.total ?? 0,
    },
  };

  if (opts.project) {
    const p = (
      await query(
        `SELECT id, slug, title, outcome, stage, due, owner, next_action, notes_path, needs_owner, blocked_on, archived_at
           FROM projects WHERE area_slug = $1 AND slug = $2`,
        [areaSlug, opts.project],
      )
    ).rows[0];
    if (!p) throw new TrackerError(`no project "${areaSlug}/${opts.project}" (cli-projects list --area ${areaSlug})`, 404);
    const v = await query(
      `SELECT kind, check_run, result, evidence, at, by, count(*) OVER ()::int AS total
         FROM verifications WHERE project_id = $1 ORDER BY at DESC, id DESC LIMIT $2`,
      [p.id, LIST_CAP.verifications],
    );
    const readme = readNote(vaultRoot, p.notes_path ? inVault(p.notes_path) : null);
    ctx.project = {
      slug: p.slug, title: p.title, outcome: p.outcome, stage: p.stage, due: day(p.due), owner: p.owner, next_action: p.next_action,
      notes_path: p.notes_path, needs_owner: p.needs_owner, blocked_on: p.blocked_on, archived_at: p.archived_at ? iso(p.archived_at) : null,
      excerpt: readme ? firstSection(readme.body) : null,
      verifications: v.rows.map((r) => ({ kind: r.kind, check: r.check_run, result: r.result, evidence: r.evidence ? clip(r.evidence, 300) : null, at: iso(r.at), by: r.by })),
      verifications_total: v.rows[0]?.total ?? 0,
    };
  }
  return ctx;
}

// ---------------------------------------------------------------- text

interface Limits {
  /** Rows shown of each list. */
  rows: number;
  /** Characters of one free-text field (an outcome, a next action, a note). */
  text: number;
}

const one = (s: string): string => s.replace(/\s+/g, ' ').trim();
const short = (v: unknown, max: number): string => clip(one(typeof v === 'string' ? v : JSON.stringify(v) ?? ''), max);
const md = (isoTime: string): string => isoTime.slice(5, 10);
const more = (shown: number, total: number): string[] => (total > shown ? [`- ... and ${total - shown} more`] : []);

/** A frontmatter value as bullet lines: a map is one line per key, a list one line per item, anything else one line. */
function bullets(v: unknown, l: Limits): string[] {
  if (Array.isArray(v)) return [...v.slice(0, l.rows).map((x) => `- ${short(x, l.text)}`), ...more(Math.min(v.length, l.rows), v.length)];
  if (v && typeof v === 'object') {
    const entries = Object.entries(v);
    return [
      ...entries.slice(0, l.rows).map(([k, x]) => `- ${k}: ${Array.isArray(x) ? clip(x.map((i) => short(i, l.text)).join(', '), l.text * 2) : short(x, l.text)}`),
      ...more(Math.min(entries.length, l.rows), entries.length),
    ];
  }
  return [`- ${short(v, l.text * 2)}`];
}

function eventLine(e: AreaContextEvent, l: Limits): string {
  const who = e.project ?? 'area';
  const val = (v: unknown): string => (v === null || v === undefined ? 'none' : short(v, Math.min(l.text, 60)));
  const what =
    e.kind === 'created' ? 'created'
      : e.kind === 'archived' || e.kind === 'unarchived' ? e.kind
        : e.kind === 'frontmatter' ? `frontmatter ${e.field ?? ''} changed`
          : e.kind === 'kpi_reading' ? `KPI ${e.field ?? ''} = ${val(e.to)}`
            : `${e.field ?? e.kind}: ${val(e.from)} -> ${val(e.to)}`;
  const note = e.note && e.kind !== 'frontmatter' && e.kind !== 'created' ? ` "${short(e.note, Math.min(l.text, 80))}"` : '';
  return `- ${md(e.at)} ${who}: ${what} (${e.actor})${note}`;
}

function kpiLine(k: AreaContextKpi): string {
  const unit = k.unit ? ` ${k.unit}` : '';
  const reading = k.latest ? `${k.latest.value}${unit} on ${k.latest.at.slice(0, 10)}` : 'no reading yet';
  const target = k.target !== null ? `, target ${k.target}${unit}${k.by ? ` by ${k.by}` : ''}` : '';
  return `- ${k.name ?? k.key} (${k.key}): ${reading}${target}`;
}

function renderWith(c: AreaContext, l: Limits): string {
  const a = c.area;
  const out: string[] = [`# ${a.title} (${a.slug})`, `Area, ${a.status}${a.archived_at ? ', archived' : ''}${a.team ? `, team ${a.team}` : ''}${a.division ? `, division ${a.division}` : ''}`];
  if (c.description) out.push('', clip(one(c.description), 400));
  if (c.summary) out.push('', c.summary);
  const paths = [
    a.home_note ? `home note ${a.home_note}` : a.home_path ? `home ${a.home_path}` : null,
    a.design_path ? `design ${a.design_path}` : null,
    a.devlog_path ? `dev log ${a.devlog_path}` : null,
    ...a.paths.slice(0, l.rows).map((p) => p),
  ].filter(Boolean);
  if (paths.length) out.push('', `Paths: ${paths.join(', ')}`);
  if (a.repos.length) out.push(`Repos: ${a.repos.slice(0, l.rows).join(', ')}`);
  if (a.needs_owner) out.push(`Needs the owner: ${short(a.needs_owner, l.text)}`);
  if (a.blocked_on) out.push(`Blocked on: ${short(a.blocked_on, l.text)}`);

  if (c.links !== null) out.push('', '## Links', ...bullets(c.links, l));
  if (c.style !== null) out.push('', '## Style and assets (paths, open what you need)', ...bullets(c.style, l));
  if (c.goals !== undefined || a.goal_codes.length) {
    out.push('', '## Goals');
    if (c.goals !== undefined) out.push(...bullets(c.goals, l));
    if (a.goal_codes.length) out.push(`- Goal codes: ${a.goal_codes.join(', ')}`);
  }
  if (c.kpis) out.push('', '## KPIs', ...c.kpis.slice(0, l.rows).map(kpiLine), ...more(Math.min(c.kpis.length, l.rows), c.kpis.length));

  out.push('', `## Roadmap (${c.roadmap_total} open ${c.roadmap_total === 1 ? 'project' : 'projects'}, by due date)`);
  const road = c.roadmap.slice(0, l.rows);
  for (const p of road) {
    const outcome = p.outcome && p.outcome !== p.title ? `: ${short(p.outcome, l.text)}` : '';
    out.push(`- ${p.slug} [${p.stage}${p.due ? `, due ${p.due}` : ''}${p.owner ? `, ${p.owner}` : ''}] ${short(p.title, 80)}${outcome}${p.next_action ? `. Next: ${short(p.next_action, l.text)}` : ''}`);
  }
  if (!road.length) out.push('- none');
  out.push(...more(road.length, c.roadmap_total));

  const r = c.recent;
  out.push('', `## Recent (${r.days} days, since ${r.since.slice(0, 10)})`);
  if (!r.events_total && !r.cards_total && !r.files_total) out.push('Nothing changed.');
  if (r.events_total) {
    const ev = r.events.slice(0, l.rows);
    out.push(`Changes (${r.events_total}):`, ...ev.map((e) => eventLine(e, l)), ...more(ev.length, r.events_total));
  }
  if (r.cards_total) {
    const cs = r.cards.slice(0, l.rows);
    out.push(`Finished cards (${r.cards_total}):`, ...cs.map((k) => `- ${md(k.completed_at)} ${k.id} ${short(k.title, l.text)}${k.project ? ` (${k.project})` : ''}`), ...more(cs.length, r.cards_total));
  }
  if (r.files_total) {
    const fs = r.files.slice(0, l.rows);
    out.push(`Files changed (${r.files_total}):`, ...fs.map((f) => `- ${md(f.mtime)} ${f.path}`), ...more(fs.length, r.files_total));
  }

  const p = c.project;
  if (p) {
    out.push('', `## Project: ${p.title} (${a.slug}/${p.slug})`, `Stage ${p.stage}${p.archived_at ? ', archived' : ''}${p.due ? `, due ${p.due}` : ''}${p.owner ? `, owner ${p.owner}` : ''}`);
    if (p.outcome) out.push(`Outcome: ${short(p.outcome, l.text * 2)}`);
    if (p.next_action) out.push(`Next: ${short(p.next_action, l.text * 2)}`);
    if (p.needs_owner) out.push(`Needs the owner: ${short(p.needs_owner, l.text)}`);
    if (p.blocked_on) out.push(`Blocked on: ${short(p.blocked_on, l.text)}`);
    if (p.notes_path) out.push(`Notes: ${p.notes_path}`);
    if (p.excerpt) out.push('', clip(p.excerpt, l.text * 3), '');
    if (p.verifications_total) {
      const vs = p.verifications.slice(0, l.rows);
      out.push(`Verifications (${p.verifications_total}, newest first):`, ...vs.map((v) => `- ${v.at.slice(0, 10)} ${v.result} ${v.kind}: ${short(v.check, l.text)}`), ...more(vs.length, p.verifications_total));
    } else {
      out.push('Verifications: none');
    }
  }
  return `${out.join('\n')}\n`;
}

/**
 * The pack as text. Lists are cut with a count of what was left out, and a busy area is
 * rendered with shorter lists until the whole pack fits the budget.
 */
export function renderContextText(c: AreaContext, budget = TEXT_BUDGET): string {
  let l: Limits = { rows: 12, text: 160 };
  let text = renderWith(c, l);
  while (text.length > budget && (l.rows > 3 || l.text > 60)) {
    l = { rows: Math.max(3, Math.floor(l.rows * 0.7)), text: Math.max(60, Math.floor(l.text * 0.7)) };
    text = renderWith(c, l);
  }
  return text.length > budget ? `${text.slice(0, budget - 40).trimEnd()}\n... (cut to fit; --format json has the rest)\n` : text;
}
