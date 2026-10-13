import { query, type TxClient } from '../db.js';
import { clean, sha256 } from './clean.js';
import type { Host, LogLine, ParsedMessage, SessionInput } from './types.js';

export interface FileRow {
  id: number; source: string; host: Host; localPath: string; sizeBytes: number; mtimeMs: number;
  sha256: string; fingerprint: string | null; b2Path: string | null; uploadedAt: Date | null;
  uploadedSize: number | null; ingestedBytes: number; ingestedLines: number;
}

const q = (tx: TxClient | null) => (tx ? tx.query.bind(tx) : query);

const FILE_COLS = `id, source, host, local_path AS "localPath", size_bytes AS "sizeBytes", mtime_ms AS "mtimeMs",
  sha256, fingerprint, b2_path AS "b2Path", uploaded_at AS "uploadedAt", uploaded_size AS "uploadedSize",
  ingested_bytes AS "ingestedBytes", ingested_lines AS "ingestedLines"`;

export async function getFile(source: string, host: Host, localPath: string): Promise<FileRow | null> {
  const { rows } = await query<FileRow>(
    `SELECT ${FILE_COLS} FROM archive_files WHERE source=$1 AND host=$2 AND local_path=$3`, [source, host, localPath]);
  return rows[0] ?? null;
}

export async function saveFileState(tx: TxClient | null, f: {
  source: string; host: Host; localPath: string; sizeBytes: number; mtimeMs: number; sha256: string;
  fingerprint: string | null; b2Path: string | null; staged: boolean;
}): Promise<void> {
  await q(tx)(
    `INSERT INTO archive_files (source, host, local_path, size_bytes, mtime_ms, sha256, fingerprint, b2_path, staged_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $9 THEN now() END)
     ON CONFLICT (source, host, local_path) DO UPDATE SET
       size_bytes=EXCLUDED.size_bytes, mtime_ms=EXCLUDED.mtime_ms, sha256=EXCLUDED.sha256,
       fingerprint=EXCLUDED.fingerprint, b2_path=EXCLUDED.b2_path,
       staged_at=CASE WHEN $9 THEN now() ELSE archive_files.staged_at END,
       uploaded_at=CASE WHEN $9 THEN NULL ELSE archive_files.uploaded_at END`,
    [f.source, f.host, f.localPath, f.sizeBytes, f.mtimeMs, f.sha256, f.fingerprint, f.b2Path, f.staged]);
}

export async function pendingUploads(): Promise<FileRow[]> {
  const { rows } = await query<FileRow>(
    `SELECT ${FILE_COLS} FROM archive_files WHERE staged_at IS NOT NULL AND uploaded_at IS NULL ORDER BY id`);
  return rows;
}

export async function markUploaded(ids: number[]): Promise<void> {
  if (!ids.length) return;
  await query(`UPDATE archive_files SET uploaded_at=now(), uploaded_size=GREATEST(COALESCE(uploaded_size, 0), size_bytes) WHERE id = ANY($1::bigint[])`, [ids]);
}

export async function markIngested(tx: TxClient, id: number, bytes: number, lines: number, fingerprint: string | null): Promise<void> {
  await tx.query(
    `UPDATE archive_files SET ingested_bytes=$2, ingested_lines=$3, fingerprint=COALESCE($4, fingerprint), ingested_at=now() WHERE id=$1`,
    [id, bytes, lines, fingerprint]);
}

export async function upsertSession(tx: TxClient, s: SessionInput): Promise<{ id: number; changed: boolean }> {
  const params = [s.source, s.host, s.externalId, s.parentExternalId, s.project, clean(s.title), s.model,
    s.startedAt, s.endedAt, s.messageCount ?? 0, s.inputTokens, s.outputTokens, s.costUsd,
    JSON.stringify(clean(s.meta)), s.b2Path, s.messageCount === null];
  // $16 = stats come from archive_messages (Claude): keep the computed columns.
  const { rows } = await tx.query<{ id: number }>(
    `INSERT INTO archive_sessions AS a (source, host, external_id, parent_external_id, project, title, model,
       started_at, ended_at, message_count, input_tokens, output_tokens, cost_usd, meta, b2_path)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15)
     ON CONFLICT (source, host, external_id) DO UPDATE SET
       parent_external_id=COALESCE(EXCLUDED.parent_external_id, a.parent_external_id),
       project=COALESCE(EXCLUDED.project, a.project),
       title=COALESCE(EXCLUDED.title, a.title), model=COALESCE(EXCLUDED.model, a.model),
       started_at=CASE WHEN $16 THEN a.started_at ELSE EXCLUDED.started_at END,
       ended_at=CASE WHEN $16 THEN a.ended_at ELSE EXCLUDED.ended_at END,
       message_count=CASE WHEN $16 THEN a.message_count ELSE EXCLUDED.message_count END,
       input_tokens=EXCLUDED.input_tokens, output_tokens=EXCLUDED.output_tokens, cost_usd=EXCLUDED.cost_usd,
       meta=EXCLUDED.meta, b2_path=COALESCE(EXCLUDED.b2_path, a.b2_path), updated_at=now()
     WHERE (a.parent_external_id, a.project, a.title, a.model, a.input_tokens, a.output_tokens, a.cost_usd, a.meta, a.b2_path)
       IS DISTINCT FROM (COALESCE(EXCLUDED.parent_external_id, a.parent_external_id), COALESCE(EXCLUDED.project, a.project),
         COALESCE(EXCLUDED.title, a.title), COALESCE(EXCLUDED.model, a.model), EXCLUDED.input_tokens, EXCLUDED.output_tokens,
         EXCLUDED.cost_usd, EXCLUDED.meta, COALESCE(EXCLUDED.b2_path, a.b2_path))
       OR (NOT $16 AND (a.started_at, a.ended_at, a.message_count)
         IS DISTINCT FROM (EXCLUDED.started_at, EXCLUDED.ended_at, EXCLUDED.message_count))
     RETURNING id`, params);
  if (rows[0]) return { id: rows[0].id, changed: true };
  const existing = await tx.query<{ id: number }>(
    `SELECT id FROM archive_sessions WHERE source=$1 AND host=$2 AND external_id=$3`, [s.source, s.host, s.externalId]);
  return { id: existing.rows[0]!.id, changed: false };
}

