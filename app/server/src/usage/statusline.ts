import type { Host } from '../archive/types.js';
import type { PlanSnapshot, PlanWindow } from './types.js';

const WINDOWS: PlanWindow[] = ['five_hour', 'seven_day'];

/** Epoch seconds to a Date, or null when the number is out of Date's range (an Invalid Date would throw in toISOString). */
function fromEpochSeconds(v: unknown): Date | null {
  if (typeof v !== 'number') return null;
  const d = new Date(v * 1000);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Lines written by bin/statusline-usage.mjs: { at, session_id, rate_limits }. */
export function parseStatuslineLog(records: unknown[], host: Host): PlanSnapshot[] {
  const out: PlanSnapshot[] = [];
  for (const rec of records as any[]) {
    const at = typeof rec?.at === 'string' ? new Date(rec.at) : null;
    if (!at || Number.isNaN(at.getTime()) || !rec.rate_limits) continue;
    for (const name of WINDOWS) {
      const w = rec.rate_limits[name];
      if (typeof w?.used_percentage !== 'number') continue;
      out.push({ host, origin: 'statusline', window: name, usedPct: w.used_percentage,
        resetsAt: fromEpochSeconds(w.resets_at), observedAt: at });
    }
  }
  return out;
}
