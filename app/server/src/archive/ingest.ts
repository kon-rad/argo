import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { query, withTransaction } from '../db.js';
import { parseClaudeJsonl } from './claude.js';
import { readHermes } from './hermes.js';
import { splitLog } from './logs.js';
import { readFrom } from '../usage/readFrom.js';
import * as stage from './stage.js';
import * as store from './store.js';
import type { Host, SessionInput } from './types.js';

export type Counts = { files: number; sessions: number; messages: number; logLines: number; memoryVersions: number };
export type Bump = (s: string, k: keyof Counts, n?: number) => void;

export interface Item {
  source: string; host: Host; localPath: string; logical: string; b2Desired: string;
  kind: 'claude' | 'hermes-db' | 'log' | 'memory' | 'blob'; parentSid?: string; project?: string;
  rotatedPath?: string; // log: `<name>.1` holding the tail of the previously ingested file
  daily?: boolean; // hermes state: one upload per UTC day
}

export { readFrom } from '../usage/readFrom.js';

export async function ingest(item: Item, errors: string[], bump: Bump): Promise<void> {
  const row = (await store.getFile(item.source, item.host, item.logical))!;
  if (item.kind === 'blob') return;
  if (item.kind === 'memory') {
    const st = stage.fileState(item.localPath, row);
    await withTransaction(async (tx) => {
      const added = await store.recordMemoryVersion(tx, item.source, item.host, basename(item.localPath), readFileSync(item.localPath, 'utf8'));
      if (added) bump(item.source, 'memoryVersions');
      await store.markIngested(tx, row.id, st.sizeBytes, 0, null);
    });
    return;
  }
  if (item.kind === 'hermes-db') {
    const read = readHermes(item.localPath, item.host, item.source as SessionInput['source']);
    let { sessions, messages } = read;
    if (item.source === 'hermes:user') {
      // A second Hermes home on the same machine shares the history it was copied from:
      // a session id the main home already archived is the same session, not a new one.
      const { rows } = await query<{ external_id: string }>(
        `SELECT external_id FROM archive_sessions WHERE source='hermes' AND host=$1 AND external_id = ANY($2::text[])`,
        [item.host, sessions.map((s) => s.externalId)]);
      const dup = new Set(rows.map((r) => r.external_id));
      sessions = sessions.filter((s) => !dup.has(s.externalId));
      messages = messages.filter((m) => !dup.has(m.sessionExternalId));
    }
    const size = stage.fileState(item.localPath, row).sizeBytes;
    await withTransaction(async (tx) => {
      const ids = new Map<string, number>();
      for (const s of sessions) {
        const r = await store.upsertSession(tx, { ...s, b2Path: row.b2Path });
        ids.set(s.externalId, r.id); if (r.changed) bump('hermes', 'sessions');
      }
      const bySession = new Map<string, typeof messages>();
      let orphans = 0;
      for (const m of messages) { if (!ids.has(m.sessionExternalId)) { orphans++; continue; } (bySession.get(m.sessionExternalId) ?? bySession.set(m.sessionExternalId, []).get(m.sessionExternalId)!).push(m); }
      for (const [sid, msgs] of bySession) bump('hermes', 'messages', await store.upsertMessages(tx, ids.get(sid)!, msgs));
      await store.markIngested(tx, row.id, size, 0, null);
      if (orphans) errors.push(`hermes ${item.host}: ${orphans} messages with unknown session skipped`);
    });
    bump('hermes', 'files');
    return;
  }
  // Append-only files: resume from the stored offset unless the file was replaced or shrank.
  const st = stage.fileState(item.localPath, row);
  const restart = row.fingerprint !== null && row.fingerprint !== st.fingerprint || st.sizeBytes < row.ingestedBytes;
  const offset = restart ? 0 : row.ingestedBytes;
  const startLine = restart ? 0 : row.ingestedLines;
  const buf = readFrom(item.localPath, offset);
  if (item.kind === 'claude') {
    const chunk = parseClaudeJsonl(buf, startLine);
    const sid = basename(item.localPath, '.jsonl');
    await withTransaction(async (tx) => {
      if (chunk.messages.length) {
        const s = await store.upsertSession(tx, { source: 'claude-code', host: 'mac', externalId: sid,
          parentExternalId: item.parentSid ?? null, project: item.project ?? null, title: chunk.title, model: chunk.model,
          startedAt: null, endedAt: null, messageCount: null, inputTokens: null, outputTokens: null, costUsd: null,
          meta: {}, b2Path: row.b2Path });
        if (s.changed) bump('claude-code', 'sessions');
        const msgs = item.parentSid ? chunk.messages.map((m) => ({ ...m, isSidechain: true })) : chunk.messages;
        bump('claude-code', 'messages', await store.upsertMessages(tx, s.id, msgs));
        await store.refreshSessionStats(tx, s.id);
      }
      await store.markIngested(tx, row.id, offset + chunk.consumedBytes, startLine + chunk.linesConsumed, st.fingerprint);
    });
    bump('claude-code', 'files');
    return;
  }
  // log: first drain the tail of a rotated file, under its own (file, fingerprint) key.
  if (item.rotatedPath && row.fingerprint) {
    const old = splitLog(readFrom(item.rotatedPath, row.ingestedBytes), row.ingestedBytes, null, item.host === 'droplet');
    await withTransaction(async (tx) => {
      bump('hermes-logs', 'logLines', await store.insertLogLines(tx, item.host, basename(item.localPath), row.fingerprint!, old.lines));
    });
  }
  const r = splitLog(buf, offset, null, item.host === 'droplet');
  await withTransaction(async (tx) => {
    bump('hermes-logs', 'logLines', await store.insertLogLines(tx, item.host, basename(item.localPath), st.fingerprint, r.lines));
    await store.markIngested(tx, row.id, offset + r.consumedBytes, 0, st.fingerprint);
  });
  bump('hermes-logs', 'files');
}