const MSG_BATCH = 200;

export async function upsertMessages(tx: TxClient, sessionId: number, input: ParsedMessage[]): Promise<number> {
  // One INSERT cannot touch the same conflict key twice: dedupe by externalId, last one wins.
  const msgs = [...new Map(input.map((m) => [m.externalId, m])).values()];
  let changed = 0;
  for (let i = 0; i < msgs.length; i += MSG_BATCH) {
    const batch = msgs.slice(i, i + MSG_BATCH);
    const values: string[] = [];
    const params: unknown[] = [];
    batch.forEach((m, j) => {
      const b = j * 11;
      values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9}::jsonb,$${b + 10},$${b + 11})`);
      params.push(sessionId, m.seq, m.externalId, m.parentExternalId, m.role, m.kind, m.ts,
        clean(m.contentText), JSON.stringify(clean(m.raw)), m.rawSha, m.isSidechain);
    });
    const r = await tx.query(
      `INSERT INTO archive_messages AS a (session_id, seq, external_id, parent_external_id, role, kind, ts, content_text, raw, raw_sha, is_sidechain)
       VALUES ${values.join(',')}
       ON CONFLICT (session_id, external_id) DO UPDATE SET
         seq=EXCLUDED.seq, parent_external_id=EXCLUDED.parent_external_id, role=EXCLUDED.role, kind=EXCLUDED.kind,
         ts=EXCLUDED.ts, content_text=EXCLUDED.content_text, raw=EXCLUDED.raw, raw_sha=EXCLUDED.raw_sha,
         is_sidechain=EXCLUDED.is_sidechain
       WHERE a.raw_sha IS DISTINCT FROM EXCLUDED.raw_sha`, params);
    changed += r.rowCount ?? 0;
  }
  return changed;
}

export async function refreshSessionStats(tx: TxClient, sessionId: number): Promise<void> {
  await tx.query(
    `UPDATE archive_sessions s SET message_count=c.n, started_at=c.mn, ended_at=c.mx, updated_at=now()
     FROM (SELECT count(*)::int n, min(ts) mn, max(ts) mx FROM archive_messages WHERE session_id=$1) c
     WHERE s.id=$1 AND (s.message_count, s.started_at, s.ended_at) IS DISTINCT FROM (c.n, c.mn, c.mx)`, [sessionId]);
}

export async function insertLogLines(tx: TxClient, host: Host, file: string, fingerprint: string, lines: LogLine[]): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < lines.length; i += 500) {
    const batch = lines.slice(i, i + 500);
    const r = await tx.query(
      `INSERT INTO archive_log_lines (host, file, fingerprint, byte_offset, ts, level, message)
       SELECT $1::text, $2::text, $3::text, * FROM unnest($4::bigint[], $5::timestamptz[], $6::text[], $7::text[])
       ON CONFLICT DO NOTHING`,
      [host, file, fingerprint, batch.map((l) => l.byteOffset), batch.map((l) => l.ts),
        batch.map((l) => l.level), batch.map((l) => clean(l.message))]);
    inserted += r.rowCount ?? 0;
  }
  return inserted;
}

export async function recordMemoryVersion(tx: TxClient | null, source: string, host: Host, path: string, content: string): Promise<boolean> {
  const c = clean(content);
  const r = await q(tx)(
    `INSERT INTO archive_memory_versions (source, host, path, content, sha256) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT DO NOTHING`, [source, host, path, c, sha256(c)]);
  return (r.rowCount ?? 0) > 0;
}
