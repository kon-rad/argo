import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { query } from '../db.js';
import { log } from '../logger.js';
import { safeVaultPath } from '../paths.js';
import { stubMarkdown, uniqueName } from './paths.js';
import type { VaultRemote } from './remote.js';
import type { ObjectStore } from './store.js';

export interface UploadRow {
  id: string;
  filename: string;
  size_bytes: string; // bigint comes back as a string
  content_type: string | null;
  dest_dir: string;
  description: string;
  tags: string[];
  part_size: number;
  s3_upload_id: string | null;
  inbox_key: string;
  status: 'uploading' | 'uploaded' | 'ingesting' | 'stored' | 'failed' | 'aborted';
  b2_path: string | null;
  stub_path: string | null;
  error: string | null;
  to_m1: boolean;
  m1_status: 'pending' | 'pulling' | 'done' | 'failed' | null;
  m1_path: string | null;
  m1_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface UploadsDeps {
  store: ObjectStore;
  remote: VaultRemote;
  vaultRoot: string;
}

const STALE_UPLOAD_DAYS = 7;

export async function getUpload(id: string): Promise<UploadRow | null> {
  const { rows } = await query<UploadRow>(`SELECT * FROM uploads WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

function shortError(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

/**
 * Moves one finished browser upload from the plain `inbox/` prefix into its encrypted vault path, checks the
 * size at the far end, deletes the inbox copy and writes the vault stub. Safe to run again after a failure:
 * the inbox object is only deleted once the vault copy is verified.
 */
export async function ingestUpload(deps: UploadsDeps, id: string): Promise<void> {
  const claimed = await query<UploadRow>(
    `UPDATE uploads SET status = 'ingesting', error = NULL, updated_at = now()
     WHERE id = $1 AND status = 'uploaded' RETURNING *`,
    [id],
  );
  const row = claimed.rows[0];
  if (!row) return;
  const size = Number(row.size_bytes);

  try {
    const inbox = await deps.store.head(row.inbox_key);
    if (!inbox) throw new Error('the uploaded file is not in the inbox any more');
    if (inbox.size !== size) throw new Error(`inbox size ${inbox.size} does not match the ${size} bytes announced`);

    const taken = await deps.remote.listFiles(row.dest_dir);
    // A file or stub already in the vault folder also counts as taken (its original may not be in the bucket yet).
    const names = new Set(taken.keys());
    const dirAbs = safeVaultPath(deps.vaultRoot, row.dest_dir);
    for (const entry of dirAbs ? await readdir(dirAbs).catch(() => [] as string[]) : []) {
      names.add(entry);
      if (entry.endsWith('.b2.md')) names.add(entry.slice(0, -'.b2.md'.length));
    }
    const name = uniqueName(row.filename, names);
    const b2Rel = `${row.dest_dir}/${name}`;
    await deps.remote.copyFromInbox(row.inbox_key, b2Rel);

    const after = await deps.remote.listFiles(row.dest_dir);
    if (after.get(name) !== size) {
      throw new Error(`stored size ${after.get(name) ?? 'missing'} does not match the ${size} bytes uploaded`);
    }

    const stubRel = `${b2Rel}.b2.md`;
    const stubAbs = safeVaultPath(deps.vaultRoot, stubRel);
    if (!stubAbs) throw new Error('stub path escapes the vault');
    await mkdir(dirname(stubAbs), { recursive: true });
    await writeFile(
      stubAbs,
      stubMarkdown({
        name,
        b2Path: `vault/${b2Rel}`,
        bytes: size,
        uploadedAt: new Date(),
        description: row.description,
        tags: row.tags,
        uploadId: row.id,
      }),
      { flag: 'wx' },
    );

    await deps.store.remove(row.inbox_key).catch((err: unknown) => log.warn(`uploads: inbox cleanup failed for ${row.id}:`, err));
    await query(
      `UPDATE uploads SET status = 'stored', b2_path = $2, stub_path = $3, completed_at = now(), updated_at = now(),
              m1_status = CASE WHEN to_m1 THEN 'pending' ELSE m1_status END
       WHERE id = $1`,
      [id, `vault/${b2Rel}`, stubRel],
    );
    log.info(`uploads: ${row.id} stored at vault/${b2Rel}`);
  } catch (err) {
    log.error(`uploads: ingest of ${row.id} failed:`, err);
    await query(`UPDATE uploads SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`, [id, shortError(err)]);
  }
}

/** One ingest at a time: each one streams a whole file through this machine. */
export function createWorker(deps: UploadsDeps): { kick(): void; start(intervalMs?: number): () => void } {
  let busy = false;

  async function drain(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      for (;;) {
        const { rows } = await query<{ id: string }>(
          `SELECT id FROM uploads WHERE status = 'uploaded' ORDER BY updated_at LIMIT 1`,
        );
        if (!rows[0]) break;
        await ingestUpload(deps, rows[0].id);
      }
      await abortStale(deps);
    } catch (err) {
      log.error('uploads: worker pass failed:', err);
    } finally {
      busy = false;
    }
  }

  return {
    kick() {
      void drain();
    },
    start(intervalMs = 120_000) {
      // A process that died mid-ingest leaves rows in 'ingesting'; nothing is running yet, so hand them back.
      void query(`UPDATE uploads SET status = 'uploaded', updated_at = now() WHERE status = 'ingesting'`)
        .then(drain)
        .catch((err: unknown) => log.error('uploads: startup sweep failed:', err));
      const timer = setInterval(() => void drain(), intervalMs);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
}

/** Browser uploads nobody finished within a week: abort the multipart so B2 stops billing for the parts. */
async function abortStale(deps: UploadsDeps): Promise<void> {
  const { rows } = await query<UploadRow>(
    `UPDATE uploads SET status = 'aborted', updated_at = now()
     WHERE status = 'uploading' AND updated_at < now() - make_interval(days => $1) RETURNING *`,
    [STALE_UPLOAD_DAYS],
  );
  for (const row of rows) {
    if (row.s3_upload_id) await deps.store.abort(row.inbox_key, row.s3_upload_id);
  }
}
