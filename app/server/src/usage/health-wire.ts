import { z } from 'zod';

const time = z.iso.datetime({ offset: true });
const measurement = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
export const healthSchema = z.object({
  v: z.literal(1), collectorInstance: z.string().min(1).max(128), runtime: z.string().min(1).max(64),
  path: z.string().min(1).max(1024), attemptSeq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  collectorVersion: z.string().min(1).max(128), startedAt: time, endedAt: time,
  outcome: z.enum(['ok', 'retry', 'auth', 'unsupported']),
  observedAt: time.nullable(), importedAt: time.nullable(), backlog: measurement,
  backlogUnit: z.enum(['bytes', 'records']).nullable().optional(),
  oldestPendingAt: time.nullable(), rejected: measurement, quarantined: measurement,
  reason: z.enum(['deadline', 'stdin', 'spawn', 'ack', 'sqlite-busy', 'route', 'network', 'auth', 'rejected', 'collection', 'unsupported']).nullable(),
  capabilities: z.array(z.enum(['heartbeat', 'backlog', 'source-time', 'quarantine'])).max(4),
}).strict().refine(x => Date.parse(x.endedAt) >= Date.parse(x.startedAt), 'end before start');
export type CollectionHealth = z.infer<typeof healthSchema>;
export interface ExpectedStream { host: string; collectorInstance: string; runtime: string; path: string; intervalSec: number; state: 'enabled' | 'paused' | 'retired' }

/** Liveness uses receipt time. Source activity is deliberately independent. */
export function streamState(row: { received_at: string | Date; outcome: string; backlog: string | number | null } | undefined,
  intervalSec = 120, now = Date.now()): 'unknown' | 'offline' | 'stale' | 'healthy' {
  if (!row) return 'unknown';
  if (now - new Date(row.received_at).getTime() > intervalSec * 3000 + 60_000) return 'offline';
  if (row.outcome !== 'ok' || (row.backlog !== null && Number(row.backlog) > 0)) return 'stale';
  return 'healthy';
}
