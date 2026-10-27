import { readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { z } from 'zod';
import { query, withTransaction, type TxClient } from './db.js';
import { settings } from './settings.js';

/**
 * The project tracker: teams own projects, projects are made of features, and
 * every feature moves through one stage list. Status is records (Postgres);
 * the why and the how stay in markdown (design docs, dev logs). Goals stay in
 * the goals file (`goalsFile` in secondbrain.json) and are linked by code (W1, M2, Q1, Y3).
 *
 * The rule that makes "done" mean something: a feature moves to live or done
 * only when its newest verification passed, or the move says why it skipped
 * that (recorded in the stage history and shown as a gap in the report).
 *
 */

export const STAGES = ['idea', 'designing', 'building', 'testing', 'live', 'parked', 'done'] as const;
export type Stage = (typeof STAGES)[number];
export const IN_FLIGHT: readonly Stage[] = ['designing', 'building', 'testing'];
const SHIPPED: readonly Stage[] = ['live', 'done'];
export const STALE_DAYS = 7;

const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'lowercase letters, digits and dashes');
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const GoalCode = z.string().regex(/^[WMQYT]\d{1,2}$/, 'a goal code like W1, M2, Q1, Y3');
const Text = z.string().trim().min(1).max(2000);

export const DivisionInput = z.object({
  name: Text.max(100),
  mission: Text.nullish(),
  head: Text.max(100).nullish(),
  sort: z.number().int().optional(),
});

export const TeamInput = z.object({
  name: Text.max(100),
  mission: Text.nullish(),
  lead: Text.max(100).nullish(),
  members: z.array(z.string().max(100)).optional(),
  sort: z.number().int().optional(),
});

export const ProjectPatch = z
  .object({
    title: Text.max(200),
    team: Slug.nullable(),
    division: Slug.nullable(),
    venture: Slug.nullable(),
    area: Text.max(100).nullable(),
    stage: z.enum(STAGES),
    health: z.enum(['green', 'yellow', 'red']).nullable(),
    priority: z.number().int().positive().nullable(),
    goals: z.array(GoalCode),
    needs_owner: Text.nullable(),
    blocked_on: Text.nullable(),
    started: Day.nullable(),
    due: Day.nullable(),
    devlog_path: Text.nullable(),
    design_path: Text.nullable(),
    paths: z.array(z.string().max(300)),
    repos: z.array(z.string().max(200)),
    note: Text.max(500),
  })
  .partial()
  .strict();
export type ProjectPatch = z.infer<typeof ProjectPatch>;

export const FeaturePatch = z
  .object({
    title: Text.max(200),
    stage: z.enum(STAGES),
    health: z.enum(['green', 'yellow', 'red']).nullable(),
    owner: Text.max(100).nullable(),
    goals: z.array(GoalCode),
    needs_owner: Text.nullable(),
    blocked_on: Text.nullable(),
    started: Day.nullable(),
    due: Day.nullable(),
    notes_path: Text.nullable(),
    sort: z.number().int(),
    note: Text.max(500),
    /** Moving to live/done without a passing verification needs a reason. */
    unverified: Text.max(500),
  })
  .partial()
  .strict();
export type FeaturePatch = z.infer<typeof FeaturePatch>;

export const VerificationInput = z.object({
  kind: z.enum(['test', 'manual', 'deploy', 'review', 'metric']),
  check: Text.max(500),
  result: z.enum(['pass', 'fail']),
  evidence: Text.max(4000).nullish(),
});
export type VerificationInput = z.infer<typeof VerificationInput>;

