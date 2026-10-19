import { closeSync, existsSync, mkdtempSync, openSync, readSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { findHomes, hermesTimezone } from '../agents/homes.js';
import { parseClaudeJsonl } from '../archive/claude.js';
import { readHermes } from '../archive/hermes.js';
import { fingerprintOf } from '../archive/stage.js';
import { callsFromRecords } from '../usage/claudeCalls.js';
import { readHermesCounters } from '../usage/hermesCounters.js';
import { splitJsonLines } from '../usage/lines.js';
import { readFrom } from '../usage/readFrom.js';
import { transcriptIds } from '../usage/transcript.js';
import { walkFiles } from '../usage/walkFiles.js';
import type { Ledger } from './store.js';

export interface CollectCounts { files: number; sessions: number; messages: number; calls: number; counters: number; errors: string[] }
export const emptyCounts = (): CollectCounts => ({ files: 0, sessions: 0, messages: 0, calls: 0, counters: 0, errors: [] });

/** The parsers stamp a host on every row; the ledger stores rows without one (the server's token decides it). */
const LOCAL = 'local';
function noHost<T extends { host?: unknown }>(o: T): Omit<T, 'host'> {
  const { host: _host, ...rest } = o;
  return rest;
}
const iso = (d: unknown): string | null => (d instanceof Date ? d.toISOString() : typeof d === 'string' ? d : null);

interface ClaudeCursor { fingerprint: string; offset: number; lines: number }

/** Up to `max` bytes from `offset`; a single line longer than that is read whole so the file still moves. */
function readSlice(path: string, offset: number, max: number): Buffer {
  const size = statSync(path).size;
  if (size - offset <= max) return readFrom(path, offset);
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(max);
    readSync(fd, buf, 0, max, offset);
    return buf.includes(0x0a) ? buf : readFrom(path, offset);
  } finally {
    closeSync(fd);
  }
}

/**
 * Claude Code: every `.jsonl` under the projects dir, read from its byte cursor.
 * A file whose first line changed, or that shrank, is read again from the start;
 * rows already in the ledger with the same JSON are not re-queued.
 */
// Small slices keep each write transaction short: the capture proxy writes to the same file and must not wait.
export function collectClaude(ledger: Ledger, dir: string, provider: string, maxBytesPerFile = 8 * 1024 * 1024): CollectCounts {
  const c = emptyCounts();
  if (!existsSync(dir)) return c;
  for (const path of walkFiles(dir).filter((p) => p.endsWith('.jsonl')).sort()) {
    try {
      const size = statSync(path).size;
      if (!size) continue;
      const fingerprint = fingerprintOf(path);
      const name = `claude:${path}`;
      const prev = ledger.cursor<ClaudeCursor>(name);
      const keep = prev && prev.fingerprint === fingerprint && size >= prev.offset ? prev : null;
      const offset = keep?.offset ?? 0;
      const startLine = keep?.lines ?? 0;
      if (offset >= size) continue;
      const buf = readSlice(path, offset, maxBytesPerFile);
      const { records, consumedBytes, lines } = splitJsonLines(buf);
      if (!consumedBytes) continue; // only a partial line so far
      const ids = transcriptIds(path);
      const sid = ids.sessionExternalId;
      const chunk = parseClaudeJsonl(buf.subarray(0, consumedBytes), startLine);
      const calls = callsFromRecords(records, LOCAL, sid);
      ledger.tx(() => {
        if (chunk.messages.length) {
          const skey = `claude-code|${sid}`;
          const before = ledger.get<{ title: string | null; model: string | null }>('session', skey);
          if (ledger.put('session', skey, {
            source: 'claude-code', externalId: sid, parentExternalId: ids.parentSid, project: ids.project,
            title: chunk.title ?? before?.title ?? null, model: chunk.model ?? before?.model ?? null, provider,
          }, { source: 'claude-code', sessionKey: skey })) c.sessions++;
          for (const m of chunk.messages) {
            const data = { ...m, ts: iso(m.ts), sessionExternalId: sid, isSidechain: ids.parentSid ? true : m.isSidechain };
            if (ledger.put('message', `${skey}|${m.externalId}`, data, { source: 'claude-code', sessionKey: skey, ts: data.ts })) c.messages++;
          }
        }
        for (const call of calls) {
          const key = `claude-code|${call.callId}`;
          const before = ledger.get<{ outputTokens: number; ts: string }>('call', key);
          const ts = iso(call.ts)!;
          // Claude Code repeats a response's usage on every content block: keep the fullest, timed at the first.
          if (before && before.outputTokens > call.outputTokens) continue;
          const data = { ...noHost(call), ts: before && before.ts < ts ? before.ts : ts, provider };
          if (ledger.put('call', key, data, { source: 'claude-code', sessionKey: `claude-code|${sid}`, ts: data.ts })) c.calls++;
        }
        ledger.setCursor(name, { fingerprint, offset: offset + consumedBytes, lines: startLine + lines } satisfies ClaudeCursor);
      });
      c.files++;
    } catch (err) {
      c.errors.push(`claude ${path}: ${(err as Error).message}`);
    }
  }
  return c;
}

