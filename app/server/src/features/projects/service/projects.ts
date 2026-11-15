import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import type { z } from 'zod';
import { ProjectPatchSchema, ProjectVerificationRequestSchema } from '@secondbrain/contracts/projects';
import { query, withTransaction } from '../../../db.js';
import { assignments, day, insertion, iso, isoOrNull, SHIPPED, Slug, stamp, TrackerError, type Stage } from './common.js';

/**
 * Projects: what you finish. A project is an outcome with an end, inside one area, and it
 * moves through one stage list. The rule that makes "done" mean something: a project moves
 * to live or done only when its newest verification passed, or the move says why it skipped
 * that (recorded in the stage history and shown as a gap in the report).
 */

export const ProjectPatch = ProjectPatchSchema;
export type ProjectPatch = z.infer<typeof ProjectPatch>;

export const VerificationInput = ProjectVerificationRequestSchema;
export type VerificationInput = z.infer<typeof VerificationInput>;

const PROJECT_COLS: Record<string, string> = {
  title: 'title', outcome: 'outcome', next_action: 'next_action', stage: 'stage', health: 'health', owner: 'owner', goals: 'goals',
  needs_owner: 'needs_owner', blocked_on: 'blocked_on', started: 'started', due: 'due', notes_path: 'notes_path', sort: 'sort',
};

/**
 * Creates or updates a project. A move into live or done is refused unless the project's
 * newest verification passed, or `unverified` gives the reason, which is then kept in the
 * stage history. A new project needs a title; its outcome defaults to the title.
 */
export async function upsertProject(
  areaSlug: string,
  slug: string,
  raw: ProjectPatch,
  by: string,
  opts: {
    create?: boolean;
    /** From importSeed: the project already existed before the tracker, so its ship date is unknown. */
    imported?: boolean;
    /** Existing evidence, inserted with a new project so the stage gate sees it. */
    evidence?: (VerificationInput & { at?: string })[];
  } = {},
): Promise<{ id: number; created: boolean; stage_changed: boolean }> {
  Slug.parse(slug);
  const patch = ProjectPatch.parse(raw);
  return withTransaction(async (tx) => {
    const area = await tx.query(`SELECT 1 FROM areas WHERE slug = $1`, [areaSlug]);
    if (!area.rowCount) throw new TrackerError(`no area "${areaSlug}" (cli-areas list)`, 404);
    let cur = await tx.query<{ id: number; stage: Stage; shipped_at: string | null }>(
      `SELECT id, stage, shipped_at FROM projects WHERE area_slug = $1 AND slug = $2 FOR UPDATE`,
      [areaSlug, slug],
    );
    const from: Stage | null = cur.rows[0]?.stage ?? null;
    const to = patch.stage;
    const moving = to !== undefined && to !== from;
    let note = patch.note ?? null;
    /** The gate: shipping needs a passing newest verification, or the reason it has none, which goes into the note. */
    const gate = (newest: 'pass' | 'fail' | undefined): void => {
      if (newest === 'pass') return;
      if (!patch.unverified) {
        throw new TrackerError(
          `${areaSlug}/${slug} can't move to ${to}: ${newest ? 'its newest verification failed' : 'it has no verification'}. ` +
            `Record one (verify --pass with the check you ran), or pass unverified with the reason.`,
          409,
        );
      }
      note = `UNVERIFIED: ${patch.unverified}${note ? ` · ${note}` : ''}`;
    };

    if (!cur.rows[0]) {
      if (!opts.create) throw new TrackerError(`no project "${areaSlug}/${slug}" (add it first)`, 404);
      if (!patch.title) throw new TrackerError('a new project needs a title');
      // A project named like an area would make a bare slug ambiguous for every reader that
      // still takes one (an old `--project <area>`), so the two namespaces stay apart.
      const clash = await tx.query(`SELECT 1 FROM areas WHERE slug = $1`, [slug]);
      if (clash.rowCount) throw new TrackerError(`"${slug}" is the name of an area; give the project a different slug`);
      // The row is not there yet, so the gate reads the evidence that comes with it.
      if (to && SHIPPED.includes(to)) gate(newestResult(opts.evidence ?? []));
      // One INSERT with every field and the stage it starts in, so the history holds one
      // `created` row, which the stage history shows as the project's first stage.
      await stamp(tx, by, [opts.imported ? 'imported' : 'added', note].filter(Boolean).join(' · '));
      const { names, marks, vals } = insertion({ ...patch, outcome: patch.outcome ?? patch.title, stage: to ?? 'idea' }, PROJECT_COLS, 4);
      if (to === 'live' && !opts.imported) {
        names.push('shipped_at');
        marks.push('CURRENT_DATE');
      }
      cur = await tx.query(
        `INSERT INTO projects (${['area_slug', 'slug', 'updated_by', ...names].join(', ')}) VALUES (${['$1', '$2', '$3', ...marks].join(', ')})
         RETURNING id, stage, shipped_at`,
        [areaSlug, slug, by, ...vals],
      );
      for (const v of opts.evidence ?? []) {
        await tx.query(
          `INSERT INTO verifications (project_id, kind, check_run, result, evidence, at, by)
           VALUES ($1,$2,$3,$4,$5,coalesce($6::timestamptz, now()),$7)`,
          [cur.rows[0]!.id, v.kind, v.check, v.result, v.evidence ?? null, v.at ?? null, by],
        );
      }
      await tx.query(`UPDATE areas SET updated_at = now(), updated_by = $2 WHERE slug = $1`, [areaSlug, by]);
      return { id: cur.rows[0]!.id, created: true, stage_changed: false };
    }

    const project = cur.rows[0];
    if (moving && SHIPPED.includes(to) && !(from && SHIPPED.includes(from))) {
      const v = await tx.query<{ result: 'pass' | 'fail' }>(
        `SELECT result FROM verifications WHERE project_id = $1 ORDER BY at DESC, id DESC LIMIT 1`,
        [project.id],
      );
      gate(v.rows[0]?.result);
    }

    // The triggers write one history row per column this changes (a stage move is the `stage` row); the note goes on each.
    await stamp(tx, by, note);
    const { sets, vals } = assignments(patch, PROJECT_COLS, 3);
    if (moving && to === 'live' && !project.shipped_at && !opts.imported) sets.push('shipped_at = CURRENT_DATE');
    await tx.query(
      `UPDATE projects SET ${[...sets, 'updated_at = now()', 'updated_by = $2'].join(', ')} WHERE id = $1`,
      [project.id, by, ...vals],
    );
    await tx.query(`UPDATE areas SET updated_at = now(), updated_by = $2 WHERE slug = $1`, [areaSlug, by]);
    return { id: project.id, created: false, stage_changed: moving };
  });
}

