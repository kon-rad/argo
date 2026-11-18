import { join } from 'node:path';
import { readHermes } from '../archive/hermes.js';
import { readHermesCounters } from '../usage/hermesCounters.js';
import { readHermesCalls, hermesCallFiles, hermesCallFromLine } from '../usage/hermesCalls.js';
import { existsSync, readFileSync } from 'node:fs';
import { walkFiles } from '../usage/walkFiles.js';
import { measureJsonl, latest } from '../usage/sourceHealth.js';
import { fingerprintOf } from '../archive/stage.js';
import { hermesNames } from './collect.js';
import { findHomes } from '../agents/homes.js';
import type { CollectionHealth } from '../usage/health-wire.js';
import type { Ledger } from './store.js';
import type { LedgerConfig } from './types.js';

/** No write transaction spans a network operation. Missing source/path measurements stay null. */
export async function reportLedgerHealth(ledger: Ledger, cfg: LedgerConfig, version: string, startedAt: string,
  failed: boolean, log: (s: string) => void, reason: 'deadline' | 'collection' = 'collection'): Promise<void> {
  const token = process.env.SB_LEDGER_TOKEN || cfg.token;
  if (!cfg.server || !token) return;
  const seq = Number(ledger.meta('health_attempt') ?? 0) + 1;
  ledger.setMeta('health_attempt', seq);
  const roots = [
    ...(cfg.claudeProjectsDir ? [{ runtime: 'claude-code', path: cfg.claudeProjectsDir }] : []),
    ...cfg.hermesHomes.flatMap(h => findHomes(h.dir).map(p => ({ runtime: 'hermes', path: p.dir, ...hermesNames(h.label, p.profile) }))),
  ];
  const deadline = Date.now() + 10_000;
  for (const stream of roots) {
    // Upgrade older rows' provenance without changing their content, sequence or acknowledgement.
    const source = 'source' in stream ? stream.source : 'claude-code';
    ledger.db.prepare('UPDATE records SET origin_path=? WHERE origin_path IS NULL AND source=?').run(stream.path, source!);
    const measurement = ledger.health(stream.path);
    let sourceFailed = false;
    const pendingSource = (ts: string | null) => {
      measurement.backlog++;
      measurement.oldestPendingAt = [measurement.oldestPendingAt, ts].filter((v): v is string => !!v).sort()[0] ?? null;
    };
    if ('source' in stream) {
      try {
        const src = join(stream.path, 'state.db');
        if (existsSync(src)) {
          const data = readHermes(src, 'local');
          for (const m of data.messages) {
            const ts = m.ts?.toISOString() ?? null;
            measurement.observedAt = latest(measurement.observedAt, ts);
            if (!ledger.matches('message', `${source}|${m.sessionExternalId}|${m.externalId}`, { ...m, ts })) pendingSource(ts);
          }
          for (const c of readHermesCounters(src, 'local', stream.profile!)) {
            const ts = (c.endedAt ?? c.startedAt)?.toISOString() ?? null;
            measurement.observedAt = latest(measurement.observedAt, ts);
            const { host: _host, ...rest } = c;
            if (!ledger.matches('counter', `${stream.profile}|${c.sessionId}`, { ...rest,
              startedAt: c.startedAt?.toISOString() ?? null, endedAt: c.endedAt?.toISOString() ?? null })) pendingSource(ts);
          }
        }
        for (const c of readHermesCalls(stream.path, source!, 'local')) {
          const ts = c.ts.toISOString();
          measurement.observedAt = latest(measurement.observedAt, ts);
          const prev = ledger.get<{ outputTokens: number }>('call', `${source}|${c.callId}`);
          if (!prev || prev.outputTokens < c.outputTokens) pendingSource(ts);
        }
        for (const file of hermesCallFiles(stream.path)) {
          for (const line of readFileSync(file, 'utf8').split('\n').filter(s => s.trim())) {
            if (!hermesCallFromLine(line, source!, 'local')) measurement.rejected++;
          }
        }
      } catch { sourceFailed = true; log('stage=health-source reason=collection'); }
    }
    if (stream.runtime === 'claude-code' && existsSync(stream.path)) {
      for (const path of walkFiles(stream.path).filter(p => p.endsWith('.jsonl'))) {
        const cursor = ledger.cursor<{ offset: number; fingerprint: string }>(`claude:${path}`);
        const offset = cursor?.fingerprint === fingerprintOf(path) ? cursor.offset : 0;
        const raw = measureJsonl(path, offset, 'records');
        measurement.observedAt = latest(measurement.observedAt, raw.observedAt);
        measurement.backlog += raw.backlog;
        measurement.oldestPendingAt = [measurement.oldestPendingAt, raw.oldestPendingAt].filter((v): v is string => !!v).sort()[0] ?? null;
        measurement.rejected += raw.rejected;
      }
    }
    const body: CollectionHealth = {
      v: 1, collectorInstance: ledger.ledgerId, runtime: stream.runtime, path: stream.path, attemptSeq: seq, collectorVersion: version,
      startedAt, endedAt: new Date().toISOString(), outcome: !existsSync(stream.path) ? 'unsupported' : failed || sourceFailed || measurement.rejected || measurement.quarantined ? 'retry' : 'ok',
      reason: !existsSync(stream.path) ? 'unsupported' : failed ? reason : sourceFailed ? 'collection' : measurement.rejected || measurement.quarantined ? 'rejected' : null, ...measurement, backlog: sourceFailed ? null : measurement.backlog,
      oldestPendingAt: sourceFailed ? null : measurement.oldestPendingAt, rejected: sourceFailed ? null : measurement.rejected, backlogUnit: 'records',
      capabilities: ['heartbeat', 'source-time', 'backlog', 'quarantine'],
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
