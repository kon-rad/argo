import { gzipSync } from 'node:zlib';
import type { Ledger } from './store.js';
import type { LedgerConfig, WireBatch, WireRow } from './types.js';

/**
 * Ledger → server. Sends rows above the last acknowledged seq, in seq order, and
 * moves the mark only after the server confirms a whole batch. Offline, a 5xx or a
 * missing route is "try again later" with backoff; nothing local changes. A batch the
 * server rejects as malformed is split until the bad row is alone, and that row is
 * quarantined (kept locally, reported in `status`) so one row can't stall the queue.
 */
export interface SyncDeps { fetch: typeof fetch; now: () => Date; bundle: string; log?: (msg: string) => void }
export interface SyncResult {
  status: 'disabled' | 'waiting' | 'ok' | 'retry' | 'auth';
  sent: number; batches: number; quarantined: number; ackedSeq: number; error: string | null;
}

type Delivered = { kind: 'ok' } | { kind: 'retry' | 'auth'; message: string };
type Outcome = Delivered | { kind: 'reject'; message: string };

export const BACKOFF_BASE_MS = 2 * 60_000;
export const BACKOFF_MAX_MS = 30 * 60_000;
export function backoffMs(fails: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, fails - 1));
}

export async function syncOnce(ledger: Ledger, cfg: LedgerConfig, deps: SyncDeps,
  opts: { force?: boolean; maxBatches?: number } = {}): Promise<SyncResult> {
  const token = process.env.SB_LEDGER_TOKEN || cfg.token;
  const state = ledger.syncState();
  const result: SyncResult = { status: 'ok', sent: 0, batches: 0, quarantined: 0, ackedSeq: state.ackedSeq, error: null };
  if (!cfg.server || !token) return { ...result, status: 'disabled' };
  if (!opts.force && state.nextAttemptAt && Date.parse(state.nextAttemptAt) > deps.now().getTime()) {
    return { ...result, status: 'waiting', error: state.lastError };
  }
  const url = `${cfg.server.replace(/\/+$/, '')}/api/ingest/batch`;

  const post = async (rows: WireRow[]): Promise<Outcome> => {
    const batch: WireBatch = { v: 1, ledgerId: ledger.ledgerId, bundle: deps.bundle, fromSeq: rows[0]!.seq, toSeq: rows.at(-1)!.seq, rows };
    let res: Response;
    try {
      res = await deps.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', authorization: `Bearer ${token}` },
        body: gzipSync(JSON.stringify(batch)),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (err) {
      return { kind: 'retry', message: `server unreachable: ${(err as Error).message}` };
    }
    if (res.ok) return { kind: 'ok' };
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body?.error?.message) message += `: ${body.error.message}`;
    } catch { /* not JSON */ }
    if (res.status === 401 || res.status === 403) return { kind: 'auth', message };
    // 422 is the server's own "these rows are malformed"; 413 a row too big to ever fit. A bare 400 comes
    // from the body parser (a cut-off upload, a gzip/length mismatch): network noise, so retried.
    if (res.status === 413 || res.status === 422) return { kind: 'reject', message };
    return { kind: 'retry', message }; // 400, 404 (route not deployed yet), 429, 5xx
  };

  const deliver = async (rows: WireRow[]): Promise<Delivered> => {
    const r = await post(rows);
    if (r.kind !== 'reject') return r;
    if (rows.length === 1) {
      ledger.quarantine(rows[0]!, r.message);
      result.quarantined++;
      deps.log?.(`quarantined seq ${rows[0]!.seq} (${rows[0]!.kind} ${rows[0]!.key}): ${r.message}`);
      return { kind: 'ok' };
    }
    const mid = Math.ceil(rows.length / 2);
    const left = await deliver(rows.slice(0, mid));
    return left.kind === 'ok' ? deliver(rows.slice(mid)) : left;
  };

  let acked = state.ackedSeq;
  const maxBatches = opts.maxBatches ?? 500;
  while (result.batches < maxBatches) {
    const rows = ledger.pending(acked, cfg.batchBytes);
    if (!rows.length) break;
    const r = await deliver(rows);
    if (r.kind !== 'ok') {
      const fails = state.fails + 1;
      ledger.setMeta('fails', fails);
      ledger.setMeta('last_error', r.message);
      ledger.setMeta('next_attempt_at', new Date(deps.now().getTime() + backoffMs(fails)).toISOString());
      return { ...result, status: r.kind, ackedSeq: acked, error: r.message };
    }
    acked = rows.at(-1)!.seq;
    ledger.setMeta('acked_seq', acked);
    result.sent += rows.length;
    result.batches++;
  }
  ledger.setMeta('fails', 0);
  ledger.setMeta('last_error', null);
  ledger.setMeta('next_attempt_at', null);
  ledger.setMeta('last_ok_at', deps.now().toISOString());
  return { ...result, ackedSeq: acked };
}
