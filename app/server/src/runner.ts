import { query } from './db.js';
import { log } from './logger.js';
import type { Connector } from './connectors/types.js';

/** Progress is advisory. One write a second keeps a 13k-file scan honest. */
const PROGRESS_INTERVAL_MS = 1000;

export interface SourceRow {
  id: number;
  kind: string;
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
}

/** Creates the run row up front so the HTTP 202 can carry a real id. */
export async function createRun(sourceId: number): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO ingest_runs (source_id, status) VALUES ($1, 'queued') RETURNING id`,
    [sourceId],
  );
  return rows[0]!.id;
}

/**
 * Owns one run's lifecycle: queued → running → ok/error. The connector only
 * has to do the work and return its stats.
 */
export async function runConnector(
  connector: Connector<unknown>,
  source: SourceRow,
  runId: number,
  signal: AbortSignal,
): Promise<void> {
  await query(`UPDATE ingest_runs SET status = 'running', started_at = now() WHERE id = $1`, [runId]);

  let lastWrite = 0;
  let inFlight: Promise<unknown> = Promise.resolve();

  try {
    const stats = await connector.run({
      sourceId: source.id,
      runId,
      config: source.config,
      signal,
      onProgress(progress) {
        const now = Date.now();
        if (now - lastWrite < PROGRESS_INTERVAL_MS) return;
        lastWrite = now;
        inFlight = query(`UPDATE ingest_runs SET progress = $2 WHERE id = $1`, [
          runId,
          JSON.stringify(progress),
        ]).catch((err) => log.warn(`progress write failed for run ${runId}:`, err));
      },
    });

    // A late progress write must not land after the terminal row.
    await inFlight;
    await query(
      `UPDATE ingest_runs
       SET status = 'ok', finished_at = now(), stats = $2, progress = '{}'
       WHERE id = $1`,
      [runId, JSON.stringify(stats ?? {})],
    );
    log.info(`run ${runId} (${source.kind}) finished`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await inFlight.catch(() => {});
    await query(
      `UPDATE ingest_runs SET status = 'error', finished_at = now(), error = $2, progress = '{}'
       WHERE id = $1`,
      [runId, message],
    );
    log.error(`run ${runId} (${source.kind}) failed: ${message}`);
    throw err;
  }
}