/** The result of the newest of these, as the gate's query would order them once stored (`at`, then the order given). */
function newestResult(evidence: (VerificationInput & { at?: string })[]): 'pass' | 'fail' | undefined {
  const now = Date.now();
  let best: { t: number; result: 'pass' | 'fail' } | undefined;
  for (const v of evidence) {
    const t = v.at ? Date.parse(v.at) : now;
    if (!best || t >= best.t) best = { t, result: v.result };
  }
  return best?.result;
}

export async function addVerification(areaSlug: string, projectSlug: string, raw: VerificationInput, by: string): Promise<number> {
  const v = VerificationInput.parse(raw);
  return withTransaction(async (tx) => {
    const p = await tx.query<{ id: number }>(`SELECT id FROM projects WHERE area_slug = $1 AND slug = $2`, [areaSlug, projectSlug]);
    if (!p.rows[0]) throw new TrackerError(`no project "${areaSlug}/${projectSlug}"`, 404);
    await stamp(tx, by);
    const { rows } = await tx.query<{ id: number }>(
      `INSERT INTO verifications (project_id, kind, check_run, result, evidence, by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [p.rows[0].id, v.kind, v.check, v.result, v.evidence ?? null, by],
    );
    await tx.query(`UPDATE projects SET updated_at = now(), updated_by = $2 WHERE id = $1`, [p.rows[0].id, by]);
    return rows[0]!.id;
  });
}

/** Archives or unarchives a project. Its stage is untouched, so unarchiving brings it back as it was. Idempotent. */
export async function setProjectArchived(
  areaSlug: string,
  slug: string,
  archived: boolean,
  by: string,
  note?: string | null,
): Promise<{ archived: boolean; changed: boolean }> {
  return withTransaction(async (tx) => {
    const cur = await tx.query<{ id: number; archived_at: Date | null }>(
      `SELECT id, archived_at FROM projects WHERE area_slug = $1 AND slug = $2 FOR UPDATE`,
      [areaSlug, slug],
    );
    if (!cur.rows[0]) throw new TrackerError(`no project "${areaSlug}/${slug}"`, 404);
    if (Boolean(cur.rows[0].archived_at) === archived) return { archived, changed: false };
    await stamp(tx, by, note ?? null);
    await tx.query(`UPDATE projects SET archived_at = ${archived ? 'now()' : 'NULL'}, updated_at = now(), updated_by = $2 WHERE id = $1`, [cur.rows[0].id, by]);
    return { archived, changed: true };
  });
}

/** Deletes a project for good, with its stage history and verifications. Cards keep their rows with the project cleared. The everyday verb is archive; this is `--purge`. */
export async function removeProject(areaSlug: string, slug: string, opts: { dryRun?: boolean } = {}): Promise<{ verifications: number }> {
  const { rows } = await query<{ id: number; v: string }>(
    `SELECT p.id, (SELECT count(*) FROM verifications v WHERE v.project_id = p.id)::text AS v FROM projects p WHERE p.area_slug = $1 AND p.slug = $2`,
    [areaSlug, slug],
  );
  if (!rows[0]) throw new TrackerError(`no project "${areaSlug}/${slug}"`, 404);
  if (!opts.dryRun) await query(`DELETE FROM projects WHERE id = $1`, [rows[0].id]);
  return { verifications: Number(rows[0].v) };
}

export interface ProjectRow {
  area: string;
  slug: string;
  title: string;
  outcome: string | null;
  next_action: string | null;
  stage: Stage;
  owner: string | null;
  due: string | null;
  needs_owner: string | null;
  notes_path: string | null;
  archived_at: string | null;
  updated_at: string;
}

/**
 * Projects across areas, for `cli-projects list` and `GET /api/projects`. Archived projects,
 * and the projects of an archived area, are left out unless `archived` is set.
 */
export async function listProjects(f: { area?: string; stage?: Stage; dueBefore?: string; archived?: boolean } = {}): Promise<ProjectRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.area) where.push(`p.area_slug = $${params.push(f.area)}`);
  if (f.stage) where.push(`p.stage = $${params.push(f.stage)}`);
  if (f.dueBefore) where.push(`p.due < $${params.push(f.dueBefore)}::date`);
  if (!f.archived) where.push('p.archived_at IS NULL AND a.archived_at IS NULL');
  const { rows } = await query(
    `SELECT p.area_slug, p.slug, p.title, p.outcome, p.next_action, p.stage, p.owner, p.due, p.needs_owner, p.notes_path,
            coalesce(p.archived_at, a.archived_at) AS archived_at, p.updated_at
       FROM projects p JOIN areas a ON a.slug = p.area_slug
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY a.priority NULLS LAST, p.area_slug, p.due NULLS LAST, p.sort, p.id`,
    params,
  );
  return rows.map((r) => ({
    area: r.area_slug, slug: r.slug, title: r.title, outcome: r.outcome, next_action: r.next_action, stage: r.stage, owner: r.owner,
    due: day(r.due), needs_owner: r.needs_owner, notes_path: r.notes_path, archived_at: isoOrNull(r.archived_at), updated_at: iso(r.updated_at),
  }));
}

/** A vault-relative path, or null when it would leave the vault. */
export function inVault(rel: string): string | null {
  const clean = normalize(rel).replace(/^\/+/, '');
  return clean === '' || clean === '.' || clean.startsWith('..') ? null : clean;
}

/**
 * The home of a new project: `<area home>/projects/<slug>/README.md`, with the frontmatter
 * the scanner and agents read (`kind: project`, `area`, `project`, `outcome`). `home_path`
 * may be the area's folder or its home note (then the note's folder is used). An existing
 * file is never overwritten: it is left as it is and reported as `exists`. Sets the
 * project's `notes_path` either way. Returns null when the area has no `home_path`.
 */
export async function createProjectNote(
  vaultRoot: string,
  areaSlug: string,
  slug: string,
  by: string,
): Promise<{ path: string; written: boolean } | null> {
  const { rows } = await query<{ home_path: string | null; title: string; outcome: string | null }>(
    `SELECT a.home_path, p.title, p.outcome FROM projects p JOIN areas a ON a.slug = p.area_slug WHERE p.area_slug = $1 AND p.slug = $2`,
    [areaSlug, slug],
  );
  if (!rows[0]) throw new TrackerError(`no project "${areaSlug}/${slug}"`, 404);
  const { home_path, title, outcome } = rows[0];
  if (!home_path) return null;
  const home = inVault(home_path);
  if (!home) throw new TrackerError(`the home_path of ${areaSlug} ("${home_path}") is not inside the vault`);
  const base = /\.md$/i.test(home) ? dirname(home) : home;
  const rel = join(base, 'projects', slug, 'README.md');
  const abs = join(vaultRoot, rel);
  const text = [
    '---',
    'kind: project',
    `area: ${areaSlug}`,
    `project: ${slug}`,
    // JSON is valid YAML for a string, and keeps a colon or a quote in the outcome from breaking the frontmatter.
    `outcome: ${JSON.stringify(outcome ?? title)}`,
    '---',
    '',
    `# ${title}`,
    '',
    `**Outcome:** ${outcome ?? title}`,
    '',
  ].join('\n');
  let written = false;
  if (!existsSync(abs)) {
    mkdirSync(dirname(abs), { recursive: true });
    try {
      // 'wx' fails when the file appeared since the check, so a race cannot overwrite it either.
      writeFileSync(abs, text, { flag: 'wx' });
      written = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  await withTransaction(async (tx) => {
    await stamp(tx, by);
    await tx.query(`UPDATE projects SET notes_path = $3, updated_at = now(), updated_by = $4 WHERE area_slug = $1 AND slug = $2`, [areaSlug, slug, rel, by]);
  });
  return { path: rel, written };
}
