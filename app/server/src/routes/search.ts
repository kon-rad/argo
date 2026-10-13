import { Router } from 'express';
import { z } from 'zod';
import { search } from '../search.js';
import { hybridSearch, semanticSearch } from '../semantic.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import { HttpError, parseOr400, wrap } from './http.js';

const Q = z.object({
  q: z.string().trim().min(1, 'a search term is required'),
  source: z.enum(['vault', 'discord']).optional(),
  mode: z.enum(['keyword', 'semantic', 'hybrid']).default('keyword'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ProviderFactory = () => EmbeddingProvider;

export function searchRouter(embeddingProvider?: ProviderFactory): Router {
  const router = Router();

  /**
   * Building the provider throws when there is no API key. That is a
   * configuration state, not a bug: 503 tells the UI to hide the semantic
   * toggle, where a 500 would just look broken.
   */
  const provider = (): EmbeddingProvider => {
    if (!embeddingProvider) {
      throw new HttpError(503, 'semantic search is not configured on this server');
    }
    try {
      return embeddingProvider();
    } catch (err) {
      throw new HttpError(503, err instanceof Error ? err.message : String(err));
    }
  };

  router.get(
    '/',
    wrap(async (req, res) => {
      const q = parseOr400(Q, req.query);
      const base = { source: q.source, limit: q.limit, offset: q.offset };

      if (q.mode === 'keyword') {
        const { results, total } = await search(q.q, base);
        res.json({
          q: q.q,
          mode: q.mode,
          results,
          total,
          has_more: q.offset + results.length < total,
        });
        return;
      }

      if (q.mode === 'semantic') {
        const { results, total } = await semanticSearch(q.q, { ...base, provider: provider() });
        res.json({
          q: q.q,
          mode: q.mode,
          results,
          total,
          has_more: q.offset + results.length < total,
        });
        return;
      }

      const { results, total, degraded } = await hybridSearch(q.q, { ...base, provider: provider() });
      res.json({
        q: q.q,
        mode: q.mode,
        results,
        total,
        degraded,
        has_more: q.offset + results.length < total,
      });
    }),
  );

  return router;
}
