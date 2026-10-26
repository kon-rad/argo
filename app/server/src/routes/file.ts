import { createHash, randomBytes } from 'node:crypto';
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { buildResolver } from '../connectors/vault/resolve.js';
import { reindexFile } from '../connectors/vault/scan.js';
import { query } from '../db.js';
import { HttpError, parseOr400, wrap } from './http.js';
import { resolveIndexed } from './vaultPath.js';

/** Plain text a textarea can round-trip without mangling. */
export const EDITABLE_EXTS = new Set([
  '.md', '.markdown', '.txt', '.csv', '.tsv', '.json', '.yaml', '.yml', '.toml',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.sh', '.css', '.html', '.xml', '.svg', '.sql',
]);

/** Past this, a textarea is the wrong tool and a download is the right one. */
export const MAX_EDIT_BYTES = 5 * 1024 * 1024;

/** A card with more note references than this is not a card. */
const MAX_RESOLVE_REFS = 100;

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

const SaveBody = z.object({
  path: z.string().min(1),
  content: z.string(),
  /** sha256 of the bytes the editor started from — the optimistic-lock token. */
  base_hash: z.string().regex(/^[0-9a-f]{64}$/),
});

export function fileRouter(vaultRoot: string): Router {
  const router = Router();

  router.get(
    '/',
    wrap(async (req, res) => {
      const { row } = await resolveIndexed(vaultRoot, req.query['path']);

      const [tags, links, backlinks] = await Promise.all([
        query<{ tag: string }>(`SELECT tag FROM vault_tags WHERE file_id = $1 ORDER BY tag`, [row.id]),
        query(
          `SELECT l.target_raw, l.alias, f.id AS file_id, f.path, f.title
           FROM vault_links l
           LEFT JOIN vault_files f ON f.id = l.target_file_id
           WHERE l.from_file_id = $1
           ORDER BY l.id`,
          [row.id],
        ),
        // DISTINCT: a note that links to the same target three times is one
        // backlink, not three.
        query(
          `SELECT DISTINCT f.id, f.path, f.title
           FROM vault_links l JOIN vault_files f ON f.id = l.from_file_id
           WHERE l.target_file_id = $1
           ORDER BY f.path`,
          [row.id],
        ),
      ]);

      const { frontmatter, ...file } = row;
      res.json({
        file,
        frontmatter: frontmatter ?? {},
        tags: tags.rows.map((t) => t.tag),
        links: links.rows,
        backlinks: backlinks.rows,
      });
    }),
  );

  // Names to notes, for text that isn't a vault file: kanban cards, comments,
  // bot results. `?ref=Research/ai/x.md&ref=x` answers each with the indexed
  // path the scanner would link it to, or null. Same rules as the link graph.
  // A folder ref ending in `/` answers with the folder path and its slash.
  router.get(
    '/resolve',
    wrap(async (req, res) => {
      const raw = req.query['ref'];
      const refs = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).filter(
        (r): r is string => typeof r === 'string' && r.trim() !== '' && r.length <= 500,
      );
      if (refs.length > MAX_RESOLVE_REFS) throw new HttpError(400, `at most ${MAX_RESOLVE_REFS} refs per request`);
      const resolved: Record<string, string | null> = {};
      if (refs.length > 0) {
        const { rows: files } = await query<{ id: number; path: string; name: string }>(
          `SELECT id, path, name FROM vault_files`,
        );
        const resolve = buildResolver(files);
        const pathById = new Map(files.map((f) => [f.id, f.path]));
        for (const ref of refs) {
          const id = resolve(ref);
          resolved[ref] = id === null ? null : (pathById.get(id) ?? null);
          // A folder ("Areas/x/kit/"): resolves to itself, with the slash, when the index has a file below it.
          if (resolved[ref] === null && ref.endsWith('/')) {
            const dir = ref.replace(/^\.\//, '').replace(/\/+$/, '');
            if (dir && files.some((f) => f.path.startsWith(`${dir}/`))) resolved[ref] = `${dir}/`;
          }
        }
      }
      res.json({ resolved });
    }),
  );

  // The editor loads from disk, not from the index: the index can lag the disk
  // by a scan, and its body excludes frontmatter.
  router.get(
    '/source',
    wrap(async (req, res) => {
      const { abs, row } = await resolveIndexed(vaultRoot, req.query['path']);
      if (!EDITABLE_EXTS.has(row.ext)) throw new HttpError(415, `${row.ext || 'this file'} is not editable here`);
      const buf = await readFile(abs).catch(() => null);
      if (!buf) throw new HttpError(404, `no longer on disk: ${row.path}`);
      if (buf.length > MAX_EDIT_BYTES) throw new HttpError(413, 'too large to edit in the browser — download it');
      res.setHeader('Cache-Control', 'no-store');
      res.json({ path: row.path, content: buf.toString('utf8'), hash: sha256(buf) });
    }),
  );

  router.put(
    '/source',
    wrap(async (req, res) => {
      const body = parseOr400(SaveBody, req.body);
      const { abs, row } = await resolveIndexed(vaultRoot, body.path);
      if (!EDITABLE_EXTS.has(row.ext)) throw new HttpError(415, `${row.ext || 'this file'} is not editable here`);

      const next = Buffer.from(body.content, 'utf8');
      if (next.length > MAX_EDIT_BYTES) throw new HttpError(413, 'too large to save from the browser');

      // Optimistic lock. The vault has other writers — Obsidian on the Mac, the
      // Hermes agent and the git auto-sync on the server — and silently
      // overwriting one of their changes is the worst thing an editor can do.
      const current = await readFile(abs).catch(() => null);
      if (!current) throw new HttpError(404, `no longer on disk: ${row.path}`);
      const currentHash = sha256(current);
      if (currentHash !== body.base_hash) {
        throw new HttpError(409, 'the file changed on disk since you opened it', { current_hash: currentHash });
      }

      // Write-then-rename in the same directory, so a crash or full disk leaves
      // either the old file or the new one, never a truncated half.
      const info = await stat(abs);
      const tmp = join(dirname(abs), `.${basename(abs)}.sb-${randomBytes(6).toString('hex')}.tmp`);
      try {
        await writeFile(tmp, next, { mode: info.mode & 0o777 });
        await rename(tmp, abs);
      } catch (err) {
        await unlink(tmp).catch(() => {});
        throw err;
      }

      await reindexFile(vaultRoot, row.path);
      const after = await stat(abs);
      res.json({ path: row.path, hash: sha256(next), mtime: after.mtime.toISOString(), size_bytes: after.size });
    }),
  );

  return router;
}
