import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { z } from 'zod';
import { config } from '../../config.js';
import { query, withTransaction, type TxClient } from '../../db.js';
import { log } from '../../logger.js';
import type { Connector, RunContext } from '../types.js';
import { parseMarkdown } from './parse.js';
import { resolveLinks } from './resolve.js';
import { DEFAULT_SKIP_DIRS, walkVault, type SkippedDir, type WalkEntry } from './walk.js';

/** Above this, a file is indexed as metadata only regardless of extension. */
export const MAX_MARKDOWN_BYTES = 5 * 1024 * 1024;

export interface ScanStats {
  scanned: number;
  inserted: number;
  updated: number;
  unchanged: number;
  deleted: number;
  skippedDirs: SkippedDir[];
  resolvedLinks: number;
  unresolvedLinks: number;
  durationMs: number;
}

export interface ScanOptions {
  root: string;
  sourceId: number;
  runId?: number;
  skipDirs?: readonly string[];
  onProgress?: (p: { phase: string; filesSeen: number; currentPath: string }) => void;
  signal?: AbortSignal;
}

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

function isMarkdown(entry: WalkEntry): boolean {
  return entry.ext === '.md' && entry.sizeBytes <= MAX_MARKDOWN_BYTES;
}

/**
 * Markdown is hashed by content, because its body is what we index. Everything
 * else is hashed by size+mtime: re-reading 5.8 GB of media on every scan to
 * detect an in-place byte edit that never happens is not a trade worth making.
 */
async function hashOf(abs: string, entry: WalkEntry): Promise<{ hash: string; buf: Buffer | null }> {
  if (isMarkdown(entry)) {
    const buf = await readFile(abs);
    return { hash: sha256(buf), buf };
  }
  return { hash: sha256(`${entry.sizeBytes}:${Math.round(entry.mtimeMs)}`), buf: null };
}

