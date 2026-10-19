import { stat } from 'node:fs/promises';
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { safeVaultPath } from '../paths.js';
import { HttpError, parseOr400, wrap } from './http.js';
import { resolveDir } from './vaultPath.js';

/**
 * The media module: every image, video and audio file in the vault, from the
 * index, for the /media page. A file on disk plays through /api/raw. A
 * `.b2.md` stub stands for the file it names (kind and name come from its
 * `b2_path`) and plays through /api/b2, unless the original is indexed next
 * to it, in which case only the original is listed. So the Mac, which still
 * has the originals, and a server, which has only the stubs, show the same
 * library. The index can describe another machine's disk (a client reading a
 * server's index), so each listed local file is checked: `available: false`
 * means it is indexed but not on this machine.
 */

const KINDS = {
  image: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.svg', '.heic', '.bmp'],
  video: ['.mp4', '.mov', '.webm', '.mkv', '.m4v'],
  audio: ['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac', '.opus'],
} as const;
export type MediaKind = keyof typeof KINDS;
const ALL_EXTS: string[] = Object.values(KINDS).flat();

export function mediaKind(ext: string): MediaKind | null {
  const e = ext.toLowerCase();
  for (const [kind, exts] of Object.entries(KINDS) as [MediaKind, readonly string[]][]) {
    if (exts.includes(e)) return kind;
  }
  return null;
}

const Q = z.object({
  kind: z.enum(['all', 'image', 'video', 'audio']).default('all'),
  path: z.string().default(''),
  q: z.string().trim().max(200).default(''),
  sort: z.enum(['new', 'name', 'size']).default('new'),
  limit: z.coerce.number().int().min(1).max(500).default(120),
  offset: z.coerce.number().int().min(0).default(0),
});

const ORDER: Record<z.infer<typeof Q>['sort'], string> = {
  new: 'mtime DESC NULLS LAST, path',
  name: 'lower(name), path',
  size: 'bytes DESC NULLS LAST, path',
};

/**
 * Every media row under the folder, stubs resolved to what they stand for.
 * $1 folder key ('' = whole vault). A stub is dropped when its b2_path is not
 * a clean path under `vault/` (the same rule as /api/b2's stubTarget) or its
 * original is indexed beside it.
 */
const MEDIA_CTE = `
  WITH base AS (
    SELECT v.path, v.parent_path, v.mtime, v.size_bytes, v.frontmatter,
           right(v.path, 6) = '.b2.md' AS is_stub
    FROM vault_files v
    WHERE ($1 = '' OR starts_with(v.path, $1 || '/'))
      AND (lower(v.ext) = ANY($2::text[]) OR right(v.path, 6) = '.b2.md')
  ),
  media AS (
    SELECT path, parent_path, mtime, is_stub,
           CASE WHEN is_stub THEN regexp_replace(frontmatter->>'b2_path', '^.*/', '')
                ELSE regexp_replace(path, '^.*/', '') END AS name,
           CASE WHEN is_stub THEN lower(substring(frontmatter->>'b2_path' from '(\\.[^./]+)$'))
                ELSE lower(substring(path from '(\\.[^./]+)$')) END AS ext,
           CASE WHEN is_stub AND frontmatter->>'bytes' ~ '^[0-9]+$' THEN (frontmatter->>'bytes')::bigint
                WHEN is_stub THEN NULL ELSE size_bytes END AS bytes
    FROM base b
    WHERE NOT is_stub OR (
      frontmatter->>'b2_path' LIKE 'vault/_%'
      AND substr(frontmatter->>'b2_path', 7) !~ '(^|/)\\.{0,2}(/|$)'
      AND NOT EXISTS (SELECT 1 FROM vault_files s WHERE s.path = left(b.path, length(b.path) - 6))
    )
  ),
  found AS (
    SELECT * FROM media
    WHERE ext = ANY($2::text[])
      AND ($3 = '' OR position(lower($3) in lower(name)) > 0)
  )`;

interface Row {
  path: string;
  parent_path: string;
  name: string;
  ext: string;
  bytes: string | null;
  mtime: string | null;
  is_stub: boolean;
}

export function mediaRouter(vaultRoot: string): Router {
  const router = Router();

  router.get(
    '/',
    wrap(async (req, res) => {
      const q = parseOr400(Q, req.query);
      const { key } = resolveDir(vaultRoot, q.path);
      if (key.split('/').includes('..')) throw new HttpError(400, 'path escapes the vault root');
      const exts = q.kind === 'all' ? ALL_EXTS : [...KINDS[q.kind]];

      // Three reads, run together: the page, the per-kind counts the tabs show
      // for this folder and search, and the folder picker's list.
      const [items, byExt, folders] = await Promise.all([
        query<Row>(
          `${MEDIA_CTE}
           SELECT path, parent_path, name, ext, bytes, mtime, is_stub, count(*) OVER ()::int AS total
           FROM found WHERE ext = ANY($4::text[])
           ORDER BY ${ORDER[q.sort]} LIMIT $5 OFFSET $6`,
          [key, ALL_EXTS, q.q, exts, q.limit, q.offset],
        ),
        query<{ ext: string; n: number }>(
          `${MEDIA_CTE} SELECT ext, count(*)::int AS n FROM found GROUP BY ext`,
          [key, ALL_EXTS, q.q],
        ),
        query<{ path: string; count: number }>(
          `${MEDIA_CTE} SELECT parent_path AS path, count(*)::int AS count FROM found
           GROUP BY parent_path ORDER BY parent_path LIMIT 500`,
          ['', ALL_EXTS, ''],
        ),
      ]);
      const counts: Record<MediaKind, number> = { image: 0, video: 0, audio: 0 };
      for (const r of byExt.rows) {
        const k = mediaKind(r.ext);
        if (k) counts[k] += r.n;
      }

      const available = await Promise.all(
        items.rows.map(async (r) => {
          if (r.is_stub) return true; // /api/b2 decides: the sibling on disk, or B2
          const abs = safeVaultPath(vaultRoot, r.path);
          return abs !== null && ((await stat(abs).catch(() => null))?.isFile() ?? false);
        }),
      );
      const total = (items.rows[0] as (Row & { total?: number }) | undefined)?.total
        ?? (q.offset > 0 ? (await countOnly(key, q.q, exts)) : 0);
      res.json({
        items: items.rows.map((r, i) => ({
          path: r.path,
          folder: r.parent_path,
          name: r.name,
          ext: r.ext,
          kind: mediaKind(r.ext),
          size_bytes: r.bytes === null ? null : Number(r.bytes),
          mtime: r.mtime,
          source: r.is_stub ? 'b2' : 'local',
          available: available[i],
          url: `${r.is_stub ? '/api/b2' : '/api/raw'}?${new URLSearchParams({ path: r.path })}`,
        })),
        total,
        has_more: q.offset + items.rows.length < total,
        counts,
        folders: folders.rows,
      });
    }),
  );

  return router;
}

/** The total when the page asked for is past the end (no row carries the window count). */
async function countOnly(key: string, text: string, exts: string[]): Promise<number> {
  const r = await query<{ n: number }>(
    `${MEDIA_CTE} SELECT count(*)::int AS n FROM found WHERE ext = ANY($4::text[])`,
    [key, ALL_EXTS, text, exts],
  );
  return r.rows[0]?.n ?? 0;
}
