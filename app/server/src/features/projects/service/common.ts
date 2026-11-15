import { z } from 'zod';
import { query, type TxClient } from '../../../db.js';

/**
 * What the two halves of the tracker share. Areas are what you run (no end date);
 * projects are what you finish (an outcome, inside one area). See docs/vault.md,
 * "Areas and projects".
 */

export const STAGES = ['idea', 'designing', 'building', 'testing', 'live', 'parked', 'done'] as const;
export type Stage = (typeof STAGES)[number];
export const IN_FLIGHT: readonly Stage[] = ['designing', 'building', 'testing'];
export const SHIPPED: readonly Stage[] = ['live', 'done'];
export const STALE_DAYS = 7;

export const AREA_STATUSES = ['active', 'parked'] as const;
export type AreaStatus = (typeof AREA_STATUSES)[number];

/**
 * The PARA rename (projects became areas, features became projects) left old spellings in
 * scripts, skills and bot memory. They keep working, each with a warning that names the new
 * one, until this day: 14 days after the cutover. From this day on an old spelling is
 * refused with the new one in the message. It never silently does the work.
 */
export const ALIAS_ENDS = '2026-12-01';

export const Slug =z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'lowercase letters, digits and dashes');
export const Text = z.string().trim().min(1).max(2000);

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

/** A refusal the caller can show as-is (400 in the API, exit 1 in the CLI). */
export class TrackerError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export function assignments(patch: Record<string, unknown>, cols: Record<string, string>, first: number) {
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

export async function teamMustExist(tx: TxClient, team: string | null | undefined): Promise<void> {
  if (!team) return;
  const { rowCount } = await tx.query(`SELECT 1 FROM teams WHERE slug = $1`, [team]);
  if (!rowCount) throw new TrackerError(`no team "${team}"`);
}

export async function divisionMustExist(tx: TxClient, division: string | null | undefined): Promise<void> {
  if (!division) return;
  const { rowCount } = await tx.query(`SELECT 1 FROM divisions WHERE slug = $1`, [division]);
  if (!rowCount) throw new TrackerError(`no division "${division}"`);
}

/**
 * Archiving hides a row from every active view without deleting it or its history, and
 * is separate from stage and status: unarchiving brings the row back as it was. Each
 * change writes a `stage_changes` row (`archived` or `unarchived`) so the history shows it.
 */
export async function recordArchive(
  tx: TxClient,
  area: string,
  projectId: number | null,
  archived: boolean,
  by: string,
  note: string | null,
): Promise<void> {
  await tx.query(
    `INSERT INTO stage_changes (area_slug, project_id, from_stage, to_stage, by, note) VALUES ($1,$2,NULL,$3,$4,$5)`,
    [area, projectId, archived ? 'archived' : 'unarchived', by, note],
  );
}

/** pg turns a DATE into local midnight; read it back with local fields, or toISOString shifts it a day east of UTC. */
export const day = (d: unknown): string | null => {
  if (d == null) return null;
  if (!(d instanceof Date)) return String(d).slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const iso = (d: unknown): string => (d instanceof Date ? d.toISOString() : String(d));
export const isoOrNull = (d: unknown): string | null => (d == null ? null : iso(d));
export const daysBetween = (from: string, now: Date): number => Math.max(0, Math.floor((now.getTime() - new Date(from).getTime()) / 86_400_000));
export const emptyCounts = (): Record<Stage, number> => Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
