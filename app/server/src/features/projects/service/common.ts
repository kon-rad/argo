import { AsyncLocalStorage } from 'node:async_hooks';
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

/** The same patch as the column list, the placeholders and the values of an INSERT. */
export function insertion(patch: Record<string, unknown>, cols: Record<string, string>, first: number) {
  const names: string[] = [];
  const marks: string[] = [];
  const vals: unknown[] = [];
  for (const [k, col] of Object.entries(cols)) {
    if (patch[k] === undefined) continue;
    vals.push(patch[k]);
    names.push(col);
    marks.push(`$${first + vals.length - 1}`);
  }
  return { names, marks, vals };
}

/**
 * The change history (`tracker_events`) is written by database triggers on `areas` and
 * `projects`, one row per changed column, so no write path can forget it. What a trigger
 * cannot know is who is writing and how. Every write path says so for its transaction:
 * `stamp` sets `app.actor`, `app.source` and `app.note`, which the triggers read. A write
 * that skips this is still logged, with the actor `unknown`.
 *
 * The source is `api` unless the code runs inside `withTrackerSource` (the CLIs wrap
 * themselves in `cli`). `stage_changes` is a view over the log, so the stage history, the
 * verify gate and the report read what they always read.
 */
export type TrackerSource = 'cli' | 'api';
const sourceStore = new AsyncLocalStorage<TrackerSource>();
export const withTrackerSource = <T>(source: TrackerSource, fn: () => Promise<T>): Promise<T> => sourceStore.run(source, fn);
export const trackerSource = (): TrackerSource => sourceStore.getStore() ?? 'api';

/** Names the writer of this transaction. `note` goes on every history row the transaction writes from here on. */
export async function stamp(tx: TxClient, actor: string, note?: string | null): Promise<void> {
  await tx.query(`SELECT set_config('app.actor', $1, true), set_config('app.source', $2, true), set_config('app.note', $3, true)`, [
    actor,
    trackerSource(),
    note ?? '',
  ]);
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
