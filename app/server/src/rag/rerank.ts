import { LlmError, redactSecrets } from '../llm/types.js';

export interface Reranked {
  /** Index into the documents that were passed in. */
  index: number;
  score: number;
}

export interface Reranker {
  model: string;
  /** Returns the documents ordered best first; may return fewer than it was given. */
  rerank(query: string, documents: readonly string[], topN: number): Promise<Reranked[]>;
}

export interface RerankConfig {
  /** e.g. https://api.together.xyz/v1 or https://api.cohere.com/v2 (the client appends /rerank). */
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

/**
 * A cross-encoder behind the Cohere-style `/rerank` endpoint, which Cohere,
 * Together, Jina and Voyage all expose: `{model, query, documents, top_n}` in,
 * `{results: [{index, relevance_score}]}` out.
 */
export function cohereCompatReranker(cfg: RerankConfig): Reranker {
  const fetchFn = cfg.fetchFn ?? fetch;
  return {
    model: cfg.model,
    async rerank(query, documents, topN) {
      if (documents.length === 0) return [];
      let res: Response;
      try {
        res = await fetchFn(`${cfg.baseUrl.replace(/\/+$/, '')}/rerank`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify({ model: cfg.model, query, documents: [...documents], top_n: Math.min(topN, documents.length) }),
          signal: AbortSignal.timeout(cfg.timeoutMs ?? 30_000),
        });
      } catch (err) {
        throw new LlmError(0, `rerank: request failed: ${redactSecrets((err as Error).message, cfg.apiKey)}`);
      }
      if (!res.ok) throw new LlmError(res.status, `rerank: HTTP ${res.status}`);
      const body = (await res.json()) as { results?: { index: number; relevance_score: number }[] };
      return (body.results ?? [])
        .filter((r) => Number.isInteger(r.index) && r.index >= 0 && r.index < documents.length)
        .map((r) => ({ index: r.index, score: Number(r.relevance_score) }))
        .sort((a, b) => b.score - a.score);
    },
  };
}
