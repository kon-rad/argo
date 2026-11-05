import { DEFAULT_RECALL_MIN_SIMILARITY, dedupeVaultHits, recallExcluded, shapeVaultHits, type RecallHit, type VaultSearchHit } from './org-powers.js';
import { defaultEmbeddingProvider, loadEmbeddingConfig } from './embeddings/factory.js';
import { hybridSearch } from './semantic.js';
import { search } from './search.js';

/**
 * The vault arm of recall, shared by `secondbrain memory recall` and the org CLI's deprecated `recall`. It runs on the
 * app's own connection: the vault index is not the board, so the sb_org role has no grant on it.
 */

/** A search snippet as plain text for a model: no highlight tags, entities decoded (they cost tokens and mean nothing). */
export function plainSnippet(html: string): string {
  return html
    .replace(/<\/?(?:b|mark|em|strong)>/g, '')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/**
 * The vault side of recall: hybrid (keyword + vector) when embeddings are configured, else keyword, over-fetched and
 * filtered so the excluded paths (the owner's working files and finances) never come back.
 */
export async function recallVault(q: string, limit: number, env: NodeJS.ProcessEnv = process.env, extraExclude: string[] = []): Promise<RecallHit[]> {
  const extra = [...(env.ORG_RECALL_EXCLUDE ?? '').split(',').map((s) => s.trim()).filter(Boolean), ...extraExclude];
  const floor = Number(env.ORG_RECALL_MIN_SIMILARITY);
  const minSimilarity = Number.isFinite(floor) && floor > 0 ? floor : DEFAULT_RECALL_MIN_SIMILARITY;
  let hits: VaultSearchHit[] = [];
  try {
    await loadEmbeddingConfig();
    hits = (await hybridSearch(q, { source: 'vault', limit: limit * 3, offset: 0, provider: defaultEmbeddingProvider(), minSimilarity })).results;
  } catch {
    try {
      hits = (await search(q, { source: 'vault', limit: limit * 3, offset: 0 })).results;
    } catch {
      return [];
    }
  }
  const kept = shapeVaultHits(hits.filter((h) => !recallExcluded(h.ref_path, extra)), limit, minSimilarity)
    .map((h) => ({ source: 'vault' as const, ref: h.ref_path, title: h.title ?? '', text: plainSnippet(h.snippet), score: Number(h.rank) }));
  return dedupeVaultHits(kept).slice(0, limit);
}
