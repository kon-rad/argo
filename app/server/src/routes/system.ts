import { Router } from 'express';
import { query } from '../db.js';
import { log } from '../logger.js';
import { wrap } from './http.js';

export function systemRouter(vaultRoot: string, onShutdown?: () => void): Router {
  const router = Router();

  router.get(
    '/system',
    wrap(async (_req, res) => {
      const { rows } = await query<{
        files: number;
        markdown: number;
        links: number;
        tags: number;
      }>(
        `SELECT (SELECT count(*)::int FROM vault_files)                   AS files,
                (SELECT count(*)::int FROM vault_files WHERE is_markdown) AS markdown,
                (SELECT count(*)::int FROM vault_links)                   AS links,
                (SELECT count(DISTINCT tag)::int FROM vault_tags)         AS tags`,
      );
      // Coverage is what tells the UI whether semantic search is worth
      // offering yet: an unembedded vault answers every vector query with
      // nothing, which reads as a broken feature rather than an unbuilt index.
      const { rows: embedRows } = await query<{
        chunks: number;
        files_embedded: number;
        files_embeddable: number;
        model: string | null;
        last_embedded_at: string | null;
      }>(
        `SELECT (SELECT count(*)::int FROM vault_chunks)                        AS chunks,
                (SELECT count(DISTINCT file_id)::int FROM vault_chunks)         AS files_embedded,
                (SELECT count(*)::int FROM vault_files
                  WHERE is_markdown AND body IS NOT NULL AND btrim(body) <> '') AS files_embeddable,
                (SELECT model FROM vault_chunks LIMIT 1)                        AS model,
                (SELECT max(created_at) FROM vault_chunks)                       AS last_embedded_at`,
      );
      res.json({ vault_root: vaultRoot, counts: rows[0], embeddings: embedRows[0] });
    }),
  );

  router.post('/shutdown', (_req, res) => {
    if (!onShutdown) {
      res.status(501).json({ error: { message: 'this server cannot shut itself down' } });
      return;
    }
    res.status(202).json({ status: 'shutting down' });
    // After the response is flushed, or the client sees a dropped socket.
    res.on('finish', () => {
      log.info('shutdown requested over HTTP');
      onShutdown();
    });
  });

  return router;
}