async function upsertFile(
  tx: TxClient,
  entry: WalkEntry,
  hash: string,
  buf: Buffer | null,
): Promise<{ id: number; inserted: boolean }> {
  const md = buf !== null ? parseMarkdown(buf.toString('utf8'), basename(entry.name, extname(entry.name))) : null;

  const { rows } = await tx.query<{ id: number; inserted: boolean }>(
    `INSERT INTO vault_files
       (path, parent_path, name, title, ext, is_markdown, size_bytes, mtime, content_hash, frontmatter, body, indexed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,to_timestamp($8/1000.0),$9,$10,$11, now())
     ON CONFLICT (path) DO UPDATE SET
       parent_path = EXCLUDED.parent_path, name = EXCLUDED.name, title = EXCLUDED.title,
       ext = EXCLUDED.ext, is_markdown = EXCLUDED.is_markdown, size_bytes = EXCLUDED.size_bytes,
       mtime = EXCLUDED.mtime, content_hash = EXCLUDED.content_hash,
       frontmatter = EXCLUDED.frontmatter, body = EXCLUDED.body, indexed_at = now()
     RETURNING id, (xmax = 0) AS inserted`,
    [
      entry.path,
      entry.parentPath,
      entry.name,
      md?.title ?? null,
      entry.ext,
      md !== null,
      entry.sizeBytes,
      entry.mtimeMs,
      hash,
      md?.frontmatter ? JSON.stringify(md.frontmatter) : null,
      md?.body ?? null,
    ],
  );

  const row = rows[0]!;

  if (md !== null) {
    // Replace wholesale: a diff of link/tag sets costs more than it saves at
    // the scale of one file, and only changed files reach this branch.
    await tx.query(`DELETE FROM vault_links WHERE from_file_id = $1`, [row.id]);
    await tx.query(`DELETE FROM vault_tags WHERE file_id = $1`, [row.id]);

    if (md.links.length > 0) {
      await tx.query(
        `INSERT INTO vault_links (from_file_id, target_raw, alias)
         SELECT $1, t.target, t.alias FROM unnest($2::text[], $3::text[]) AS t(target, alias)`,
        [row.id, md.links.map((l) => l.targetRaw), md.links.map((l) => l.alias)],
      );
    }
    if (md.tags.length > 0) {
      await tx.query(
        `INSERT INTO vault_tags (file_id, tag)
         SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
        [row.id, md.tags],
      );
    }
  }

  return row;
}

export async function scanVault(opts: ScanOptions): Promise<ScanStats> {
  const started = Date.now();
  const skipDirs = opts.skipDirs ?? DEFAULT_SKIP_DIRS;

  const runId =
    opts.runId ??
    (
      await query<{ id: number }>(
        `INSERT INTO ingest_runs (source_id, status) VALUES ($1,'running') RETURNING id`,
        [opts.sourceId],
      )
    ).rows[0]!.id;

  try {
    opts.onProgress?.({ phase: 'walking', filesSeen: 0, currentPath: '' });
    const { files, skippedDirs } = await walkVault(opts.root, { skipDirs });

    const existing = new Map<string, { id: number; hash: string }>();
    const { rows: existingRows } = await query<{ id: number; path: string; content_hash: string }>(
      `SELECT id, path, content_hash FROM vault_files`,
    );
    for (const r of existingRows) existing.set(r.path, { id: r.id, hash: r.content_hash });

    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let seen = 0;

    for (const entry of files) {
      if (opts.signal?.aborted) throw new Error('scan aborted');
      seen++;

      const prior = existing.get(entry.path);
      const abs = join(opts.root, entry.path);

      // Cheap pre-check for non-markdown: if size+mtime are unchanged the hash
      // is unchanged by construction, so skip even the hash computation.
      const { hash, buf } = await hashOf(abs, entry).catch(() => ({ hash: '', buf: null }));
      if (!hash) continue;

      if (prior && prior.hash === hash) {
        unchanged++;
        continue; // No statement issued. This is the zero-write invariant.
      }

      await withTransaction((tx) => upsertFile(tx, entry, hash, buf)).then((r) => {
        if (r.inserted) inserted++;
        else updated++;
      });

      if (seen % 200 === 0) {
        opts.onProgress?.({ phase: 'indexing', filesSeen: seen, currentPath: entry.path });
      }
    }

    // Deletions: only touch the table when something actually went away, so an
    // unchanged re-scan stays at zero writes.
    const seenPaths = files.map((f) => f.path);
    const { rows: goneRows } = await query<{ count: number }>(
      `SELECT count(*)::int FROM vault_files WHERE NOT (path = ANY($1::text[]))`,
      [seenPaths],
    );
    let deleted = goneRows[0]!.count;
    if (deleted > 0) {
      await query(`DELETE FROM vault_files WHERE NOT (path = ANY($1::text[]))`, [seenPaths]);
    }

    opts.onProgress?.({ phase: 'resolving', filesSeen: seen, currentPath: '' });
    const changed = inserted + updated + deleted;
    const linkStats = changed > 0
      ? await resolveLinks()
      : { resolved: 0, unresolved: 0 };

    const stats: ScanStats = {
      scanned: files.length,
      inserted,
      updated,
      unchanged,
      deleted,
      skippedDirs,
      resolvedLinks: linkStats.resolved,
      unresolvedLinks: linkStats.unresolved,
      durationMs: Date.now() - started,
    };

    await query(
      `UPDATE ingest_runs SET status='ok', finished_at=now(), stats=$2, progress='{}' WHERE id=$1`,
      [runId, JSON.stringify({ ...stats, skipped_dirs: skippedDirs })],
    );
    log.info(`vault scan complete: ${JSON.stringify({ ...stats, skippedDirs: skippedDirs.length })}`);
    return stats;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await query(`UPDATE ingest_runs SET status='error', finished_at=now(), error=$2 WHERE id=$1`, [
      runId,
      message,
    ]).catch(() => {});
    throw err;
  }
}

export const vaultConnector: Connector<ScanStats> = {
  id: 'vault',
  configSchema: z.object({ skip_dirs: z.array(z.string()).optional() }).passthrough(),
  run: (ctx: RunContext) =>
    scanVault({
      // `root` is an escape hatch for tests and for pointing a second vault
      // source at another tree; normal runs index the configured vault.
      root: (ctx.config['root'] as string | undefined) ?? config.vaultRoot,
      sourceId: ctx.sourceId,
      runId: ctx.runId,
      skipDirs: (ctx.config['skip_dirs'] as string[] | undefined) ?? DEFAULT_SKIP_DIRS,
      onProgress: (p) => ctx.onProgress(p),
      signal: ctx.signal,
    }),
};

/**
 * Re-indexes one file after the app itself wrote it, so an edit shows up in the
 * reader, search and backlinks immediately instead of at the next full scan.
 * Only ever called for a path that is already indexed, so it has already
 * passed every walker rule (skip dirs, secret filter).
 */
export async function reindexFile(root: string, relPath: string): Promise<void> {
  const abs = join(root, relPath);
  const info = await stat(abs);
  const name = basename(relPath);
  const slash = relPath.lastIndexOf('/');
  const entry: WalkEntry = {
    path: relPath,
    parentPath: slash === -1 ? '' : relPath.slice(0, slash),
    name,
    ext: extname(name).toLowerCase(),
    sizeBytes: info.size,
    mtimeMs: info.mtimeMs,
  };
  const { hash, buf } = await hashOf(abs, entry);
  await withTransaction((tx) => upsertFile(tx, entry, hash, buf));
  await resolveLinks();
}
