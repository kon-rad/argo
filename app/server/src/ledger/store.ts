import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { brotliCompressSync, brotliDecompressSync, constants as Z } from 'node:zlib';
import { sha256 } from '../archive/clean.js';
import type { RecordKind, WireRow } from './types.js';

/**
 * The machine's own copy of every agent turn, in one SQLite file. Every insert or
 * change takes the next `seq`, so the syncer has one ordered stream across all
 * kinds: it sends rows above the server's last acknowledged seq. An unchanged row
 * (same JSON) keeps its seq and is never resent. `data` is the row's JSON,
 * brotli-compressed with a 4 MB window, which catches the same tool output repeated
 * inside one record (measured on real transcripts: 2.9x, against deflate's 2.3x).
 */
const BROTLI = { params: { [Z.BROTLI_PARAM_QUALITY]: 5, [Z.BROTLI_PARAM_LGWIN]: 22, [Z.BROTLI_PARAM_MODE]: Z.BROTLI_MODE_TEXT } };
const pack = (json: string): Uint8Array => brotliCompressSync(json, BROTLI);
const unpack = (blob: Uint8Array): string => brotliDecompressSync(blob).toString('utf8');
const SCHEMA_VERSION = 1;
const SCHEMA = `
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE records (
  kind TEXT NOT NULL, key TEXT NOT NULL, source TEXT, session_key TEXT, ts TEXT,
  seq INTEGER NOT NULL, sha TEXT NOT NULL, data BLOB NOT NULL, pruned INTEGER NOT NULL DEFAULT 0,
  first_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (kind, key));
CREATE UNIQUE INDEX records_seq ON records (seq);
CREATE INDEX records_session ON records (session_key) WHERE session_key IS NOT NULL;
CREATE TABLE cursors (name TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE quarantine (kind TEXT NOT NULL, key TEXT NOT NULL, seq INTEGER NOT NULL, error TEXT NOT NULL, at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1, requeued_at TEXT, PRIMARY KEY (kind, key));
`;

export interface PutOpts { source?: string | null; sessionKey?: string | null; ts?: string | null }
export interface SyncState {
  ackedSeq: number; lastOkAt: string | null; lastError: string | null; fails: number; nextAttemptAt: string | null;
}

export class Ledger {
  readonly db: DatabaseSync;
  private readonly st: Record<string, StatementSync>;
  private inTx = false;

