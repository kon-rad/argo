import { isAbsolute, normalize } from 'node:path';
import type { z } from 'zod';
import { AreaPatchSchema } from '@secondbrain/contracts/projects';
import { query, withTransaction } from '../../../db.js';
import { ALIAS_ENDS, assignments, divisionMustExist, recordArchive, Slug, teamMustExist, TrackerError, type AreaStatus } from './common.js';

/**
 * Areas: what you run. An area is a standard the owner keeps up, so it has no stage and
 * no due date, only a status (`active` or `parked`). The finite work inside it is its
 * projects (./projects.ts). An area can be archived, which hides it and its projects
 * from every active view and deletes nothing.
 */

export const AreaPatch = AreaPatchSchema;
export type AreaPatch = z.infer<typeof AreaPatch>;

const AREA_COLS: Record<string, string> = {
  title: 'title', team: 'team_slug', division: 'division_slug', status: 'status', health: 'health', priority: 'priority',
  goals: 'goals', needs_owner: 'needs_owner', blocked_on: 'blocked_on', started: 'started',
  devlog_path: 'devlog_path', design_path: 'design_path', home_path: 'home_path', paths: 'paths', repos: 'repos',
};

/** Creates the area when `create` is set (a title is required; it starts `active`), else updates it. */
export async function upsertArea(
  slug: string,
  raw: AreaPatch,
  by: string,
  opts: { create?: boolean; imported?: boolean } = {},
): Promise<{ created: boolean; stage_changed: boolean }> {
  Slug.parse(slug);
  const patch = AreaPatch.parse(raw);
  // The home is where `cli-projects add` creates project folders, so it has to be a place inside the vault.
  if (patch.home_path && (isAbsolute(patch.home_path) || normalize(patch.home_path).startsWith('..'))) {
    throw new TrackerError(`home_path is a path inside the vault, relative to its root (got "${patch.home_path}")`);
  }
  return withTransaction(async (tx) => {
    await teamMustExist(tx, patch.team);
    await divisionMustExist(tx, patch.division);
    const cur = await tx.query<{ status: AreaStatus }>(`SELECT status FROM areas WHERE slug = $1 FOR UPDATE`, [slug]);
    if (!cur.rows[0]) {
      if (!opts.create) throw new TrackerError(`no area "${slug}" (add it first: cli-areas add ${slug} --title "...")`, 404);
      if (!patch.title) throw new TrackerError('a new area needs a title');
      const status = patch.status ?? 'active';
      await tx.query(`INSERT INTO areas (slug, title, status, updated_by) VALUES ($1,$2,$3,$4)`, [slug, patch.title, status, by]);
      await tx.query(
        `INSERT INTO stage_changes (area_slug, from_stage, to_stage, by, note) VALUES ($1, NULL, $2, $3, $4)`,
        [slug, status, by, [opts.imported ? 'imported' : 'added', patch.note].filter(Boolean).join(' · ')],
      );
    }
    const from = cur.rows[0]?.status ?? patch.status ?? 'active';
    const { sets, vals } = assignments(patch, AREA_COLS, 3);
    await tx.query(
      `UPDATE areas SET ${[...sets, 'updated_at = now()', 'updated_by = $2'].join(', ')} WHERE slug = $1`,
      [slug, by, ...vals],
    );
    const statusChanged = Boolean(cur.rows[0] && patch.status && patch.status !== from);
    if (statusChanged) {
      await tx.query(
        `INSERT INTO stage_changes (area_slug, from_stage, to_stage, by, note) VALUES ($1,$2,$3,$4,$5)`,
        [slug, from, patch.status, by, patch.note ?? null],
      );
    }
    return { created: !cur.rows[0], stage_changed: statusChanged };
  });
}

/**
 * Archives or unarchives an area. Its projects are hidden with it but keep their stages,
 * so unarchiving brings everything back as it was. Idempotent: `changed` is false when
 * the area was already in that state, and no history row is written.
 */
export async function setAreaArchived(slug: string, archived: boolean, by: string, note?: string | null): Promise<{ archived: boolean; changed: boolean }> {
  Slug.parse(slug);
  return withTransaction(async (tx) => {
    const cur = await tx.query<{ archived_at: Date | null }>(`SELECT archived_at FROM areas WHERE slug = $1 FOR UPDATE`, [slug]);
    if (!cur.rows[0]) throw new TrackerError(`no area "${slug}"`, 404);
    if (Boolean(cur.rows[0].archived_at) === archived) return { archived, changed: false };
    await tx.query(`UPDATE areas SET archived_at = ${archived ? 'now()' : 'NULL'}, updated_at = now(), updated_by = $2 WHERE slug = $1`, [slug, by]);
    await recordArchive(tx, slug, null, archived, by, note ?? null);
    return { archived, changed: true };
  });
}

