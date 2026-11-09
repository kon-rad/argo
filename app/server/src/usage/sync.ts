import { sha256 } from '../archive/clean.js';
import { parseCodex } from './codex.js';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { withTransaction, type TxClient } from '../db.js';
import { parseClaudeJsonl } from '../archive/claude.js';
import { readFrom } from '../archive/ingest.js';
import { walk } from '../archive/run.js';
import { fingerprintOf } from '../archive/stage.js';
import * as archive from '../archive/store.js';
import type { Host } from '../archive/types.js';
import { callsFromRecords } from './claudeCalls.js';
import { splitJsonLines } from './lines.js';
import { transcriptIds } from './transcript.js';
import { parseRunLog } from './runLog.js';
import { parseZenTrace } from './zenTrace.js';
import { channelMeta } from '../archive/channelMeta.js';
import { parseStatuslineLog } from './statusline.js';
import * as store from './store.js';

/**
 * The server's collector: Claude Code transcripts (Telegram bot, Remote Control,
 * cc-* lanes), cc-runs logs and the status-line plan log, into the ledger. Runs as
 * hermes from secondbrain-usage-sync.timer. Every write is idempotent.
 */
/** `zenSessionsDir`: zen-agent's traces (zen.json sessionsDir); null or missing: none to read. */
export interface UsageSyncPaths { claudeProjectsDir: string; runsDir: string | null; statuslineLog: string | null; zenSessionsDir?: string | null; codexSessionsDir?: string | null }
export interface UsageSyncCounts {
  files: number; calls: number; sessions: number; messages: number; runs: number; plan: number; attached: number; errors: string[];
}

export async function ingestTranscript(tx: TxClient, host: Host, path: string, buf: Buffer, startLine: number):
  Promise<{ calls: number; sessions: number; messages: number; consumedBytes: number; lines: number }> {
  const ids = transcriptIds(path);
  const { records, consumedBytes, lines } = splitJsonLines(buf);
  const calls = callsFromRecords(records, host, ids.sessionExternalId);
  const chunk = parseClaudeJsonl(buf.subarray(0, consumedBytes), startLine);
  let sessions = 0;
  let messages = 0;
  if (chunk.messages.length) {
    const s = await archive.upsertSession(tx, {
      source: 'claude-code', host, externalId: ids.sessionExternalId, parentExternalId: ids.parentSid,
      project: ids.project, title: chunk.title, model: chunk.model, startedAt: null, endedAt: null, messageCount: null,
      inputTokens: null, outputTokens: null, costUsd: null, meta: channelMeta(chunk.channel, 'claude-code'), b2Path: null,
    });
    if (s.changed) sessions++;
    const msgs = ids.parentSid ? chunk.messages.map((m) => ({ ...m, isSidechain: true })) : chunk.messages;
    messages = await archive.upsertMessages(tx, s.id, msgs);
    await archive.refreshSessionStats(tx, s.id);
  }
  return { calls: await store.upsertCalls(tx, calls), sessions, messages, consumedBytes, lines };
}

/** The wire carries the complete prefix, so reconcile this derived session exactly on rewrites. */
export async function ingestCodex(tx: TxClient, host: Host, buf: Buffer) {
  const split = splitJsonLines(buf);
  const parsed = parseCodex(split.records, host);
  let sessions = 0, messages = 0, calls = 0;
  if (parsed.session) {
    const s = await archive.upsertSession(tx, parsed.session);
    sessions = Number(s.changed);
    await tx.query(`DELETE FROM archive_messages WHERE session_id=$1 AND NOT (external_id=ANY($2::text[]))`,
      [s.id, parsed.messages.map(m => m.externalId)]);
    messages = await archive.upsertMessages(tx, s.id, parsed.messages);
    await tx.query(`DELETE FROM usage_calls WHERE source='codex' AND host=$1 AND session_external_id=$2 AND NOT (call_id=ANY($3::text[]))`,
      [host, parsed.session.externalId, parsed.calls.map(c => c.callId)]);
    calls = await store.upsertCalls(tx, parsed.calls, true);
  }
  return { calls, sessions, messages, ...split };
}

async function syncAppendOnly(host: Host, path: string,
  apply: (tx: TxClient, buf: Buffer, startLine: number) => Promise<{ consumedBytes: number; lines: number }>): Promise<boolean> {
  const size = statSync(path).size;
  const fingerprint = size ? fingerprintOf(path) : '';
  const prev = await store.getCursor(host, path);
  // Resume only from a cursor for the same file (same first line) that hasn't shrunk.
  const keep = prev && prev.fingerprint === fingerprint && size >= prev.offsetBytes ? prev : null;
  if (keep && size === keep.sizeBytes) return false;
  const offset = keep ? keep.offsetBytes : 0;
  const startLine = keep ? keep.lines : 0;
  const buf = readFrom(path, offset);
  await withTransaction(async (tx) => {
    const r = await apply(tx, buf, startLine);
    await store.saveCursor(tx, host, path, {
      fingerprint, offsetBytes: offset + r.consumedBytes, lines: startLine + r.lines, sizeBytes: size });
  });
  return true;
}

