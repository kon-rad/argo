import { query } from '../db.js';
import { recordHealth } from './health.js';
import type { CollectionHealth } from './health-wire.js';
import type { SourceMeasurement } from './sourceHealth.js';

export async function producerHealth(host: string, collector: string, runtime: string, path: string,
  startedAt: string, measurement: SourceMeasurement | null, failed: boolean, reason: CollectionHealth['reason'] = null) {
  if (measurement?.quarantined) { failed = true; reason ??= 'rejected'; }
  const { rows } = await query('SELECT nextval(\'collection_attempt_sequence\') AS seq');
  await recordHealth(host, { v: 1, collectorInstance: collector, runtime, path, attemptSeq: Number(rows[0]!.seq),
    collectorVersion: 'collection-3', startedAt, endedAt: new Date().toISOString(), outcome: reason === 'unsupported' ? 'unsupported' : failed ? 'retry' : 'ok',
    observedAt: null, importedAt: null, backlog: null, backlogUnit: null, oldestPendingAt: null, rejected: null,
    quarantined: null, ...measurement, reason: failed ? reason ?? 'collection' : null,
    capabilities: measurement ? ['heartbeat', 'backlog', 'source-time', 'quarantine'] : ['heartbeat'] });
}
