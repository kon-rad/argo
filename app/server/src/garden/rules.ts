import type { GardenSettings } from '../settings.js';
import type { Shelf } from './shelves.js';

/**
 * The nightly plan as pure functions: a shelf list in, a list of actions out.
 * Dates and tracker stages come in as functions so the rules run in tests
 * without git or a database.
 */
export interface RuleContext {
  today: string;                                     // YYYY-MM-DD
  quarter: string;                                   // e.g. 2026Q4, where archived shelves go
  lastTouched: (dir: string) => string | null;       // ISO date of the last commit under dir, null when none
  trackerStage: (slug: string) => string | null;     // projects.stage for a tracker slug, null when unknown
  settings: GardenSettings;
}

export type Action =
  | { type: 'archive'; from: string; to: string; reason: string }
  | { type: 'propose-archive'; dir: string; reason: string }
  | { type: 'rename'; from: string; to: string; reason: string }
  | { type: 'file'; from: string; to: string; reason: string; confidence: number }
  | { type: 'report'; path: string; reason: string };

const ARCHIVE_SUBDIR: Record<Shelf['meta']['kind'], string> = { project: 'projects', area: 'areas', resource: 'research' };

export function kebab(name: string): string {
  return name
    .trim()
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .replace(/[^A-Za-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

export function quarterOf(iso: string): string {
  const [y, m] = iso.split('-');
  return `${y}Q${Math.floor((Number(m) - 1) / 3) + 1}`;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function archiveAfterDays(shelf: Shelf, s: GardenSettings): number | null {
  const v = shelf.meta.archive_after;
  if (v === 'never') return null;
  const m = /^(\d+)d$/.exec(v);
  if (m) return Number(m[1]);
  return shelf.meta.kind === 'project' ? s.projectArchiveAfterDays : null;
}

export function planShelves(shelves: Shelf[], ctx: RuleContext): Action[] {
  const { settings: s } = ctx;
  const pinned = new Set(s.pinned);
  const out: Action[] = [];
  let moves = 0;
  let renames = 0;
  for (const shelf of shelves) {
    if (shelf.meta.pin || shelf.meta.status === 'archived' || pinned.has(shelf.dir)) continue;
    const name = shelf.dir.split('/').pop()!;
    const parent = shelf.dir.slice(0, -name.length - 1);
    const touched = ctx.lastTouched(shelf.dir);
    const age = touched ? daysBetween(touched, ctx.today) : null;

    if (shelf.meta.kind === 'project') {
      const stage = shelf.meta.project === 'none' ? null : ctx.trackerStage(shelf.meta.project);
      const limit = archiveAfterDays(shelf, s);
      let reason: string | null = null;
      if (stage === 'parked' || stage === 'done') reason = `tracker: ${stage}`;
      else if (limit !== null && age === null) reason = 'no history';
      else if (limit !== null && age !== null && age > limit) reason = `untouched ${age}d`;
      if (reason) {
        const to = `${s.archiveDir}/${ctx.quarter}/${ARCHIVE_SUBDIR.project}/${name}`;
        if (moves < s.maxMoves) { out.push({ type: 'archive', from: shelf.dir, to, reason }); moves++; }
        else out.push({ type: 'report', path: shelf.dir, reason: 'over cap' });
        continue;
      }
    } else if (shelf.meta.kind === 'area') {
      if (shelf.meta.project === 'none' && age !== null && age > s.areaProposeAfterDays) {
        out.push({ type: 'propose-archive', dir: shelf.dir, reason: `untouched ${age}d` });
        continue;
      }
    }

    const wanted = kebab(name);
    if (wanted && wanted !== name) {
      if (renames < s.maxRenames) { out.push({ type: 'rename', from: shelf.dir, to: `${parent}/${wanted}`, reason: 'name not kebab-case' }); renames++; }
      else out.push({ type: 'report', path: shelf.dir, reason: `rename to ${wanted} (over cap)` });
    }
  }
  return out;
}

/** Notes sitting at a root (vault root, Projects/, Research/ ...) instead of inside a shelf. Routing is a later step; for now they are reported. */
export function planLoose(looseFiles: string[], _ctx: RuleContext): Action[] {
  return looseFiles.map((path) => ({ type: 'report', path, reason: 'loose note, file it into a shelf' }));
}
