import type { CollectionHealth } from '../usage/health-wire.js';
import type { Ledger } from './store.js';
import type { LedgerConfig } from './types.js';

/** No write transaction spans a network operation. Missing source/path measurements stay null. */
export async function reportLedgerHealth(ledger: Ledger, cfg: LedgerConfig, version: string, startedAt: string,
  failed: boolean, log: (s: string) => void): Promise<void> {
  const token = process.env.SB_LEDGER_TOKEN || cfg.token;
  if (!cfg.server || !token) return;
  const seq = Number(ledger.meta('health_attempt') ?? 0) + 1;
  ledger.setMeta('health_attempt', seq);
  const roots = [
    ...(cfg.claudeProjectsDir ? [{ runtime: 'claude-code', path: cfg.claudeProjectsDir }] : []),
    ...cfg.hermesHomes.map(h => ({ runtime: 'hermes', path: h.dir })),
  ];
  const deadline = Date.now() + 10_000;
  for (const stream of roots) {
    const body: CollectionHealth = {
      v: 1, collectorInstance: ledger.ledgerId, ...stream, attemptSeq: seq, collectorVersion: version,
      startedAt, endedAt: new Date().toISOString(), outcome: failed ? 'retry' : 'ok',
      reason: failed ? 'collection' : null, observedAt: null, importedAt: null,
      backlog: null, oldestPendingAt: null, rejected: null, quarantined: null, capabilities: ['heartbeat'],
    };
    if (Date.now() >= deadline) { log('stage=health-end reason=deadline'); break; }
    try {
      const res = await fetch(`${cfg.server.replace(/\/+$/, '')}/api/ingest/health`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
      await res.body?.cancel();
      log(`stage=health-end reason=${res.ok ? 'ok' : res.status === 401 ? 'auth' : 'route'}`);
    } catch { log('stage=health-end reason=network'); }
  }
}
