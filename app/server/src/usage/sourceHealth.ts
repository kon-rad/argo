import { existsSync, readFileSync } from 'node:fs';
import { splitJsonLines } from './lines.js';

export const latest = (...values: (string | null | undefined)[]): string | null =>
  values.reduce<string | null>((best, v) => v && (!best || v > best) ? v : best, null);

/** Only source event fields, never filesystem mtime, import time or arbitrary nested prose. */
export function eventTime(record: unknown): string | null {
  if (!record || typeof record !== 'object') return null;
  const r = record as Record<string, unknown>;
  const message = r.type === 'message' && r.message && typeof r.message === 'object' ? r.message as Record<string, unknown> : null;
  const v = message?.timestamp ?? r.timestamp ?? r.ts ?? r.observedAt ?? r.at;
  const d = typeof v === 'string' || typeof v === 'number' ? new Date(v) : null;
  return d && Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

export interface SourceMeasurement {
  observedAt: string | null; importedAt: string | null; backlog: number;
  backlogUnit: 'bytes' | 'records'; oldestPendingAt: string | null; rejected: number; quarantined: number;
}

/** Offset is the acknowledged complete prefix. Rewrites pass zero until reconciled. */
export function measureJsonl(path: string, offset: number, unit: 'bytes' | 'records' = 'bytes', quarantineAcknowledged = false): SourceMeasurement {
  const buf = existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
  const countRejected = (prefix: Buffer) => {
    const end = prefix.lastIndexOf(10);
    let rejected = 0;
    for (const line of prefix.subarray(0, end + 1).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try { JSON.parse(line); } catch { rejected++; }
    }
    return rejected;
  };
  const full = splitJsonLines(buf);
  const imported = splitJsonLines(buf.subarray(0, offset));
  const pending = splitJsonLines(buf.subarray(offset));
  const pendingTimes = pending.records.map(eventTime).filter((v): v is string => v !== null).sort();
  return { observedAt: full.records.reduce<string | null>((best, r) => latest(best, eventTime(r)), null), importedAt: imported.records.reduce<string | null>((best, r) => latest(best, eventTime(r)), null),
    backlog: unit === 'bytes' ? Math.max(0, buf.length - offset) : pending.lines + Number(pending.consumedBytes < buf.length - offset), backlogUnit: unit, oldestPendingAt: pendingTimes[0] ?? null,
    rejected: countRejected(buf), quarantined: quarantineAcknowledged ? countRejected(buf.subarray(0, offset)) : 0 };
}

export function combineMeasurements(items: SourceMeasurement[]): SourceMeasurement {
  return { observedAt: latest(...items.map(x => x.observedAt)), importedAt: latest(...items.map(x => x.importedAt)),
    backlog: items.reduce((n, x) => n + x.backlog, 0), backlogUnit: 'bytes',
    oldestPendingAt: items.map(x => x.oldestPendingAt).filter((v): v is string => !!v).sort()[0] ?? null,
    rejected: items.reduce((n, x) => n + x.rejected, 0), quarantined: items.reduce((n, x) => n + x.quarantined, 0) };
}
