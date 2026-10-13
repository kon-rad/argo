import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { parseOr400, wrap } from './http.js';
import { resolveDir } from './vaultPath.js';

const Q = z.object({
  path: z.string().default(''),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

export function treeRouter(vaultRoot: string): Router {
  const router = Router();

  router.get(
    '/',
    wrap(async (req, res) => {
      const q = parseOr400(Q, req.query);
      const { key } = resolveDir(vaultRoot, q.path);

      // `starts_with` rather than LIKE: a directory named `100%` or `a_b` is
      // ordinary in this vault and would be a wildcard in a LIKE pattern.
      // child_count is every file BELOW the directory, not just its own level —
      // it is there to tell the user whether a folder is worth opening.
      const dirs = await query<{ name: string; child_count: number }>(
        `SELECT split_part(rest, '/', 1) AS name, count(*)::int AS child_count
         FROM (
           SELECT CASE WHEN $1 = '' THEN path ELSE substr(path, length($1) + 2) END AS rest
           FROM vault_files
           WHERE $1 = '' OR starts_with(path, $1 || '/')
         ) t
         WHERE position('/' in rest) > 0
         GROUP BY 1
         ORDER BY 1`,
        [key],
      );

      const files = await query(
        `SELECT id, name, path, ext, is_markdown, size_bytes, mtime, title
         FROM vault_files WHERE parent_path = $1
         ORDER BY name LIMIT $2 OFFSET $3`,
        [key, q.limit, q.offset],
      );

      const total = await query<{ count: number }>(
        `SELECT count(*)::int FROM vault_files WHERE parent_path = $1`,
        [key],
      );
      const count = total.rows[0]!.count;

      res.json({
        path: key,
        dirs: dirs.rows.map((d) => ({
          name: d.name,
          path: key ? `${key}/${d.name}` : d.name,
          child_count: d.child_count,
        })),
        files: files.rows,
        total: count,
        has_more: q.offset + files.rows.length < count,
      });
    }),
  );

  return router;
}