export async function syncUsage(paths: UsageSyncPaths, host: Host): Promise<UsageSyncCounts> {
  const c: UsageSyncCounts = { files: 0, calls: 0, sessions: 0, messages: 0, runs: 0, plan: 0, attached: 0, errors: [] };

  await withTransaction(tx => tx.query('INSERT INTO usage_hosts (slug, display, kind) VALUES ($1,$1,\'laptop\') ON CONFLICT DO NOTHING', [host]).then(() => undefined));

  for (const path of walk(paths.claudeProjectsDir).filter((p) => p.endsWith('.jsonl')).sort()) {
    try {
      const touched = await syncAppendOnly(host, path, async (tx, buf, startLine) => {
        const r = await ingestTranscript(tx, host, path, buf, startLine);
        c.calls += r.calls; c.sessions += r.sessions; c.messages += r.messages;
        return r;
      });
      if (touched) c.files++;
    } catch (err) {
      c.errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Run logs are small and get attached to cards; re-read a changed one whole.
  if (paths.runsDir && existsSync(paths.runsDir)) {
    for (const path of walk(paths.runsDir).filter((p) => p.endsWith('.jsonl')).sort()) {
      try {
        const st = statSync(path);
        const prev = await store.getCursor(host, path);
        if (prev && prev.sizeBytes === st.size) continue;
        const { records, consumedBytes, lines } = splitJsonLines(readFileSync(path));
        const { runs, plan } = parseRunLog(records, host, path, st.mtime);
        await withTransaction(async (tx) => {
          c.runs += await store.upsertRuns(tx, runs);
          c.plan += await store.insertPlanSnapshots(tx, plan);
          await store.saveCursor(tx, host, path, { fingerprint: 'whole-file', offsetBytes: consumedBytes, lines, sizeBytes: st.size });
        });
        c.files++;
      } catch (err) {
        c.errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // zen-agent traces: one small file per run, appended while the run is live, so a changed one is re-read whole.
  // The run row is written from the meta line and again when the end line lands; calls and the archive come with it.
  if (paths.zenSessionsDir && existsSync(paths.zenSessionsDir)) {
    for (const path of walk(paths.zenSessionsDir).filter((p) => p.endsWith('.jsonl')).sort()) {
      try {
        const st = statSync(path);
        const prev = await store.getCursor(host, path);
        if (prev && prev.sizeBytes === st.size) continue;
        const { records, consumedBytes, lines } = splitJsonLines(readFileSync(path));
        const t = parseZenTrace(records, host, path, st.mtime);
        await withTransaction(async (tx) => {
          if (t.run) c.runs += await store.upsertRuns(tx, [t.run]);
          c.calls += await store.upsertCalls(tx, t.calls);
          if (t.session) {
            const s = await archive.upsertSession(tx, t.session.input);
            if (s.changed) c.sessions++;
            c.messages += await archive.upsertMessages(tx, s.id, t.session.messages);
          }
          await store.saveCursor(tx, host, path, { fingerprint: 'whole-file', offsetBytes: consumedBytes, lines, sizeBytes: st.size });
        });
        c.files++;
      } catch (err) {
        c.errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  for (const path of paths.codexSessionsDir ? walk(paths.codexSessionsDir).filter(p => p.endsWith('.jsonl')).sort() : []) {
    try {
      const buf = readFileSync(path);
      const { consumedBytes } = splitJsonLines(buf);
      const prefix = buf.subarray(0, consumedBytes);
      const fingerprint = sha256(prefix);
      const prev = await store.getCursor(host, path);
      if (!consumedBytes || prev?.fingerprint === fingerprint) continue;
      await withTransaction(async tx => {
        const r = await ingestCodex(tx, host, prefix);
        c.calls += r.calls; c.sessions += r.sessions; c.messages += r.messages;
        await store.saveCursor(tx, host, path, { fingerprint, offsetBytes: consumedBytes, lines: r.lines, sizeBytes: buf.length });
      });
      c.files++;
    } catch { c.errors.push('Codex session import failed; cursor kept'); }
  }

  // Calls join their run once both sides are in (a transcript may land a sync before its run log, or after).
  try {
    c.attached = await withTransaction((tx) => store.attachCallsToRuns(tx, host));
  } catch (err) {
    c.errors.push(`attach: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (paths.statuslineLog && existsSync(paths.statuslineLog)) {
    try {
      await syncAppendOnly(host, paths.statuslineLog, async (tx, buf) => {
        const r = splitJsonLines(buf);
        c.plan += await store.insertPlanSnapshots(tx, parseStatuslineLog(r.records, host));
        return r;
      });
    } catch (err) {
      c.errors.push(`${paths.statuslineLog}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return c;
}
