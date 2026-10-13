import type { ConnectorRegistry } from './connectors/index.js';
import { query } from './db.js';
import { log } from './logger.js';
import * as queue from './queue.js';
import { createRun, runConnector, type SourceRow } from './runner.js';

/**
 * Periodic rescan + re-embed. On the Mac a rescan is a button; on the server
 * the vault is rewritten underneath the app every 30 minutes by the git
 * auto-sync and the Hermes agent, and nobody is there to press it. Both
 * connectors are incremental, so an idle cycle costs a directory walk.
 */
export function startAutoSync(connectors: ConnectorRegistry, intervalMinutes: number): () => void {
  const tick = async (): Promise<void> => {
    const { rows } = await query<SourceRow>(
      `SELECT id, kind, name, config, enabled FROM sources
       WHERE enabled AND kind IN ('vault', 'embeddings')
       ORDER BY CASE kind WHEN 'vault' THEN 0 ELSE 1 END`,
    );
    for (const source of rows) {
      const connector = connectors[source.kind];
      const claim = connector ? queue.claim(source.id) : null;
      if (!connector || !claim) continue; // already running, or nothing to run it with
      try {
        const runId = await createRun(source.id);
        claim.start(runId, (rid, signal) => runConnector(connector, source, rid, signal));
      } catch (err) {
        claim.abandon(err);
        throw err;
      }
    }
  };

  const timer = setInterval(() => {
    tick().catch((err) => log.warn('scheduled sync failed:', err));
  }, intervalMinutes * 60_000);
  timer.unref();
  log.info(`auto-sync every ${intervalMinutes} min (vault scan, then embeddings)`);
  return () => clearInterval(timer);
}
