import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * A connector is a folder `<data.dir>/connectors/<name>/` with a `connector.json`
 * and a script in any language (docs/data.md#connectors). These are pure: reading
 * the definitions and deciding what is due.
 */

const Every = z.string().regex(/^\d+[mhd]$/, 'every: a number then m, h or d (15m, 6h, 1d)');
const At = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'at: HH:MM in UTC');

const Def = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  description: z.string().default(''),
  command: z.array(z.string().min(1)).min(1),
  schedule: z.object({ every: Every, at: At.optional() }).optional(),
  timeoutSec: z.number().int().positive().default(900),
  tables: z.array(z.string().regex(/^[a-z_][a-z0-9_]*$/, 'tables: names in schema data, without the schema')).default([]),
  env: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).default([]),
  /**
   * Env names filled from an engine secret store at run time, e.g.
   * `{ "IG_TOKEN": "social-token:instagram:konradgnat" }` (the encrypted, refreshed
   * collector token). The value never touches the vault.
   */
  secrets: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.string().regex(/^social-token:instagram:[a-z0-9._]+$/, 'secrets: social-token:instagram:<account>')).default({}),
  config: z.record(z.string(), z.unknown()).default({}),
  enabled: z.boolean().default(true),
});

export type ConnectorSchedule = { every: string; at?: string };
export type ConnectorDef = z.infer<typeof Def> & { dir: string };
export interface ConnectorError { name: string; error: string }

export function connectorsDir(dataDir: string): string {
  return join(dataDir, 'connectors');
}

export function loadConnectors(dataDir: string): { defs: ConnectorDef[]; errors: ConnectorError[] } {
  const root = connectorsDir(dataDir);
  const defs: ConnectorDef[] = [];
  const errors: ConnectorError[] = [];
  if (!existsSync(root)) return { defs, errors };
  for (const name of readdirSync(root).sort()) {
    const dir = join(root, name);
    if (!statSync(dir).isDirectory()) continue;
    const file = join(dir, 'connector.json');
    if (!existsSync(file)) { errors.push({ name, error: 'no connector.json' }); continue; }
    try {
      const parsed = Def.safeParse(JSON.parse(readFileSync(file, 'utf8')));
      if (!parsed.success) {
        errors.push({ name, error: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') });
        continue;
      }
      if (parsed.data.name !== name) { errors.push({ name, error: `name "${parsed.data.name}" does not match its folder` }); continue; }
      defs.push({ ...parsed.data, dir });
    } catch (err) {
      errors.push({ name, error: `connector.json: ${(err as Error).message}` });
    }
  }
  return { defs, errors };
}

const UNIT = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

export function parseEvery(s: string): number {
  const m = /^(\d+)([mhd])$/.exec(s);
  if (!m || Number(m[1]) <= 0) throw new Error(`bad schedule "${s}": want e.g. 15m, 6h, 1d`);
  return Number(m[1]) * UNIT[m[2] as keyof typeof UNIT];
}

/**
 * The most recent scheduled moment at or before `now`. Slots are anchored at the
 * UTC day start (or at `at` for whole-day intervals), so `6h` runs at 00, 06, 12, 18 UTC.
 */
export function lastScheduledAt(schedule: ConnectorSchedule, now: Date): Date {
  const step = parseEvery(schedule.every);
  let anchor = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (schedule.at) {
    const [h, m] = schedule.at.split(':').map(Number);
    anchor += (h! * 60 + m!) * 60_000;
  }
  const t = now.getTime();
  if (t >= anchor) return new Date(anchor + Math.floor((t - anchor) / step) * step);
  // Before today's anchor: step back whole intervals (a 1d schedule lands on yesterday's slot).
  return new Date(anchor - Math.ceil((anchor - t) / step) * step);
}

export function nextScheduledAt(schedule: ConnectorSchedule, now: Date): Date {
  return new Date(lastScheduledAt(schedule, now).getTime() + parseEvery(schedule.every));
}

/** Due when it has never started, or hasn't started since the last scheduled moment. */
export function isDue(schedule: ConnectorSchedule | undefined, lastStart: Date | null, now: Date): boolean {
  if (!schedule) return false;
  if (!lastStart) return true;
  return lastStart.getTime() < lastScheduledAt(schedule, now).getTime();
}
