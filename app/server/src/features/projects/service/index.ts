import { readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { z } from 'zod';
import { query } from '../../../db.js';
import { settings } from '../../../settings.js';
import { AreaPatch, upsertArea } from './areas.js';
import {
  AREA_STATUSES, day, daysBetween, DivisionInput, emptyCounts, IN_FLIGHT, iso, isoOrNull, SHIPPED, Slug, STAGES, STALE_DAYS, TeamInput, Text,
  upsertDivision, upsertTeam, type AreaStatus, type Stage,
} from './common.js';
import { ProjectPatch, upsertProject, VerificationInput } from './projects.js';

/**
 * The tracker: teams own areas, areas hold projects, and every project moves through one
 * stage list. Areas are what you run (./areas.ts), projects are what you finish
 * (./projects.ts); this file is what reads both: the board, the report and the kiosk feed.
 * Status is records (Postgres); the why and the how stay in markdown (home notes, design
 * docs, dev logs). Goals stay in the goals file (`goalsFile` in secondbrain.json) and are
 * linked by code (W1, M2, Q1, Y3).
 */

export * from './common.js';
export * from './areas.js';
export * from './projects.js';

export const Seed = z.object({
  divisions: z.array(DivisionInput.extend({ slug: Slug })).default([]),
  teams: z.array(TeamInput.extend({ slug: Slug })).default([]),
  areas: z
    .array(
      AreaPatch.extend({
        slug: Slug,
        title: Text.max(200),
        projects: z
          .array(
            ProjectPatch.extend({
              slug: Slug,
              title: Text.max(200),
              /** Evidence that already exists (a dev log's test run), with its real date. */
              verifications: z.array(VerificationInput.extend({ at: z.string().datetime({ offset: true }).optional() })).default([]),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
});
export type Seed = z.infer<typeof Seed>;

const OLD_STAGE = new Set<string>(STAGES);

/**
 * A seed file written before the rename says `projects: [{ stage, features: [...] }]`.
 * Read it as areas and projects: the stage becomes a status (parked stays parked, anything
 * else is active), and the fields an area no longer has (`due`, the free-text `area`) are dropped.
 */
export function seedFromOldShape(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const doc = raw as Record<string, unknown>;
  if (doc.areas !== undefined || !Array.isArray(doc.projects)) return raw;
  const { projects, ...rest } = doc;
  return {
    ...rest,
    areas: projects.map((p) => {
      if (!p || typeof p !== 'object') return p;
      const { stage, features, due: _due, area: _area, ...area } = p as Record<string, unknown>;
      return {
        ...area,
        ...(typeof stage === 'string' && OLD_STAGE.has(stage) ? { status: stage === 'parked' ? 'parked' : 'active' } : stage !== undefined ? { status: stage } : {}),
        projects: features ?? [],
      };
    }),
  };
}

/** Idempotent: re-importing the same file changes nothing but updated_at. */
export async function importSeed(raw: unknown, by: string): Promise<{ teams: number; areas: number; projects: number }> {
  const seed = Seed.parse(seedFromOldShape(raw));
  for (const d of seed.divisions) await upsertDivision(d.slug, d);
  for (const t of seed.teams) await upsertTeam(t.slug, t);
  let projects = 0;
  for (const a of seed.areas) {
    const { slug, projects: ps, ...patch } = a;
    await upsertArea(slug, patch, by, { create: true, imported: true });
    for (const p of ps) {
      const { slug: pslug, verifications, ...patch } = p;
      await upsertProject(slug, pslug, patch, by, { create: true, imported: true, evidence: verifications });
      projects++;
    }
  }
  return { teams: seed.teams.length, areas: seed.areas.length, projects };
}

// ---------------------------------------------------------------- reads

export interface Verification {
  kind: string;
  check: string;
  result: 'pass' | 'fail';
  evidence: string | null;
  at: string;
  by: string | null;
}

export interface ProjectView {
  id: number;
  area: string;
  slug: string;
  title: string;
  outcome: string | null;
  next_action: string | null;
  stage: Stage;
  health: string | null;
  owner: string | null;
  goals: string[];
  needs_owner: string | null;
  blocked_on: string | null;
  started: string | null;
  due: string | null;
  shipped_at: string | null;
  notes_path: string | null;
  archived_at: string | null;
  updated_at: string;
  updated_by: string | null;
  days_in_stage: number;
  last_activity: string;
  verification: Verification | null;
  verifications_total: number;
}

export interface AreaView {
  slug: string;
  title: string;
  team: string | null;
  division: string | null;
  status: AreaStatus;
  health: string | null;
  priority: number | null;
  goals: string[];
  needs_owner: string | null;
  blocked_on: string | null;
  started: string | null;
  devlog_path: string | null;
  design_path: string | null;
  home_path: string | null;
  paths: string[];
  repos: string[];
  archived_at: string | null;
  updated_at: string;
  updated_by: string | null;
  /** From the `## Resume` block of the area's dev-log README. */
  next_action: string | null;
  projects: ProjectView[];
  counts: Record<Stage, number>;
  /** Shipped (live + done) over every project that isn't parked. */
  progress: number | null;
}

export interface DivisionView {
  slug: string;
  name: string;
  mission: string | null;
  head: string | null;
}

export interface TeamView {
  slug: string;
  name: string;
  mission: string | null;
  lead: string | null;
  members: string[];
}

export interface Goal {
  code: string;
  horizon: string;
  goal: string;
  due: string | null;
  status: string;
}

export interface StageChangeView {
  area: string;
  /** NULL: the area itself changed (its status, or archived). */
  project: string | null;
  title: string;
  from: string | null;
  to: string;
  at: string;
  by: string | null;
  note: string | null;
}

export interface Board {
  divisions: DivisionView[];
  teams: TeamView[];
  areas: AreaView[];
  goals: Goal[];
  recent: StageChangeView[];
  as_of: string | null;
}

/** The `- **Next action:**` line of a dev-log README's `## Resume` block. */
export function nextActionFrom(markdown: string): string | null {
  const block = /^## Resume\s*\n([\s\S]*?)(?=^## |^---|$(?![\s\S]))/m.exec(markdown)?.[1];
  if (!block) return null;
  const m = /^-\s*\*\*Next action:\*\*\s*(.+)$/m.exec(block);
  return m ? m[1]!.trim() : null;
}

function readVault(vaultRoot: string, rel: string | null): string | null {
  if (!rel) return null;
  const clean = normalize(rel).replace(/^\/+/, '');
  if (clean.startsWith('..')) return null;
  try {
    return readFileSync(join(vaultRoot, clean), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Goal rows from the goals file: `| W1 | Goal | Measure | Due | Status |`
 * under "This week / month / quarter / year", and `| T1 | Goal |` for ten years.
 */
export function parseGoals(markdown: string): Goal[] {
  const goals: Goal[] = [];
  let horizon = '';
  for (const line of markdown.split('\n')) {
    const h = /^##\s+(.+)$/.exec(line);
    if (h) {
      horizon = h[1]!.replace(/\s*\(.*\)\s*$/, '').trim();
      continue;
    }
    const m = /^\|\s*([WMQYT]\d{1,2})\s*\|(.*)\|\s*$/.exec(line);
    if (!m) continue;
    const cells = m[2]!.split(/(?<!\\)\|/).map((c) => c.trim());
    const isTen = m[1]!.startsWith('T');
    goals.push({
      code: m[1]!,
      horizon,
      goal: cells[0]!.replace(/\*\*/g, ''),
      due: isTen ? null : (cells[2] ?? null),
      status: isTen ? 'long-term' : (cells[3] ?? 'not reported'),
    });
  }
  return goals;
}

/**
 * Everything the board shows. Archived areas (with their projects) and archived projects
 * are left out unless `archived` is set, so every view built on this is an active view.
 */
export async function getBoard(vaultRoot: string, now = new Date(), opts: { archived?: boolean } = {}): Promise<Board> {
  const hide = !opts.archived;
  const [divisions, teams, areas, projects, verifs, moves, recent] = await Promise.all([
    query(`SELECT slug, name, mission, head FROM divisions ORDER BY sort, slug`),
    query(`SELECT slug, name, mission, lead, members FROM teams ORDER BY sort, slug`),
    query(`SELECT * FROM areas ${hide ? 'WHERE archived_at IS NULL' : ''} ORDER BY priority NULLS LAST, slug`),
    query(`SELECT * FROM projects ${hide ? 'WHERE archived_at IS NULL' : ''} ORDER BY area_slug, sort, id`),
    query(
      `SELECT DISTINCT ON (project_id) project_id, kind, check_run, result, evidence, at, by,
              count(*) OVER (PARTITION BY project_id) AS total
         FROM verifications ORDER BY project_id, at DESC, id DESC`,
    ),
    // The last stage move of each project. Archiving is not a stage move, so it does not reset the clock.
    query(
      `SELECT DISTINCT ON (project_id) project_id, at
         FROM stage_changes WHERE project_id IS NOT NULL AND to_stage NOT IN ('archived', 'unarchived')
        ORDER BY project_id, at DESC, id DESC`,
    ),
    query(
      `SELECT s.area_slug, p.slug AS project, coalesce(p.title, a.title) AS title, s.from_stage, s.to_stage, s.at, s.by, s.note
         FROM stage_changes s JOIN areas a ON a.slug = s.area_slug LEFT JOIN projects p ON p.id = s.project_id
        WHERE s.at > $1 AND coalesce(s.note, '') NOT LIKE 'imported%' AND coalesce(s.note, '') NOT LIKE 'para-rename:%'
          ${hide ? 'AND (a.archived_at IS NULL OR s.to_stage = \'archived\') AND (p.archived_at IS NULL OR s.to_stage = \'archived\')' : ''}
        ORDER BY s.at DESC, s.id DESC LIMIT 50`,
      [new Date(now.getTime() - 7 * 86_400_000)],
    ),
  ]);

  const lastMove = new Map<number, string>();
  for (const r of moves.rows) lastMove.set(Number(r.project_id), iso(r.at));
  const lastVerif = new Map<number, Verification & { total: number }>();
  for (const r of verifs.rows) {
    lastVerif.set(Number(r.project_id), {
      kind: r.kind, check: r.check_run, result: r.result, evidence: r.evidence, at: iso(r.at), by: r.by, total: Number(r.total),
    });
  }

  const byArea = new Map<string, ProjectView[]>();
  for (const p of projects.rows) {
    const v = lastVerif.get(Number(p.id)) ?? null;
    const moved = lastMove.get(Number(p.id)) ?? iso(p.created_at);
    const activity = [iso(p.updated_at), moved, v?.at].filter(Boolean).sort().at(-1)!;
    const view: ProjectView = {
      id: Number(p.id), area: p.area_slug, slug: p.slug, title: p.title, outcome: p.outcome, next_action: p.next_action, stage: p.stage,
      health: p.health, owner: p.owner, goals: p.goals,
      needs_owner: p.needs_owner, blocked_on: p.blocked_on, started: day(p.started), due: day(p.due),
      shipped_at: day(p.shipped_at), notes_path: p.notes_path, archived_at: isoOrNull(p.archived_at), updated_at: iso(p.updated_at), updated_by: p.updated_by,
      days_in_stage: daysBetween(moved, now), last_activity: activity,
      verification: v ? { kind: v.kind, check: v.check, result: v.result, evidence: v.evidence, at: v.at, by: v.by } : null,
      verifications_total: v?.total ?? 0,
    };
    const list = byArea.get(p.area_slug) ?? [];
    list.push(view);
    byArea.set(p.area_slug, list);
  }

  const areaViews: AreaView[] = areas.rows.map((a) => {
    const ps = byArea.get(a.slug) ?? [];
    const counts = emptyCounts();
    for (const p of ps) counts[p.stage]++;
    const denom = ps.length - counts.parked;
    return {
      slug: a.slug, title: a.title, team: a.team_slug, division: a.division_slug, status: a.status, health: a.health, priority: a.priority,
      goals: a.goals, needs_owner: a.needs_owner, blocked_on: a.blocked_on, started: day(a.started),
      devlog_path: a.devlog_path, design_path: a.design_path, home_path: a.home_path, paths: a.paths, repos: a.repos,
      archived_at: isoOrNull(a.archived_at), updated_at: iso(a.updated_at), updated_by: a.updated_by,
      next_action: nextActionFrom(readVault(vaultRoot, a.devlog_path) ?? ''),
      projects: ps, counts, progress: denom > 0 ? (counts.live + counts.done) / denom : null,
    };
  });

  const goalsFile = settings(vaultRoot).goalsFile;
  const goalsText = goalsFile ? readVault(vaultRoot, goalsFile) : null;
  const asOf = areaViews.map((a) => a.updated_at).sort().at(-1) ?? null;
  return {
    divisions: divisions.rows.map((d) => ({ slug: d.slug, name: d.name, mission: d.mission, head: d.head })),
    teams: teams.rows.map((t) => ({ slug: t.slug, name: t.name, mission: t.mission, lead: t.lead, members: t.members })),
    areas: areaViews,
    goals: goalsText ? parseGoals(goalsText) : [],
    recent: recent.rows.map((r) => ({
      area: r.area_slug, project: r.project, title: r.title, from: r.from_stage, to: r.to_stage, at: iso(r.at), by: r.by, note: r.note,
    })),
    as_of: asOf,
  };
}

// ---------------------------------------------------------------- report

export interface Item {
  area: string;
  project: string | null;
  title: string;
  detail: string;
}

export interface Rollup {
  slug: string;
  name: string;
  areas: string[];
  in_flight: number;
  shipped_7d: number;
  needs_owner: number;
  /** Areas in each status. */
  statuses: Record<AreaStatus, number>;
}

export interface Report {
  as_of: string | null;
  generated_at: string;
  totals: { areas: Record<AreaStatus, number>; projects: Record<Stage, number> };
  needs_owner: (Item & { priority: number | null; due: string | null })[];
  divisions: Rollup[];
  teams: (Rollup & { lead: string | null })[];
  goals: (Goal & { areas: string[]; projects: string[] })[];
  gaps: {
    goals_uncovered: (Goal & { areas: string[]; projects: string[] })[];
    unverified_shipped: Item[];
    failing: Item[];
    testing_unverified: Item[];
    stale: Item[];
    overdue: Item[];
    no_team: string[];
    no_division: string[];
    no_projects: string[];
  };
  oldest: Item[];
  backlog: { total: number; by_area: { area: string; count: number; oldest_days: number }[] };
  moved_7d: StageChangeView[];
  shipped_7d: Item[];
  verified_7d: { pass: number; fail: number };
  areas: AreaView[];
}

const OPEN_GOAL = (g: Goal): boolean => !/^(done|cancelled)/i.test(g.status) && g.horizon !== '' && !g.code.startsWith('T');
const emptyStatuses = (): Record<AreaStatus, number> => Object.fromEntries(AREA_STATUSES.map((s) => [s, 0])) as Record<AreaStatus, number>;

/** The company report. Archived areas and projects are left out unless `archived` is set. */
export async function buildReport(vaultRoot: string, now = new Date(), opts: { archived?: boolean } = {}): Promise<Report> {
  const board = await getBoard(vaultRoot, now, opts);
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const today = now.toISOString().slice(0, 10);
  const { rows: vrows } = await query<{ result: string; n: number }>(
    `SELECT result, count(*)::int AS n FROM verifications WHERE at > $1 GROUP BY result`,
    [weekAgo],
  );
  const verified = { pass: 0, fail: 0 };
  for (const r of vrows) verified[r.result as 'pass' | 'fail'] = r.n;

  const totals = { areas: emptyStatuses(), projects: emptyCounts() };
  const needs: Report['needs_owner'] = [];
  const gaps: Report['gaps'] = {
    goals_uncovered: [], unverified_shipped: [], failing: [], testing_unverified: [], stale: [], overdue: [], no_team: [], no_division: [], no_projects: [],
  };
  const oldest: (Item & { days: number })[] = [];
  const backlog: Report['backlog'] = { total: 0, by_area: [] };
  const shipped7: Item[] = [];
  const goalLinks = new Map<string, { areas: Set<string>; projects: Set<string> }>();
  const link = (code: string) => goalLinks.get(code) ?? goalLinks.set(code, { areas: new Set(), projects: new Set() }).get(code)!;

  for (const a of board.areas) {
    totals.areas[a.status]++;
    for (const g of a.goals) link(g).areas.add(a.slug);
    if (a.needs_owner) needs.push({ area: a.slug, project: null, title: a.title, detail: a.needs_owner, priority: a.priority, due: null });
    if (!a.team) gaps.no_team.push(a.slug);
    if (!a.division) gaps.no_division.push(a.slug);
    const active = a.status === 'active';
    if (active && a.projects.length === 0) gaps.no_projects.push(a.slug);
    let ideas = 0;
    let oldestIdea = 0;
    for (const p of a.projects) {
      totals.projects[p.stage]++;
      for (const g of p.goals) link(g).projects.add(`${a.slug}/${p.slug}`);
      const item = { area: a.slug, project: p.slug, title: p.title };
      if (p.needs_owner) needs.push({ ...item, detail: p.needs_owner, priority: a.priority, due: p.due });
      if (p.stage === 'idea') {
        ideas++;
        oldestIdea = Math.max(oldestIdea, p.days_in_stage);
      }
      const shipped = SHIPPED.includes(p.stage);
      if (shipped && p.verification?.result !== 'pass') {
        gaps.unverified_shipped.push({ ...item, detail: p.verification ? 'newest verification failed' : 'no verification' });
      }
      if (p.verification?.result === 'fail' && !shipped) {
        gaps.failing.push({ ...item, detail: `${p.verification.kind}: ${p.verification.check}` });
      }
      if (p.stage === 'testing' && !p.verification) gaps.testing_unverified.push({ ...item, detail: `${p.days_in_stage}d in testing` });
      if (IN_FLIGHT.includes(p.stage)) {
        const idle = daysBetween(p.last_activity, now);
        if (idle >= STALE_DAYS) gaps.stale.push({ ...item, detail: `${p.stage}, no activity for ${idle}d` });
        oldest.push({ ...item, detail: `${p.stage} for ${p.days_in_stage}d`, days: p.days_in_stage });
        if (p.due && p.due < today) gaps.overdue.push({ ...item, detail: `due ${p.due}` });
      }
      if (p.shipped_at && p.shipped_at >= weekAgo.slice(0, 10)) shipped7.push({ ...item, detail: `shipped ${p.shipped_at}` });
    }
    if (ideas) backlog.by_area.push({ area: a.slug, count: ideas, oldest_days: oldestIdea });
    backlog.total += ideas;
  }

  needs.sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99) || (a.due ?? '9999').localeCompare(b.due ?? '9999'));
  backlog.by_area.sort((a, b) => b.count - a.count);
  oldest.sort((a, b) => b.days - a.days);

  const goals = board.goals.map((g) => {
    const l = goalLinks.get(g.code);
    return { ...g, areas: [...(l?.areas ?? [])], projects: [...(l?.projects ?? [])] };
  });
  gaps.goals_uncovered = goals.filter((g) => OPEN_GOAL(g) && g.areas.length === 0 && g.projects.length === 0);

  const rollup = (slug: string, name: string, as: AreaView[]): Rollup => {
    const ps = as.flatMap((a) => a.projects);
    return {
      slug, name, areas: as.map((a) => a.slug),
      in_flight: ps.filter((p) => IN_FLIGHT.includes(p.stage)).length,
      shipped_7d: ps.filter((p) => p.shipped_at && p.shipped_at >= weekAgo.slice(0, 10)).length,
      needs_owner: as.filter((a) => a.needs_owner).length + ps.filter((p) => p.needs_owner).length,
      statuses: as.reduce((c, a) => ({ ...c, [a.status]: c[a.status] + 1 }), emptyStatuses()),
    };
  };
  const divisions = board.divisions.map((d) => rollup(d.slug, d.name, board.areas.filter((a) => a.division === d.slug)));
  const teams = board.teams.map((t) => ({ ...rollup(t.slug, t.name, board.areas.filter((a) => a.team === t.slug)), lead: t.lead }));

  return {
    as_of: board.as_of, generated_at: now.toISOString(), totals, needs_owner: needs, divisions, teams, goals, gaps,
    oldest: oldest.slice(0, 8).map(({ days: _d, ...i }) => i), backlog, moved_7d: board.recent, shipped_7d: shipped7,
    verified_7d: verified, areas: board.areas,
  };
}

/**
 * Compact feed for a kiosk: the top areas, their projects in flight, the needs-you list.
 *
 * The kiosk is a separate device with its own code, so this payload keeps the keys it had
 * before the PARA rename: `projects` is the list of areas (each with a `stage` that now
 * carries the area's status), `features` counts the projects, and a needs-you item names
 * its area as `project` and its project as `feature`. It moves to the new words when the
 * kiosk does.
 */
export function kioskSummary(r: Report, top = 5) {
  const ranked = [...r.areas]
    .filter((a) => a.status === 'active')
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99) || b.updated_at.localeCompare(a.updated_at));
  return {
    as_of: r.as_of,
    generated_at: r.generated_at,
    totals: { projects: { ...emptyCounts(), ...r.totals.areas }, features: r.totals.projects },
    projects: ranked.slice(0, top).map((a) => ({
      slug: a.slug, title: a.title, stage: a.status, health: a.health, priority: a.priority, counts: a.counts,
      progress: a.progress, next: a.next_action ?? a.needs_owner ?? null, needs_owner: Boolean(a.needs_owner || a.projects.some((p) => p.needs_owner)),
      in_flight: a.projects.filter((p) => IN_FLIGHT.includes(p.stage)).map((p) => ({ title: p.title, stage: p.stage, days: p.days_in_stage })),
    })),
    needs_owner: r.needs_owner.map((n) => ({ project: n.area, feature: n.project, title: n.title, detail: n.detail, due: n.due })),
    gaps: {
      unverified_shipped: r.gaps.unverified_shipped.length, failing: r.gaps.failing.length, stale: r.gaps.stale.length,
      overdue: r.gaps.overdue.length, goals_uncovered: r.gaps.goals_uncovered.map((g) => g.code),
    },
    attention: [...r.gaps.failing, ...r.gaps.overdue, ...r.gaps.stale, ...r.gaps.testing_unverified]
      .slice(0, 8)
      .map((i) => ({ project: i.area, feature: i.project, title: i.title, detail: i.detail })),
    shipped_7d: r.shipped_7d.length,
    moved_7d: r.moved_7d.length,
  };
}