export const Seed = z.object({
  divisions: z.array(DivisionInput.extend({ slug: Slug })).default([]),
  teams: z.array(TeamInput.extend({ slug: Slug })).default([]),
  projects: z
    .array(
      ProjectPatch.extend({
        slug: Slug,
        title: Text.max(200),
        stage: z.enum(STAGES),
        features: z
          .array(
            FeaturePatch.extend({
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

/** A refusal the caller can show as-is (400 in the API, exit 1 in the CLI). */
export class TrackerError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------- writes

const PROJECT_COLS: Record<string, string> = {
  title: 'title', team: 'team_slug', division: 'division_slug', venture: 'venture_slug', area: 'area', stage: 'stage', health: 'health', priority: 'priority',
  goals: 'goals', needs_owner: 'needs_owner', blocked_on: 'blocked_on', started: 'started', due: 'due',
  devlog_path: 'devlog_path', design_path: 'design_path', paths: 'paths', repos: 'repos',
};
const FEATURE_COLS: Record<string, string> = {
  title: 'title', stage: 'stage', health: 'health', owner: 'owner', goals: 'goals', needs_owner: 'needs_owner',
  blocked_on: 'blocked_on', started: 'started', due: 'due', notes_path: 'notes_path', sort: 'sort',
};

function assignments(patch: Record<string, unknown>, cols: Record<string, string>, first: number) {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, col] of Object.entries(cols)) {
    if (patch[k] === undefined) continue;
    vals.push(patch[k]);
    sets.push(`${col} = $${first + vals.length - 1}`);
  }
  return { sets, vals };
}

export async function upsertDivision(slug: string, input: z.infer<typeof DivisionInput>): Promise<void> {
  Slug.parse(slug);
  const d = DivisionInput.parse(input);
  await query(
    `INSERT INTO divisions (slug, name, mission, head, sort) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, mission = EXCLUDED.mission, head = EXCLUDED.head,
       sort = EXCLUDED.sort, updated_at = now()`,
    [slug, d.name, d.mission ?? null, d.head ?? null, d.sort ?? 0],
  );
}

export async function upsertTeam(slug: string, input: z.infer<typeof TeamInput>): Promise<void> {
  Slug.parse(slug);
  const t = TeamInput.parse(input);
  await query(
    `INSERT INTO teams (slug, name, mission, lead, members, sort) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, mission = EXCLUDED.mission, lead = EXCLUDED.lead,
       members = EXCLUDED.members, sort = EXCLUDED.sort, updated_at = now()`,
    [slug, t.name, t.mission ?? null, t.lead ?? null, t.members ?? [], t.sort ?? 0],
  );
}

async function teamMustExist(tx: TxClient, team: string | null | undefined): Promise<void> {
  if (!team) return;
  const { rowCount } = await tx.query(`SELECT 1 FROM teams WHERE slug = $1`, [team]);
  if (!rowCount) throw new TrackerError(`no team "${team}"`);
}

async function divisionMustExist(tx: TxClient, division: string | null | undefined): Promise<void> {
  if (!division) return;
  const { rowCount } = await tx.query(`SELECT 1 FROM divisions WHERE slug = $1`, [division]);
  if (!rowCount) throw new TrackerError(`no division "${division}"`);
}

/** Creates the project when `create` is set (title and stage required), else updates it. */
export async function upsertProject(
  slug: string,
  raw: ProjectPatch,
  by: string,
  opts: { create?: boolean; imported?: boolean } = {},
): Promise<{ created: boolean; stage_changed: boolean }> {
  Slug.parse(slug);
  const patch = ProjectPatch.parse(raw);
  return withTransaction(async (tx) => {
    await teamMustExist(tx, patch.team);
    await divisionMustExist(tx, patch.division);
    if (patch.venture) {
      const { rowCount } = await tx.query(`SELECT 1 FROM ventures WHERE slug = $1`, [patch.venture]);
      if (!rowCount) throw new TrackerError(`no venture "${patch.venture}"`);
    }
    const cur = await tx.query<{ stage: Stage }>(`SELECT stage FROM projects WHERE slug = $1 FOR UPDATE`, [slug]);
    if (!cur.rows[0]) {
      if (!opts.create) throw new TrackerError(`no project "${slug}" (add it first)`, 404);
      if (!patch.title || !patch.stage) throw new TrackerError('a new project needs a title and a stage');
      await tx.query(`INSERT INTO projects (slug, title, stage, updated_by) VALUES ($1,$2,$3,$4)`, [
        slug, patch.title, patch.stage, by,
      ]);
      await tx.query(
        `INSERT INTO stage_changes (project_slug, from_stage, to_stage, by, note) VALUES ($1, NULL, $2, $3, $4)`,
        [slug, patch.stage, by, [opts.imported ? 'imported' : 'added', patch.note].filter(Boolean).join(' · ')],
      );
    }
    const from = cur.rows[0]?.stage ?? patch.stage!;
    const { sets, vals } = assignments(patch, PROJECT_COLS, 3);
    await tx.query(
      `UPDATE projects SET ${[...sets, 'updated_at = now()', 'updated_by = $2'].join(', ')} WHERE slug = $1`,
      [slug, by, ...vals],
    );
    const stageChanged = Boolean(cur.rows[0] && patch.stage && patch.stage !== from);
    if (stageChanged) {
      await tx.query(
        `INSERT INTO stage_changes (project_slug, from_stage, to_stage, by, note) VALUES ($1,$2,$3,$4,$5)`,
        [slug, from, patch.stage, by, patch.note ?? null],
      );
    }
    return { created: !cur.rows[0], stage_changed: stageChanged };
  });
}

/**
 * Creates or updates a feature. A move into live or done is refused unless the
 * feature's newest verification passed, or `unverified` gives the reason,
 * which is then kept in the stage history.
 */
export async function upsertFeature(
  projectSlug: string,
  slug: string,
  raw: FeaturePatch,
  by: string,
  opts: {
    create?: boolean;
    /** From importSeed: the feature already existed before the tracker, so its ship date is unknown. */
    imported?: boolean;
    /** Existing evidence, inserted with a new feature so the stage gate sees it. */
    evidence?: (VerificationInput & { at?: string })[];
  } = {},
): Promise<{ id: number; created: boolean; stage_changed: boolean }> {
  Slug.parse(slug);
  const patch = FeaturePatch.parse(raw);
  return withTransaction(async (tx) => {
    const proj = await tx.query(`SELECT 1 FROM projects WHERE slug = $1`, [projectSlug]);
    if (!proj.rowCount) throw new TrackerError(`no project "${projectSlug}"`, 404);
    let cur = await tx.query<{ id: number; stage: Stage; shipped_at: string | null }>(
      `SELECT id, stage, shipped_at FROM features WHERE project_slug = $1 AND slug = $2 FOR UPDATE`,
      [projectSlug, slug],
    );
    let created = false;
    let from: Stage | null = cur.rows[0]?.stage ?? null;
    if (!cur.rows[0]) {
      if (!opts.create) throw new TrackerError(`no feature "${projectSlug}/${slug}" (add it first)`, 404);
      if (!patch.title) throw new TrackerError('a new feature needs a title');
      cur = await tx.query(
        `INSERT INTO features (project_slug, slug, title, stage, updated_by) VALUES ($1,$2,$3,'idea',$4)
         RETURNING id, stage, shipped_at`,
        [projectSlug, slug, patch.title, by],
      );
      created = true;
      from = null;
      for (const v of opts.evidence ?? []) {
        await tx.query(
          `INSERT INTO verifications (feature_id, kind, check_run, result, evidence, at, by)
           VALUES ($1,$2,$3,$4,$5,coalesce($6::timestamptz, now()),$7)`,
          [cur.rows[0]!.id, v.kind, v.check, v.result, v.evidence ?? null, v.at ?? null, by],
        );
      }
    }
    const feature = cur.rows[0]!;
    const to = patch.stage;
    const moving = to !== undefined && to !== from;

    let note = patch.note ?? null;
    if (moving && SHIPPED.includes(to) && !(from && SHIPPED.includes(from))) {
      const v = await tx.query<{ result: string }>(
        `SELECT result FROM verifications WHERE feature_id = $1 ORDER BY at DESC, id DESC LIMIT 1`,
        [feature.id],
      );
      const passed = v.rows[0]?.result === 'pass';
      if (!passed && !patch.unverified) {
        throw new TrackerError(
          `${projectSlug}/${slug} can't move to ${to}: ${v.rows[0] ? 'its newest verification failed' : 'it has no verification'}. ` +
            `Record one (verify --pass with the check you ran), or pass unverified with the reason.`,
          409,
        );
      }
      if (!passed) note = `UNVERIFIED: ${patch.unverified}${note ? ` · ${note}` : ''}`;
    }

    const { sets, vals } = assignments(patch, FEATURE_COLS, 3);
    if (moving && to === 'live' && !feature.shipped_at && !opts.imported) sets.push('shipped_at = CURRENT_DATE');
    await tx.query(
      `UPDATE features SET ${[...sets, 'updated_at = now()', 'updated_by = $2'].join(', ')} WHERE id = $1`,
      [feature.id, by, ...vals],
    );
    if (moving || created) {
      await tx.query(
        `INSERT INTO stage_changes (project_slug, feature_id, from_stage, to_stage, by, note) VALUES ($1,$2,$3,$4,$5,$6)`,
        [projectSlug, feature.id, from, to ?? 'idea', by, created ? [opts.imported ? 'imported' : 'added', note].filter(Boolean).join(' · ') : note],
      );
    }
    await tx.query(`UPDATE projects SET updated_at = now(), updated_by = $2 WHERE slug = $1`, [projectSlug, by]);
    return { id: feature.id, created, stage_changed: moving && !created ? true : false };
  });
}

export async function addVerification(
  projectSlug: string,
  featureSlug: string,
  raw: VerificationInput,
  by: string,
): Promise<number> {
  const v = VerificationInput.parse(raw);
  const f = await query<{ id: number }>(`SELECT id FROM features WHERE project_slug = $1 AND slug = $2`, [
    projectSlug, featureSlug,
  ]);
  if (!f.rows[0]) throw new TrackerError(`no feature "${projectSlug}/${featureSlug}"`, 404);
  const { rows } = await query<{ id: number }>(
    `INSERT INTO verifications (feature_id, kind, check_run, result, evidence, by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [f.rows[0].id, v.kind, v.check, v.result, v.evidence ?? null, by],
  );
  await query(`UPDATE features SET updated_at = now(), updated_by = $2 WHERE id = $1`, [f.rows[0].id, by]);
  return rows[0]!.id;
}

/** Idempotent: re-importing the same file changes nothing but updated_at. */
export async function importSeed(raw: unknown, by: string): Promise<{ teams: number; projects: number; features: number }> {
  const seed = Seed.parse(raw);
  for (const d of seed.divisions) await upsertDivision(d.slug, d);
  for (const t of seed.teams) await upsertTeam(t.slug, t);
  let features = 0;
  for (const p of seed.projects) {
    const { slug, features: fs, ...patch } = p;
    await upsertProject(slug, patch, by, { create: true, imported: true });
    for (const f of fs) {
      const { slug: fslug, verifications, ...patch } = f;
      await upsertFeature(slug, fslug, patch, by, { create: true, imported: true, evidence: verifications });
      features++;
    }
  }
  return { teams: seed.teams.length, projects: seed.projects.length, features };
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

export interface FeatureView {
  id: number;
  slug: string;
  title: string;
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
  updated_at: string;
  updated_by: string | null;
  days_in_stage: number;
  last_activity: string;
  verification: Verification | null;
  verifications_total: number;
}

export interface ProjectView {
  slug: string;
  title: string;
  team: string | null;
  division: string | null;
  area: string | null;
  stage: Stage;
  health: string | null;
  priority: number | null;
  goals: string[];
  needs_owner: string | null;
  blocked_on: string | null;
  started: string | null;
  due: string | null;
  devlog_path: string | null;
  design_path: string | null;
  paths: string[];
  repos: string[];
  updated_at: string;
  updated_by: string | null;
  days_in_stage: number;
  next_action: string | null;
  features: FeatureView[];
  counts: Record<Stage, number>;
  /** Shipped (live + done) over every feature that isn't parked. */
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
  project: string;
  feature: string | null;
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
  projects: ProjectView[];
  goals: Goal[];
  recent: StageChangeView[];
  as_of: string | null;
}

/** pg turns a DATE into local midnight; read it back with local fields, or toISOString shifts it a day east of UTC. */
const day = (d: unknown): string | null => {
  if (d == null) return null;
  if (!(d instanceof Date)) return String(d).slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const iso = (d: unknown): string => (d instanceof Date ? d.toISOString() : String(d));
const daysBetween = (from: string, now: Date): number => Math.max(0, Math.floor((now.getTime() - new Date(from).getTime()) / 86_400_000));
const emptyCounts = (): Record<Stage, number> => Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;

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

export async function getBoard(vaultRoot: string, now = new Date()): Promise<Board> {
  const [divisions, teams, projects, features, verifs, moves, recent] = await Promise.all([
    query(`SELECT slug, name, mission, head FROM divisions ORDER BY sort, slug`),
    query(`SELECT slug, name, mission, lead, members FROM teams ORDER BY sort, slug`),
    query(`SELECT * FROM projects ORDER BY priority NULLS LAST, slug`),
    query(`SELECT * FROM features ORDER BY project_slug, sort, id`),
    query(
      `SELECT DISTINCT ON (feature_id) feature_id, kind, check_run, result, evidence, at, by,
              count(*) OVER (PARTITION BY feature_id) AS total
         FROM verifications ORDER BY feature_id, at DESC, id DESC`,
    ),
    query(
      `SELECT DISTINCT ON (project_slug, feature_id) project_slug, feature_id, at
         FROM stage_changes ORDER BY project_slug, feature_id, at DESC, id DESC`,
    ),
    query(
      `SELECT s.project_slug, f.slug AS feature, coalesce(f.title, p.title) AS title, s.from_stage, s.to_stage, s.at, s.by, s.note
         FROM stage_changes s JOIN projects p ON p.slug = s.project_slug LEFT JOIN features f ON f.id = s.feature_id
        WHERE s.at > $1 AND coalesce(s.note, '') NOT LIKE 'imported%' ORDER BY s.at DESC LIMIT 50`,
      [new Date(now.getTime() - 7 * 86_400_000)],
    ),
  ]);

  const lastMove = new Map<string, string>();
  for (const r of moves.rows) lastMove.set(`${r.project_slug}:${r.feature_id ?? ''}`, iso(r.at));
  const lastVerif = new Map<number, Verification & { total: number }>();
  for (const r of verifs.rows) {
    lastVerif.set(Number(r.feature_id), {
      kind: r.kind, check: r.check_run, result: r.result, evidence: r.evidence, at: iso(r.at), by: r.by, total: Number(r.total),
    });
  }

  const byProject = new Map<string, FeatureView[]>();
  for (const f of features.rows) {
    const v = lastVerif.get(Number(f.id)) ?? null;
    const moved = lastMove.get(`${f.project_slug}:${f.id}`) ?? iso(f.created_at);
    const activity = [iso(f.updated_at), moved, v?.at].filter(Boolean).sort().at(-1)!;
    const view: FeatureView = {
      id: Number(f.id), slug: f.slug, title: f.title, stage: f.stage, health: f.health, owner: f.owner, goals: f.goals,
      needs_owner: f.needs_owner, blocked_on: f.blocked_on, started: day(f.started), due: day(f.due),
      shipped_at: day(f.shipped_at), notes_path: f.notes_path, updated_at: iso(f.updated_at), updated_by: f.updated_by,
      days_in_stage: daysBetween(moved, now), last_activity: activity,
      verification: v ? { kind: v.kind, check: v.check, result: v.result, evidence: v.evidence, at: v.at, by: v.by } : null,
      verifications_total: v?.total ?? 0,
    };
    const list = byProject.get(f.project_slug) ?? [];
    list.push(view);
    byProject.set(f.project_slug, list);
  }

  const projectViews: ProjectView[] = projects.rows.map((p) => {
    const fs = byProject.get(p.slug) ?? [];
    const counts = emptyCounts();
    for (const f of fs) counts[f.stage]++;
    const denom = fs.length - counts.parked;
    return {
      slug: p.slug, title: p.title, team: p.team_slug, division: p.division_slug, area: p.area, stage: p.stage, health: p.health, priority: p.priority,
      goals: p.goals, needs_owner: p.needs_owner, blocked_on: p.blocked_on, started: day(p.started), due: day(p.due),
      devlog_path: p.devlog_path, design_path: p.design_path, paths: p.paths, repos: p.repos,
      updated_at: iso(p.updated_at), updated_by: p.updated_by,
      days_in_stage: daysBetween(lastMove.get(`${p.slug}:`) ?? iso(p.created_at), now),
      next_action: nextActionFrom(readVault(vaultRoot, p.devlog_path) ?? ''),
      features: fs, counts, progress: denom > 0 ? (counts.live + counts.done) / denom : null,
    };
  });

  const goalsFile = settings(vaultRoot).goalsFile;
  const goalsText = goalsFile ? readVault(vaultRoot, goalsFile) : null;
  const asOf = projectViews.map((p) => p.updated_at).sort().at(-1) ?? null;
  return {
    divisions: divisions.rows.map((d) => ({ slug: d.slug, name: d.name, mission: d.mission, head: d.head })),
    teams: teams.rows.map((t) => ({ slug: t.slug, name: t.name, mission: t.mission, lead: t.lead, members: t.members })),
    projects: projectViews,
    goals: goalsText ? parseGoals(goalsText) : [],
    recent: recent.rows.map((r) => ({
      project: r.project_slug, feature: r.feature, title: r.title, from: r.from_stage, to: r.to_stage, at: iso(r.at), by: r.by, note: r.note,
    })),
    as_of: asOf,
  };
}

// ---------------------------------------------------------------- report

export interface Item {
  project: string;
  feature: string | null;
  title: string;
  detail: string;
}

export interface Rollup {
  slug: string;
  name: string;
  projects: string[];
  in_flight: number;
  shipped_7d: number;
  needs_owner: number;
  /** Projects in each stage. */
  stages: Record<Stage, number>;
}

export interface Report {
  as_of: string | null;
  generated_at: string;
  totals: { projects: Record<Stage, number>; features: Record<Stage, number> };
  needs_owner: (Item & { priority: number | null; due: string | null })[];
  divisions: Rollup[];
  teams: (Rollup & { lead: string | null })[];
  goals: (Goal & { projects: string[]; features: string[] })[];
  gaps: {
    goals_uncovered: Goal[];
    unverified_shipped: Item[];
    failing: Item[];
    testing_unverified: Item[];
    stale: Item[];
    overdue: Item[];
    no_team: string[];
    no_division: string[];
    no_features: string[];
  };
  oldest: Item[];
  backlog: { total: number; by_project: { project: string; count: number; oldest_days: number }[] };
  moved_7d: StageChangeView[];
  shipped_7d: Item[];
  verified_7d: { pass: number; fail: number };
  projects: ProjectView[];
}

const OPEN_GOAL = (g: Goal): boolean => !/^(done|cancelled)/i.test(g.status) && g.horizon !== '' && !g.code.startsWith('T');

export async function buildReport(vaultRoot: string, now = new Date()): Promise<Report> {
  const board = await getBoard(vaultRoot, now);
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const today = now.toISOString().slice(0, 10);
  const { rows: vrows } = await query<{ result: string; n: number }>(
    `SELECT result, count(*)::int AS n FROM verifications WHERE at > $1 GROUP BY result`,
    [weekAgo],
  );
  const verified = { pass: 0, fail: 0 };
  for (const r of vrows) verified[r.result as 'pass' | 'fail'] = r.n;

  const totals = { projects: emptyCounts(), features: emptyCounts() };
  const needs: Report['needs_owner'] = [];
  const gaps: Report['gaps'] = {
    goals_uncovered: [], unverified_shipped: [], failing: [], testing_unverified: [], stale: [], overdue: [], no_team: [], no_division: [], no_features: [],
  };
  const oldest: (Item & { days: number })[] = [];
  const backlog: Report['backlog'] = { total: 0, by_project: [] };
  const shipped7: Item[] = [];
  const goalLinks = new Map<string, { projects: Set<string>; features: Set<string> }>();
  const link = (code: string) => goalLinks.get(code) ?? goalLinks.set(code, { projects: new Set(), features: new Set() }).get(code)!;

  for (const p of board.projects) {
    totals.projects[p.stage]++;
    for (const g of p.goals) link(g).projects.add(p.slug);
    if (p.needs_owner) needs.push({ project: p.slug, feature: null, title: p.title, detail: p.needs_owner, priority: p.priority, due: p.due });
    if (!p.team) gaps.no_team.push(p.slug);
    if (!p.division) gaps.no_division.push(p.slug);
    const active = !['parked', 'done'].includes(p.stage);
    if (active && p.features.length === 0) gaps.no_features.push(p.slug);
    if (active && p.due && p.due < today) gaps.overdue.push({ project: p.slug, feature: null, title: p.title, detail: `due ${p.due}` });
    let ideas = 0;
    let oldestIdea = 0;
    for (const f of p.features) {
      totals.features[f.stage]++;
      for (const g of f.goals) link(g).features.add(`${p.slug}/${f.slug}`);
      const item = { project: p.slug, feature: f.slug, title: f.title };
      if (f.needs_owner) needs.push({ ...item, detail: f.needs_owner, priority: p.priority, due: f.due ?? p.due });
      if (f.stage === 'idea') {
        ideas++;
        oldestIdea = Math.max(oldestIdea, f.days_in_stage);
      }
      const shipped = SHIPPED.includes(f.stage);
      if (shipped && f.verification?.result !== 'pass') {
        gaps.unverified_shipped.push({ ...item, detail: f.verification ? 'newest verification failed' : 'no verification' });
      }
      if (f.verification?.result === 'fail' && !shipped) {
        gaps.failing.push({ ...item, detail: `${f.verification.kind}: ${f.verification.check}` });
      }
      if (f.stage === 'testing' && !f.verification) gaps.testing_unverified.push({ ...item, detail: `${f.days_in_stage}d in testing` });
      if (IN_FLIGHT.includes(f.stage)) {
        const idle = daysBetween(f.last_activity, now);
        if (idle >= STALE_DAYS) gaps.stale.push({ ...item, detail: `${f.stage}, no activity for ${idle}d` });
        oldest.push({ ...item, detail: `${f.stage} for ${f.days_in_stage}d`, days: f.days_in_stage });
        if (f.due && f.due < today) gaps.overdue.push({ ...item, detail: `due ${f.due}` });
      }
      if (f.shipped_at && f.shipped_at >= weekAgo.slice(0, 10)) shipped7.push({ ...item, detail: `shipped ${f.shipped_at}` });
    }
    if (ideas) backlog.by_project.push({ project: p.slug, count: ideas, oldest_days: oldestIdea });
    backlog.total += ideas;
  }

  needs.sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99) || (a.due ?? '9999').localeCompare(b.due ?? '9999'));
  backlog.by_project.sort((a, b) => b.count - a.count);
  oldest.sort((a, b) => b.days - a.days);

  const goals = board.goals.map((g) => {
    const l = goalLinks.get(g.code);
    return { ...g, projects: [...(l?.projects ?? [])], features: [...(l?.features ?? [])] };
  });
  gaps.goals_uncovered = goals.filter((g) => OPEN_GOAL(g) && g.projects.length === 0 && g.features.length === 0);

  const rollup = (slug: string, name: string, ps: ProjectView[]): Rollup => {
    const fs = ps.flatMap((p) => p.features);
    return {
      slug, name, projects: ps.map((p) => p.slug),
      in_flight: fs.filter((f) => IN_FLIGHT.includes(f.stage)).length,
      shipped_7d: fs.filter((f) => f.shipped_at && f.shipped_at >= weekAgo.slice(0, 10)).length,
      needs_owner: ps.filter((p) => p.needs_owner).length + fs.filter((f) => f.needs_owner).length,
      stages: ps.reduce((c, p) => ({ ...c, [p.stage]: c[p.stage] + 1 }), emptyCounts()),
    };
  };
  const divisions = board.divisions.map((d) => rollup(d.slug, d.name, board.projects.filter((p) => p.division === d.slug)));
  const teams = board.teams.map((t) => ({ ...rollup(t.slug, t.name, board.projects.filter((p) => p.team === t.slug)), lead: t.lead }));

  return {
    as_of: board.as_of, generated_at: now.toISOString(), totals, needs_owner: needs, divisions, teams, goals, gaps,
    oldest: oldest.slice(0, 8).map(({ days: _d, ...i }) => i), backlog, moved_7d: board.recent, shipped_7d: shipped7,
    verified_7d: verified, projects: board.projects,
  };
}

/** Compact feed for the kiosk: top projects, their features in flight, the needs-you list. */
export function kioskSummary(r: Report, top = 5) {
  const ranked = [...r.projects]
    .filter((p) => !['parked', 'done'].includes(p.stage))
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99) || b.updated_at.localeCompare(a.updated_at));
  return {
    as_of: r.as_of,
    generated_at: r.generated_at,
    totals: r.totals,
    projects: ranked.slice(0, top).map((p) => ({
      slug: p.slug, title: p.title, stage: p.stage, health: p.health, priority: p.priority, counts: p.counts,
      progress: p.progress, next: p.next_action ?? p.needs_owner ?? null, needs_owner: Boolean(p.needs_owner || p.features.some((f) => f.needs_owner)),
      in_flight: p.features.filter((f) => IN_FLIGHT.includes(f.stage)).map((f) => ({ title: f.title, stage: f.stage, days: f.days_in_stage })),
    })),
    needs_owner: r.needs_owner.map((n) => ({ project: n.project, feature: n.feature, title: n.title, detail: n.detail, due: n.due })),
    gaps: {
      unverified_shipped: r.gaps.unverified_shipped.length, failing: r.gaps.failing.length, stale: r.gaps.stale.length,
      overdue: r.gaps.overdue.length, goals_uncovered: r.gaps.goals_uncovered.map((g) => g.code),
    },
    attention: [...r.gaps.failing, ...r.gaps.overdue, ...r.gaps.stale, ...r.gaps.testing_unverified].slice(0, 8),
    shipped_7d: r.shipped_7d.length,
    moved_7d: r.moved_7d.length,
  };
}