/** Source name and profile label for one Hermes state.db: the main home keeps the archive's plain 'hermes'. */
export function hermesNames(homeLabel: string, profile: string): { source: string; profile: string } {
  const p = homeLabel === 'main' ? profile : profile === 'main' ? homeLabel : `${homeLabel}-${profile}`;
  return { source: p === 'main' ? 'hermes' : `hermes:${p}`, profile: p };
}

const HERMES_TX_ROWS = 2000;

function fileSig(path: string): string {
  const parts = [path, `${path}-wal`].map((p) => (existsSync(p) ? `${statSync(p).size}:${statSync(p).mtimeMs}` : '-'));
  return parts.join('|');
}

/**
 * Hermes: each home and each of its profiles. A state.db that hasn't changed since
 * the last run (size and mtime of the file and its WAL) is skipped; a changed one is
 * copied with SQLite's online backup (never read in place: Hermes holds it open),
 * read whole, and only rows whose JSON changed are queued.
 */
export async function collectHermes(ledger: Ledger, homes: Array<{ dir: string; label: string }>): Promise<CollectCounts> {
  const c = emptyCounts();
  const tmp = mkdtempSync(join(tmpdir(), 'sb-ledger-'));
  try {
    for (const home of homes) {
      if (!existsSync(home.dir)) continue;
      const tz = hermesTimezone(home.dir);
      for (const h of findHomes(home.dir)) {
        const src = join(h.dir, 'state.db');
        if (!existsSync(src)) continue;
        const { source, profile } = hermesNames(home.label, h.profile);
        try {
          const name = `hermes:${src}`;
          const sig = fileSig(src);
          if (ledger.cursor<string>(name) === sig) continue;
          const copy = join(tmp, `${profile}.db`);
          const db = new DatabaseSync(src, { readOnly: true });
          try { await backup(db, copy); } finally { db.close(); }
          const { sessions, messages } = readHermes(copy, LOCAL);
          const counters = readHermesCounters(copy, LOCAL, profile);
          rmSync(copy, { force: true }); // a plaintext copy of the conversations: never leave it behind
          const meta = home.label === 'main' ? { profile, timezone: tz } : { profile, timezone: tz, home: home.label };
          // Sessions, then messages and counters, a few thousand rows per transaction (the proxy shares the
          // file); the cursor moves last, so a crash midway only means the same rows are read and skipped next time.
          const writes: Array<() => void> = [];
          for (const s of sessions) {
            const skey = `${source}|${s.externalId}`;
            const data = { ...noHost(s), source, startedAt: iso(s.startedAt), endedAt: iso(s.endedAt), meta: { ...s.meta, ...meta } };
            writes.push(() => { if (ledger.put('session', skey, data, { source, sessionKey: skey, ts: data.startedAt })) c.sessions++; });
          }
          for (const m of messages) {
            const skey = `${source}|${m.sessionExternalId}`;
            const data = { ...m, ts: iso(m.ts) };
            writes.push(() => { if (ledger.put('message', `${skey}|${m.externalId}`, data, { source, sessionKey: skey, ts: data.ts })) c.messages++; });
          }
          for (const k of counters) {
            const data = { ...noHost(k), startedAt: iso(k.startedAt), endedAt: iso(k.endedAt) };
            writes.push(() => { if (ledger.put('counter', `${profile}|${k.sessionId}`, data, { source, sessionKey: `${source}|${k.sessionId}`, ts: data.endedAt })) c.counters++; });
          }
          for (let i = 0; i < writes.length; i += HERMES_TX_ROWS) ledger.tx(() => writes.slice(i, i + HERMES_TX_ROWS).forEach((w) => w()));
          ledger.setCursor(name, sig);
          c.files++;
        } catch (err) {
          c.errors.push(`hermes ${src}: ${(err as Error).message}`);
        }
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return c;
}
