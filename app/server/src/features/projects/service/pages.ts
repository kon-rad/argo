import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import matter from 'gray-matter';
import type { AreaIndexRow, AreaKpi, AreaLink, AreaLinkGroup, AreaPage, ProjectPage, TrackerEvent } from '@secondbrain/contracts/projects';
import { query } from '../../../db.js';
import { settings } from '../../../settings.js';
import { day, iso, isoOrNull, Slug, TrackerError, type Stage } from './common.js';
import { inVault, listProjects } from './projects.js';
import { parseGoals } from './index.js';

/**
 * What the area and project pages read: the tracker rows (Postgres) joined with what the
 * home note says (frontmatter and the first section of its body). One function per page,
 * so the web page, a CLI and an agent's context pack can all be built on the same queries.
 *
 * Areas differ: a section the area does not have (no `kpis:`, no `style:`, no home note at
 * all) comes back empty or null and is never an error.
 */

/** Open work: what a roadmap lists and what counts as an area's active projects. */
export const OPEN_STAGES: readonly Stage[] = ['idea', 'designing', 'building', 'testing'];
const RECENT_DAYS = 14;
const RECENT_LIMIT = 40;
const KPI_READINGS = 30;
const EXCERPT_CHARS = 1200;
const GUIDE_CHARS = 20_000;
const ASSET_LIMIT = 48;
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg'];

type Frontmatter = Record<string, unknown>;
interface Note { path: string; frontmatter: Frontmatter; body: string }

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);

/**
 * A home note, read from the vault: the path itself when it is a markdown note, else the
 * README.md in that folder. Only markdown is ever read, and only inside the vault. Null
 * when there is nothing to read or the frontmatter is not valid YAML.
 */
export function readNote(vaultRoot: string, path: string | null): Note | null {
  const clean = path ? inVault(path) : null;
  if (!clean) return null;
  const rel = /\.md$/i.test(clean) ? clean : join(clean, 'README.md');
  try {
    const parsed = matter(readFileSync(join(vaultRoot, rel), 'utf8'));
    return { path: rel, frontmatter: (parsed.data ?? {}) as Frontmatter, body: parsed.content };
  } catch {
    return null;
  }
}