/**
 * Deletes an area for good and, by cascade, its projects, stage history and verifications.
 * Cards and messages keep their rows with the area and project cleared. Shared-memory facts
 * tagged with it are re-tagged to `into` when given, else cleared. The everyday verb is
 * archive; this is `--purge`.
 */
export async function removeArea(slug: string, opts: { dryRun?: boolean; into?: string } = {}): Promise<{ projects: number; facts: number }> {
  Slug.parse(slug);
  if (opts.into) Slug.parse(opts.into);
  if (opts.into === slug) throw new TrackerError('--into must be a different area');
  const { rows } = await query<{ p: string; m: string; a: string }>(
    `SELECT (SELECT count(*) FROM projects WHERE area_slug = $1)::text AS p,
            (SELECT count(*) FROM memory_facts WHERE area_slug = $1)::text AS m,
            (SELECT count(*) FROM areas WHERE slug = $1)::text AS a`,
    [slug],
  );
  if (!Number(rows[0]?.a ?? 0)) throw new TrackerError(`no area "${slug}"`, 404);
  const out = { projects: Number(rows[0]?.p ?? 0), facts: Number(rows[0]?.m ?? 0) };
  if (opts.dryRun) return out;
  await withTransaction(async (tx) => {
    if (opts.into) {
      const { rowCount } = await tx.query(`SELECT 1 FROM areas WHERE slug = $1`, [opts.into]);
      if (!rowCount) throw new TrackerError(`no area "${opts.into}" to move facts into`);
    }
    await tx.query(`UPDATE memory_facts SET area_slug = $2 WHERE area_slug = $1`, [slug, opts.into ?? null]);
    const { rowCount } = await tx.query(`DELETE FROM areas WHERE slug = $1`, [slug]);
    if (!rowCount) throw new TrackerError(`no area "${slug}"`, 404);
  });
  return out;
}

/** True when `slug` names an area. The board and org CLIs use it to read an old `--project <area>`. */
export async function isArea(slug: string): Promise<boolean> {
  if (!Slug.safeParse(slug).success) return false;
  const { rowCount } = await query(`SELECT 1 FROM areas WHERE slug = $1`, [slug]);
  return Boolean(rowCount);
}

/** Who a card, a message or a fact is about, as a caller named it: new words, old words, or a mix. */
export interface TrackerRefInput {
  area?: string | null;
  project?: string | null;
  /** The pre-rename name for a project. */
  feature?: string | null;
}

/**
 * Reads an area/project pair from a caller that may still speak the pre-rename words, for as
 * long as the aliases last (ALIAS_ENDS):
 *
 *   - `feature` is the old name for a project. With it, a `project` given without an `area`
 *     is the old name for the area: `--project a --feature f` is `--area a --project f`.
 *   - a `project` alone that names an area is an old `--project <area>`: it is read as the area.
 *
 * Each of these warns, naming the new spelling. After the window they are refused with the
 * same text. A `project` alone that is not an area is left as it is: the caller is told it
 * needs its area, by the code that checks the pair.
 */
export async function resolveTrackerRef(
  ref: TrackerRefInput,
  opts: { warn?: (line: string) => void; now?: Date } = {},
): Promise<{ area?: string; project?: string }> {
  const warn = opts.warn ?? ((line: string) => console.error(line));
  const open = (opts.now ?? new Date()).toISOString().slice(0, 10) < ALIAS_ENDS;
  const old = (was: string, is: string): void => {
    if (!open) throw new TrackerError(`${was} ended on ${ALIAS_ENDS}. Use ${is}.`);
    warn(`warning: ${was} is now ${is}. The old spelling works until ${ALIAS_ENDS}.`);
  };
  let area = ref.area ?? undefined;
  let project = ref.project ?? undefined;
  if (ref.feature) {
    if (area && project && project !== ref.feature) throw new TrackerError('give the project once: --area <a> --project <p> (--feature is the old name for --project)');
    if (!area && project) {
      old(`--project ${project} --feature ${ref.feature}`, `--area ${project} --project ${ref.feature}`);
      area = project;
    } else {
      old(`--feature ${ref.feature}`, `--project ${ref.feature}`);
    }
    project = ref.feature;
  } else if (project && !area && (await isArea(project))) {
    old(`--project ${project} (an area)`, `--area ${project}`);
    area = project;
    project = undefined;
  }
  return { ...(area ? { area } : {}), ...(project ? { project } : {}) };
}