  /** `busyTimeoutMs`: how long a write waits for the other process's transaction (the proxy keeps it short). */
  constructor(path: string, opts: { busyTimeoutMs?: number } = {}) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // auto_vacuum only takes effect on an empty file: set before the first table. Incremental, so prune
    // frees pages in place instead of VACUUM's full temporary copy (laptops prune because disk is short).
    this.db.exec(`PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=${opts.busyTimeoutMs ?? 10000};`);
    const version = Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    if (version === 0) {
      this.db.exec(`BEGIN; ${SCHEMA}
        INSERT INTO meta (k, v) VALUES ('seq', '0'), ('acked_seq', '0'), ('fails', '0'), ('ledger_id', '${randomUUID()}');
        PRAGMA user_version=${SCHEMA_VERSION}; COMMIT;`);
    } else if (version > SCHEMA_VERSION) {
      throw new Error(`ledger.db is schema v${version}, this build knows v${SCHEMA_VERSION}: update the ledger bundle`);
    }
    this.st = {
      sha: this.db.prepare('SELECT sha FROM records WHERE kind=? AND key=?'),
      get: this.db.prepare('SELECT data FROM records WHERE kind=? AND key=? AND pruned=0'),
      seq: this.db.prepare(`UPDATE meta SET v = CAST(v AS INTEGER) + 1 WHERE k='seq' RETURNING v`),
      put: this.db.prepare(`INSERT INTO records (kind, key, source, session_key, ts, seq, sha, data) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT (kind, key) DO UPDATE SET source=excluded.source, session_key=excluded.session_key, ts=excluded.ts,
          seq=excluded.seq, sha=excluded.sha, data=excluded.data, pruned=0`),
      meta: this.db.prepare('SELECT v FROM meta WHERE k=?'),
      setMeta: this.db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v=excluded.v'),
      delMeta: this.db.prepare('DELETE FROM meta WHERE k=?'),
      cursor: this.db.prepare('SELECT value FROM cursors WHERE name=?'),
      setCursor: this.db.prepare('INSERT INTO cursors (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value=excluded.value'),
      pending: this.db.prepare('SELECT seq, kind, key, data FROM records WHERE seq > ? ORDER BY seq LIMIT ?'),
      quarantine: this.db.prepare(`INSERT INTO quarantine (seq, kind, key, error, at) VALUES (?,?,?,?,?)
        ON CONFLICT (kind, key) DO UPDATE SET seq=excluded.seq, error=excluded.error, at=excluded.at,
          attempts=quarantine.attempts + 1, requeued_at=NULL`),
    };
  }

  close(): void { this.db.close(); }

  /** Runs `fn` in one write transaction: a crash mid-file leaves the ledger and its cursor in step. */
  tx<T>(fn: () => T): T {
    if (this.inTx) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.inTx = true;
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.inTx = false;
    }
  }

  /**
   * Stores `data` under (kind, key). Returns false when the same JSON is already there (no new seq).
   * Always inside a write transaction: the collector and the capture proxy are separate processes,
   * and a seq taken but not yet committed must never sit below one the syncer has already acknowledged.
   */
  put(kind: RecordKind, key: string, data: Record<string, unknown>, opts: PutOpts = {}): boolean {
    if (!this.inTx) return this.tx(() => this.put(kind, key, data, opts));
    const json = JSON.stringify(data);
    const sha = sha256(json);
    const prev = this.st.sha!.get(kind, key) as { sha: string } | undefined;
    if (prev?.sha === sha) return false;
    const { v } = this.st.seq!.get() as { v: string };
    this.st.put!.run(kind, key, opts.source ?? null, opts.sessionKey ?? null, opts.ts ?? null, Number(v), sha, pack(json));
    return true;
  }

  get<T = Record<string, unknown>>(kind: RecordKind, key: string): T | null {
    const row = this.st.get!.get(kind, key) as { data: Uint8Array } | undefined;
    return row ? (JSON.parse(unpack(row.data)) as T) : null;
  }

  cursor<T>(name: string): T | null {
    const row = this.st.cursor!.get(name) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : null;
  }

  setCursor(name: string, value: unknown): void { this.st.setCursor!.run(name, JSON.stringify(value)); }

  meta(k: string): string | null { return (this.st.meta!.get(k) as { v: string } | undefined)?.v ?? null; }

  setMeta(k: string, v: string | number | null): void {
    if (v === null) this.st.delMeta!.run(k);
    else this.st.setMeta!.run(k, String(v));
  }

  get ledgerId(): string { return this.meta('ledger_id')!; }
  get headSeq(): number { return Number(this.meta('seq')); }

  syncState(): SyncState {
    return {
      ackedSeq: Number(this.meta('acked_seq') ?? 0), lastOkAt: this.meta('last_ok_at'), lastError: this.meta('last_error'),
      fails: Number(this.meta('fails') ?? 0), nextAttemptAt: this.meta('next_attempt_at'),
    };
  }

  /** Rows after `afterSeq`, in seq order, up to `maxBytes` of JSON (always at least one row). */
  pending(afterSeq: number, maxBytes: number, maxRows = 5000): WireRow[] {
    const out: WireRow[] = [];
    let bytes = 0;
    for (const r of this.st.pending!.all(afterSeq, maxRows) as Array<{ seq: number; kind: RecordKind; key: string; data: Uint8Array }>) {
      const json = unpack(r.data);
      if (out.length && bytes + json.length > maxBytes) break;
      out.push({ seq: Number(r.seq), kind: r.kind, key: r.key, data: JSON.parse(json) as Record<string, unknown> });
      bytes += json.length;
    }
    return out;
  }

  /**
   * Empties rows the server has acknowledged whose turn is older than `days`, then returns
   * the pages to the filesystem. The key and hash stay, so a collector that reads the same
   * turn again (Hermes re-reads a whole state.db) sees it unchanged and doesn't resend it.
   * Unsynced and quarantined rows are never touched; sessions and counters are small and stay.
   */
  prune(days: number, now = new Date()): number {
    const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
    const r = this.tx(() => this.db.prepare(`UPDATE records SET data = x'', pruned = 1
      WHERE pruned = 0 AND seq <= ? AND kind IN ('message', 'call', 'exchange', 'blob') AND ts IS NOT NULL AND ts < ?
        AND NOT EXISTS (SELECT 1 FROM quarantine q WHERE q.kind = records.kind AND q.key = records.key AND q.requeued_at IS NULL)`)
      .run(this.syncState().ackedSeq, cutoff));
    const n = Number(r.changes);
    if (n) this.db.exec('PRAGMA incremental_vacuum; PRAGMA wal_checkpoint(TRUNCATE);');
    return n;
  }

  quarantine(row: WireRow, error: string): void {
    this.st.quarantine!.run(row.seq, row.kind, row.key, error.slice(0, 2000), new Date().toISOString());
  }

  /**
   * Puts quarantined rows back in the queue with a fresh seq. A row the server refused may
   * only have been newer than the server (a kind it didn't know yet), so refusals are retried:
   * the scheduled run requeues rows refused more than a day ago, up to `maxAttempts` times;
   * `ledger requeue` retries every one at once (after a server upgrade).
   */
  requeue(opts: { olderThanMs?: number; maxAttempts?: number; now?: Date } = {}): number {
    const now = opts.now ?? new Date();
    const cutoff = new Date(now.getTime() - (opts.olderThanMs ?? 0)).toISOString();
    return this.tx(() => {
      const rows = this.db.prepare(`SELECT q.kind, q.key FROM quarantine q JOIN records r ON r.kind = q.kind AND r.key = q.key
        WHERE q.requeued_at IS NULL AND q.at <= ? AND q.attempts < ?`).all(cutoff, opts.maxAttempts ?? Number.MAX_SAFE_INTEGER) as Array<{ kind: string; key: string }>;
      const bump = this.db.prepare('UPDATE records SET seq = ? WHERE kind = ? AND key = ?');
      const mark = this.db.prepare('UPDATE quarantine SET requeued_at = ? WHERE kind = ? AND key = ?');
      for (const r of rows) {
        const { v } = this.st.seq!.get() as { v: string };
        bump.run(Number(v), r.kind, r.key);
        mark.run(now.toISOString(), r.kind, r.key);
      }
      return rows.length;
    });
  }

  stats(): Record<string, unknown> {
    const s = this.syncState();
    const kinds = Object.fromEntries((this.db.prepare('SELECT kind, count(*) n FROM records WHERE pruned=0 GROUP BY kind').all() as Array<{ kind: string; n: number }>)
      .map((r) => [r.kind, Number(r.n)]));
    const sources = Object.fromEntries((this.db.prepare(`SELECT source, count(*) n FROM records WHERE kind='session' GROUP BY source`).all() as Array<{ source: string; n: number }>)
      .map((r) => [r.source, Number(r.n)]));
    const pend = this.db.prepare('SELECT count(*) n, min(ts) oldest FROM records WHERE seq > ?').get(s.ackedSeq) as { n: number; oldest: string | null };
    const tokens = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 };
    for (const r of this.db.prepare(`SELECT data FROM records WHERE kind='call' AND pruned=0`).iterate() as Iterable<{ data: Uint8Array }>) {
      const c = JSON.parse(unpack(r.data)) as Record<string, number>;
      tokens.calls++;
      tokens.input += c.inputTokens ?? 0; tokens.output += c.outputTokens ?? 0; tokens.cacheRead += c.cacheReadTokens ?? 0;
      tokens.cacheWrite += c.cacheWriteTokens ?? 0; tokens.thinking += c.thinkingTokens ?? 0;
    }
    const quarantined = Number((this.db.prepare('SELECT count(*) n FROM quarantine WHERE requeued_at IS NULL').get() as { n: number }).n);
    return {
      ledgerId: this.ledgerId, headSeq: this.headSeq, records: kinds, sessionsBySource: sources,
      calls: tokens,
      sync: { ...s, pending: Number(pend.n), oldestPendingTs: pend.oldest, quarantined },
    };
  }
}
