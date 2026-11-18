import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import type { z } from 'zod';
import { KpiReadingRequestSchema } from '@secondbrain/contracts/projects';
import { query, withTransaction, type TxClient } from '../../../db.js';
import { Slug, stamp, TrackerError } from './common.js';
import { inVault } from './projects.js';

/**
 * The two kinds of history the triggers cannot see: what changed in a home note's
 * frontmatter (the scanner tells us) and KPI readings (the owner or a collector tells us).
 * Everything else in `tracker_events` is written by the triggers on `areas` and `projects`.
 */

type Frontmatter = Record<string, unknown> | null;

const tracked = (fm: Frontmatter): fm is Record<string, unknown> => fm?.kind === 'area' || fm?.kind === 'project';
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/**
 * Called by the vault scanner when a note that was already indexed changed. For a home
 * note (frontmatter `kind: area` or `kind: project`, naming its `area`, and its `project`)
 * this writes one `frontmatter` row per top-level key whose value differs, with both
 * values. A body edit changes no key and writes nothing; git keeps those. A note whose
 * area or project is not in the tracker writes nothing either. Returns the rows written.
 */
export async function recordFrontmatterChange(tx: TxClient, path: string, before: Frontmatter, after: Frontmatter): Promise<number> {
  // The note as it is now says what it is; a note that just lost its `kind` is read as what it was.
  const id = tracked(after) ? after : tracked(before) ? before : null;
  if (!id) return 0;
  const area = str(id.area);
  const project = id.kind === 'project' ? str(id.project) : null;
  if (!area || (id.kind === 'project' && !project)) return 0;
  // jsonb compares by value, so key order and whitespace in the YAML are not changes.
  const { rowCount } = await tx.query(
    `INSERT INTO tracker_events (actor, source, area_slug, project_id, kind, field, from_value, to_value, note)
     SELECT 'scanner', 'scanner', a.slug, p.id, 'frontmatter', key, o.value, n.value, $5
       FROM areas a
       LEFT JOIN projects p ON p.area_slug = a.slug AND p.slug = $2
       CROSS JOIN (jsonb_each($3::jsonb) o FULL JOIN jsonb_each($4::jsonb) n USING (key))
      WHERE a.slug = $1 AND ($2::text IS NULL OR p.id IS NOT NULL) AND o.value IS DISTINCT FROM n.value
      ORDER BY key`,
    [area, project, JSON.stringify(before ?? {}), JSON.stringify(after ?? {}), path],
  );
  return rowCount ?? 0;
}

export const KpiReadingInput = KpiReadingRequestSchema;
export type KpiReadingInput = z.infer<typeof KpiReadingInput>;

/** The KPI keys an area defines: the `kpis:` frontmatter of its home note, as a list of `{ key, ... }` or a map by key. */
export function kpiKeys(frontmatter: Record<string, unknown>): string[] {
  const kpis = frontmatter.kpis;
  if (Array.isArray(kpis)) {
    return kpis.map((k) => (typeof k === 'string' ? k : k && typeof k === 'object' ? String((k as Record<string, unknown>).key ?? '') : '')).filter(Boolean);
  }
  return kpis && typeof kpis === 'object' ? Object.keys(kpis) : [];
}

/** The area's home note: `home_path` itself when it is a note, else the README.md in that folder. */
function homeNote(vaultRoot: string, area: string, homePath: string | null): { rel: string; frontmatter: Record<string, unknown> } {
  if (!homePath) throw new TrackerError(`${area} has no home note, so it has no KPIs. Set one (cli-areas set ${area} --home PATH) and define them in its kpis: frontmatter.`);
  const home = inVault(homePath);
  if (!home) throw new TrackerError(`the home_path of ${area} ("${homePath}") is not inside the vault`);
  const rel = /\.md$/i.test(home) ? home : join(home, 'README.md');
  let text: string;
  try {
    text = readFileSync(join(vaultRoot, rel), 'utf8');
  } catch {
    throw new TrackerError(`the home note of ${area} (${rel}) can't be read, so its KPIs are unknown`);
  }
  try {
    return { rel, frontmatter: matter(text).data as Record<string, unknown> };
  } catch {
    throw new TrackerError(`the frontmatter of ${rel} is not valid YAML, so the KPIs of ${area} are unknown`);
  }
}

/**
 * Records one KPI reading for an area. The key must be defined in the `kpis:` frontmatter
 * of the area's home note: anything else is refused with the keys that are, so a typo
 * never starts a second series. The reading also lands in `tracker_events` (kind
 * `kpi_reading`), written by a trigger on `kpi_readings`.
 */
export async function recordKpi(vaultRoot: string, area: string, raw: KpiReadingInput, by: string): Promise<{ id: number }> {
  Slug.parse(area);
  const r = KpiReadingInput.parse(raw);
  if (r.at !== undefined && Number.isNaN(Date.parse(r.at))) throw new TrackerError(`"${r.at}" is not a date or a time (e.g. 2026-11-15 or 2026-11-15T09:00:00Z)`);
  const a = await query<{ home_path: string | null }>(`SELECT home_path FROM areas WHERE slug = $1`, [area]);
  if (!a.rows[0]) throw new TrackerError(`no area "${area}" (cli-areas list)`, 404);
  const note = homeNote(vaultRoot, area, a.rows[0].home_path);
  const known = kpiKeys(note.frontmatter);
  if (!known.includes(r.key)) {
    throw new TrackerError(
      known.length
        ? `${area} has no KPI "${r.key}". Known keys: ${known.join(', ')} (the kpis: frontmatter of ${note.rel})`
        : `${area} has no KPI "${r.key}": ${note.rel} defines none in its kpis: frontmatter`,
    );
  }
  return withTransaction(async (tx) => {
    // actor and source default from the stamp (see the kpi_readings columns).
    await stamp(tx, by, r.note ?? null);
    const { rows } = await tx.query<{ id: number }>(
      `INSERT INTO kpi_readings (area_slug, kpi_key, value, at, note) VALUES ($1, $2, $3::numeric, coalesce($4::timestamptz, now()), $5) RETURNING id`,
      [area, r.key, String(r.value), r.at ?? null, r.note ?? null],
    );
    return { id: rows[0]!.id };
  });
}