/** The first section of a note's body: what comes before its second heading, without the title line. */
export function firstSection(body: string, max = EXCERPT_CHARS): string | null {
  const lines = body.replace(/\r\n/g, '\n').trim().split('\n');
  if (/^#\s/.test(lines[0] ?? '')) lines.shift();
  const end = lines.findIndex((l) => /^#{1,6}\s/.test(l));
  const section = (end >= 0 ? lines.slice(0, end) : lines).join('\n').trim();
  if (!section) return null;
  return section.length > max ? `${section.slice(0, max).trimEnd()}…` : section;
}

interface KpiDef { key: string; name: string; unit: string | null; target: number | null; by: string | null; direction: 'up' | 'down' }

/** The KPIs an area defines: `kpis:` as a list of `{ key, name, unit, target, by }` (or bare keys), or a map by key. */
export function kpiDefs(frontmatter: Frontmatter): KpiDef[] {
  const raw = frontmatter.kpis;
  const entries: [string, Frontmatter][] = Array.isArray(raw)
    ? raw.map((k): [string, Frontmatter] => (typeof k === 'string' ? [k, {}] : k && typeof k === 'object' ? [String((k as Frontmatter).key ?? ''), k as Frontmatter] : ['', {}]))
    : raw && typeof raw === 'object'
      ? Object.entries(raw as Frontmatter).map(([key, v]): [string, Frontmatter] => [key, v && typeof v === 'object' ? (v as Frontmatter) : {}])
      : [];
  return entries.filter(([key]) => key).map(([key, d]) => {
    const target = typeof d.target === 'number' ? d.target : typeof d.target === 'string' && d.target.trim() !== '' && Number.isFinite(Number(d.target)) ? Number(d.target) : null;
    // YAML reads a bare 2027-03-31 as a date.
    const by = d.by instanceof Date ? d.by.toISOString().slice(0, 10) : text(d.by);
    return { key, name: text(d.name) ?? key, unit: text(d.unit), target, by, direction: d.direction === 'down' ? 'down' : 'up' };
  });
}

const onTarget = (d: KpiDef, latest: number | undefined): boolean | null =>
  d.target === null || latest === undefined ? null : d.direction === 'down' ? latest <= d.target : latest >= d.target;

/** One value of `links:` or `style:` as a link: a URL, a path in the vault, or plain text. */
function link(group: string, value: unknown, label?: string): AreaLink | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const o = value as Frontmatter;
    const target = text(o.url) ?? text(o.href) ?? text(o.path);
    return target ? link(group, target, text(o.label) ?? text(o.name) ?? text(o.title) ?? undefined) : null;
  }
  const s = text(value);
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return { text: label ?? s.replace(/^https?:\/\//i, '').replace(/\/$/, ''), href: s, path: null };
  // `owner/name` under repos is the usual shorthand for a GitHub repository.
  if (group === 'repos' && /^[\w.-]+\/[\w.-]+$/.test(s)) return { text: label ?? s, href: `https://github.com/${s}`, path: null };
  if (/^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(s) && !/\.(md|png|jpe?g|svg|pdf)$/i.test(s)) return { text: label ?? s, href: `https://${s}`, path: null };
  const path = s.includes('/') || /\.md$/i.test(s) ? inVault(s) : null;
  return { text: label ?? s, href: null, path: path ? (s.endsWith('/') ? `${path}/` : path) : null };
}

/** `links:` (or the extra keys of `style:`) as given: each key is a group, its value one link or a list of them. */
export function linkGroups(raw: unknown, skip: string[] = []): AreaLinkGroup[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const groups: AreaLinkGroup[] = [];
  for (const [group, value] of Object.entries(raw as Frontmatter)) {
    if (skip.includes(group)) continue;
    const items = (Array.isArray(value) ? value : [value]).map((v) => link(group, v)).filter((l): l is AreaLink => l !== null);
    if (items.length) groups.push({ group, items });
  }
  return groups;
}

/** `style:` of the home note. The guide is read from the index (so only an indexed note is ever shown), the images likewise. */
async function styleOf(frontmatter: Frontmatter): Promise<AreaPage['style']> {
  const raw = frontmatter.style;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const style = raw as Frontmatter;
  const guidePath = text(style.guide) ? inVault(text(style.guide)!) : null;
  const assetsPath = text(style.assets) ? inVault(text(style.assets)!) : null;
  let guide: NonNullable<AreaPage['style']>['guide'] = null;
  if (guidePath) {
    const { rows } = await query<{ body: string | null }>(`SELECT body FROM vault_files WHERE path = $1 AND is_markdown`, [guidePath]);
    const body = rows[0]?.body ?? null;
    guide = { path: guidePath, markdown: body === null ? null : body.slice(0, GUIDE_CHARS), truncated: (body?.length ?? 0) > GUIDE_CHARS };
  }
  let assets: NonNullable<AreaPage['style']>['assets'] = null;
  if (assetsPath) {
    const folder = assetsPath.replace(/\/+$/, '');
    // starts_with, not LIKE: a folder name may hold % or _.
    const { rows } = await query<{ path: string; name: string; total: number }>(
      `SELECT path, name, count(*) OVER ()::int AS total FROM vault_files
        WHERE starts_with(path, $1) AND lower(ext) = ANY($2) ORDER BY path LIMIT $3`,
      [`${folder}/`, IMAGE_EXTS, ASSET_LIMIT],
    );
    assets = { path: `${folder}/`, images: rows.map((r) => ({ path: r.path, name: r.name })), more: Math.max(0, (rows[0]?.total ?? 0) - rows.length) };
  }
  const other = linkGroups(style, ['guide', 'assets']);
  return guide || assets || other.length ? { guide, assets, other } : null;
}

interface AreaRow {
  slug: string; title: string; status: 'active' | 'parked'; division_slug: string | null; division_name: string | null; team_slug: string | null; team_name: string | null;
  lead: string | null; members: string[] | null; health: string | null; needs_owner: string | null; home_path: string | null; goals: string[];
  archived_at: Date | null; updated_at: Date; active_projects: number;
}

const AREA_SELECT = `
  SELECT a.slug, a.title, a.status, a.division_slug, d.name AS division_name, a.team_slug, t.name AS team_name, t.lead, t.members,
         a.health, a.needs_owner, a.home_path, a.goals, a.archived_at, a.updated_at,
         (SELECT count(*) FROM projects p WHERE p.area_slug = a.slug AND p.archived_at IS NULL AND p.stage = ANY($1))::int AS active_projects
    FROM areas a LEFT JOIN divisions d ON d.slug = a.division_slug LEFT JOIN teams t ON t.slug = a.team_slug`;

/**
 * Every area for the `/areas` page, archived ones included (the page hides them behind a
 * toggle): division, team, owner (the team's lead), how many projects are open, and how
 * many of its KPIs are at target when it defines any.
 */
export async function listAreas(vaultRoot: string): Promise<AreaIndexRow[]> {
  const [areas, latest] = await Promise.all([
    query<AreaRow>(`${AREA_SELECT} ORDER BY d.sort NULLS LAST, a.division_slug NULLS LAST, a.priority NULLS LAST, a.slug`, [OPEN_STAGES]),
    query<{ area_slug: string; kpi_key: string; value: number }>(
      `SELECT DISTINCT ON (area_slug, kpi_key) area_slug, kpi_key, value::float8 AS value
         FROM kpi_readings WHERE project_id IS NULL ORDER BY area_slug, kpi_key, at DESC, id DESC`,
    ),
  ]);
  const values = new Map(latest.rows.map((r) => [`${r.area_slug}/${r.kpi_key}`, r.value]));
  return areas.rows.map((a) => {
    const note = readNote(vaultRoot, a.home_path);
    const defs = note ? kpiDefs(note.frontmatter) : [];
    const judged = defs.map((d) => onTarget(d, values.get(`${a.slug}/${d.key}`)));
    return {
      slug: a.slug, title: a.title, status: a.status, division: a.division_slug, division_name: a.division_name, team: a.team_slug, team_name: a.team_name,
      owner: a.lead, health: a.health, needs_owner: a.needs_owner, description: note ? text(note.frontmatter.description) : null,
      archived_at: isoOrNull(a.archived_at), updated_at: iso(a.updated_at), active_projects: a.active_projects,
      kpis: defs.length ? { total: defs.length, with_target: judged.filter((j) => j !== null).length, on_target: judged.filter(Boolean).length } : null,
    };
  });
}

const eventView = (r: Record<string, unknown>): TrackerEvent => ({
  id: Number(r.id), at: iso(r.at), actor: String(r.actor), source: String(r.source), kind: String(r.kind), field: (r.field as string | null) ?? null,
  // A created row holds the whole new row; a list has no use for it.
  from: r.kind === 'created' ? null : (r.from_value ?? null), to: r.kind === 'created' ? null : (r.to_value ?? null),
  note: (r.note as string | null) ?? null, project: (r.project as string | null) ?? null, project_title: (r.project_title as string | null) ?? null,
});

/** The area page. 404 when there is no such area; an archived area is still shown. */
export async function areaPage(vaultRoot: string, slug: string, now = new Date()): Promise<AreaPage> {
  Slug.parse(slug);
  const found = await query<AreaRow>(`${AREA_SELECT} WHERE a.slug = $2`, [OPEN_STAGES, slug]);
  const a = found.rows[0];
  if (!a) throw new TrackerError(`no area "${slug}"`, 404);
  const note = readNote(vaultRoot, a.home_path);
  const fm = note?.frontmatter ?? {};
  const defs = kpiDefs(fm);

  const [open, recent, readings, style] = await Promise.all([
    listProjects({ area: slug, archived: Boolean(a.archived_at) }),
    query(
      `SELECT e.id, e.at, e.actor, e.source, e.kind, e.field, e.from_value, e.to_value, e.note, p.slug AS project, p.title AS project_title
         FROM tracker_events e LEFT JOIN projects p ON p.id = e.project_id
        WHERE e.area_slug = $1 AND e.at > $2 ORDER BY e.at DESC, e.id DESC LIMIT $3`,
      [slug, new Date(now.getTime() - RECENT_DAYS * 86_400_000), RECENT_LIMIT],
    ),
    defs.length
      ? query<{ kpi_key: string; value: number; at: Date }>(
          `SELECT kpi_key, value, at FROM (
             SELECT kpi_key, value::float8 AS value, at, row_number() OVER (PARTITION BY kpi_key ORDER BY at DESC, id DESC) AS n
               FROM kpi_readings WHERE area_slug = $1 AND project_id IS NULL AND kpi_key = ANY($2)
           ) r WHERE n <= $3 ORDER BY kpi_key, at, n DESC`,
          [slug, defs.map((d) => d.key), KPI_READINGS],
        )
      : Promise.resolve({ rows: [] as { kpi_key: string; value: number; at: Date }[] }),
    styleOf(fm),
  ]);

  const kpis: AreaKpi[] = defs.map((d) => {
    const series = readings.rows.filter((r) => r.kpi_key === d.key).map((r) => ({ value: r.value, at: iso(r.at) }));
    const latest = series.at(-1) ?? null;
    return { ...d, latest, on_target: onTarget(d, latest?.value), readings: series };
  });

  // Goals: what the home note says in words, then the goal codes on the tracker row with their text from the goals file.
  const said = Array.isArray(fm.goals) ? fm.goals : fm.goals === undefined || fm.goals === null ? [] : [fm.goals];
  const goalsFile = settings(vaultRoot).goalsFile;
  const master = a.goals.length && goalsFile ? parseGoals(readNote(vaultRoot, goalsFile)?.body ?? '') : [];
  const goals = [
    ...said.map((g) => text(g)).filter((g): g is string => g !== null).map((g) => ({ code: null, text: g })),
    ...a.goals.map((code) => ({ code, text: master.find((m) => m.code === code)?.goal ?? code })),
  ];

  return {
    area: {
      slug: a.slug, title: a.title, status: a.status, division: a.division_slug, division_name: a.division_name, team: a.team_slug, team_name: a.team_name,
      owner: a.lead, members: a.members ?? [], health: a.health, needs_owner: a.needs_owner, home_path: a.home_path,
      archived_at: isoOrNull(a.archived_at), updated_at: iso(a.updated_at),
    },
    home: note ? { path: note.path, description: text(fm.description), excerpt: firstSection(note.body) } : null,
    links: linkGroups(fm.links),
    style,
    goals,
    kpis,
    roadmap: open
      .filter((p) => OPEN_STAGES.includes(p.stage) && (Boolean(a.archived_at) || !p.archived_at))
      .sort((x, y) => (x.due ?? '9999').localeCompare(y.due ?? '9999')),
    recent: recent.rows.map(eventView),
  };
}

/** The project page: the row, its stage history, its verifications and the start of its README. 404 when there is none. */
export async function projectPage(vaultRoot: string, areaSlug: string, slug: string): Promise<ProjectPage> {
  Slug.parse(areaSlug);
  Slug.parse(slug);
  const { rows } = await query(
    `SELECT p.*, a.title AS area_title, a.archived_at AS area_archived_at, a.home_path
       FROM projects p JOIN areas a ON a.slug = p.area_slug WHERE p.area_slug = $1 AND p.slug = $2`,
    [areaSlug, slug],
  );
  const p = rows[0];
  if (!p) throw new TrackerError(`no project "${areaSlug}/${slug}"`, 404);
  const [stages, verifs] = await Promise.all([
    query(`SELECT from_stage, to_stage, at, by, note FROM stage_changes WHERE project_id = $1 ORDER BY at DESC, id DESC LIMIT 100`, [p.id]),
    query(`SELECT kind, check_run, result, evidence, at, by FROM verifications WHERE project_id = $1 ORDER BY at DESC, id DESC LIMIT 30`, [p.id]),
  ]);
  // The project's own note, else the README the area's home would hold for it.
  const home = p.home_path ? inVault(p.home_path) : null;
  const note =
    readNote(vaultRoot, p.notes_path) ??
    (home ? readNote(vaultRoot, join(/\.md$/i.test(home) ? dirname(home) : home, 'projects', slug)) : null);
  return {
    project: {
      area: p.area_slug, slug: p.slug, title: p.title, outcome: p.outcome, next_action: p.next_action, stage: p.stage, owner: p.owner, due: day(p.due),
      needs_owner: p.needs_owner, notes_path: p.notes_path, archived_at: isoOrNull(p.archived_at), updated_at: iso(p.updated_at),
      area_title: p.area_title, health: p.health, blocked_on: p.blocked_on, started: day(p.started), shipped_at: day(p.shipped_at),
      area_archived: Boolean(p.area_archived_at),
    },
    stages: stages.rows.map((s) => ({ from: s.from_stage, to: s.to_stage, at: iso(s.at), by: s.by, note: s.note })),
    verifications: verifs.rows.map((v) => ({ kind: v.kind, check: v.check_run, result: v.result, evidence: v.evidence, at: iso(v.at), by: v.by })),
    readme: note ? { path: note.path, excerpt: firstSection(note.body) } : null,
  };
}
