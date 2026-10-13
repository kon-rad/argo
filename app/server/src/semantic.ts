import { query } from './db.js';
import { log } from './logger.js';
import { escapeHtml, search, type SearchHit, type SearchOptions } from './search.js';
import type { EmbeddingProvider } from './embeddings/provider.js';

export interface SemanticHit extends SearchHit {
  match_kind: 'text' | 'filename' | 'semantic' | 'hybrid';
  /** Cosine similarity in [0,1] for the best chunk. Null for keyword-only hits. */
  similarity: number | null;
  heading_path: string | null;
  chunk_index: number | null;
}

export interface SemanticOptions extends SearchOptions {
  provider: EmbeddingProvider;
  /** Cosine similarity floor. Below this a "match" is noise dressed as a result. */
  minSimilarity?: number;
}

/**
 * Retrieval encoders are trained asymmetrically: the passage side is embedded
 * bare, the query side carries a prefix. Dropping the prefix costs real recall
 * and produces no error of any kind — it is the single most common way an
 * embedding-backed search ends up quietly mediocre.
 *
 * Each family wants a different one, so this is keyed off the model name:
 *   e5-*-instruct  an "Instruct:/Query:" pair naming the retrieval task
 *   e5-*           the bare "query: " marker
 *   bge-*          the sentence-representation instruction
 * Anything unrecognised is sent through untouched, which is correct for the
 * symmetric encoders.
 */
const E5_TASK = 'Given a search query, retrieve relevant passages from a personal knowledge vault';

export function queryText(q: string, model: string): string {
  if (/e5-/i.test(model)) {
    return /instruct/i.test(model) ? `Instruct: ${E5_TASK}\nQuery: ${q}` : `query: ${q}`;
  }
  if (/(^|\/)bge-/i.test(model)) {
    return `Represent this sentence for searching relevant passages: ${q}`;
  }
  return q;
}

const DEFAULT_MIN_SIMILARITY = 0.25;
/** How many chunks to pull before collapsing to one row per file. */
const CHUNK_OVERFETCH = 8;

const toVectorLiteral = (v: readonly number[]): string => `[${v.join(',')}]`;

const SNIPPET_CHARS = 320;

function chunkSnippet(content: string): string {
  // Drop the "Title > Heading" context line the embedder needed; the UI shows
  // the path and heading separately, so repeating them here is just noise.
  const body = content.includes('\n\n') ? content.slice(content.indexOf('\n\n') + 2) : content;
  const trimmed = body.length > SNIPPET_CHARS ? `${body.slice(0, SNIPPET_CHARS).trimEnd()}…` : body;
  return escapeHtml(trimmed);
}

interface ChunkRow {
  ref_id: string;
  ref_path: string;
  title: string | null;
  content: string;
  heading_path: string;
  chunk_index: number;
  similarity: number;
  occurred_at: string;
  total: number;
}

/**
 * Nearest-neighbour search over chunk vectors, collapsed to one row per file.
 *
 * The collapse happens after the index scan, not during it: HNSW answers
 * "nearest k chunks", and asking Postgres for "nearest k *files*" would force
 * a sequential scan over every vector in the table. Over-fetching chunks and
 * deduplicating in the outer query keeps the index in play.
 */
export async function semanticSearch(
  q: string,
  opts: SemanticOptions,
): Promise<{ results: SemanticHit[]; total: number }> {
  const term = q.trim();
  if (!term) return { results: [], total: 0 };

  const [vector] = await opts.provider.embed([queryText(term, opts.provider.model)]);
  if (!vector) return { results: [], total: 0 };

  const minSimilarity = opts.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  const wanted = opts.limit + opts.offset;

  const { rows } = await query<ChunkRow>(
    `WITH candidates AS (
       SELECT c.file_id, c.content, c.heading_path, c.chunk_index,
              1 - (c.embedding <=> $1::vector) AS similarity
       FROM vault_chunks c
       ORDER BY c.embedding <=> $1::vector
       LIMIT $2
     ),
     best AS (
       SELECT DISTINCT ON (file_id) file_id, content, heading_path, chunk_index, similarity
       FROM candidates
       WHERE similarity >= $3
       ORDER BY file_id, similarity DESC
     ),
     ranked AS (
       SELECT b.*, f.path, f.title, f.name, f.mtime, count(*) OVER () AS total
       FROM best b
       JOIN vault_files f ON f.id = b.file_id
       ORDER BY b.similarity DESC, f.path
       LIMIT $4 OFFSET $5
     )
     SELECT file_id::text AS ref_id, path AS ref_path, coalesce(title, name) AS title,
            content, heading_path, chunk_index, similarity,
            mtime AS occurred_at, total::int AS total
     FROM ranked
     ORDER BY similarity DESC, ref_path`,
    [toVectorLiteral(vector), Math.max(wanted * CHUNK_OVERFETCH, 50), minSimilarity, opts.limit, opts.offset],
  );

  return {
    results: rows.map((r) => ({
      source_kind: 'vault',
      ref_id: r.ref_id,
      ref_path: r.ref_path,
      title: r.title,
      snippet: chunkSnippet(r.content),
      rank: Number(r.similarity),
      occurred_at: r.occurred_at,
      match_kind: 'semantic' as const,
      similarity: Number(r.similarity),
      heading_path: r.heading_path || null,
      chunk_index: r.chunk_index,
    })),
    total: rows[0]?.total ?? 0,
  };
}

/** Reciprocal-rank-fusion constant. 60 is the value from the original paper. */
const RRF_K = 60;

/**
 * Fuses the keyword and vector rankings with reciprocal rank fusion.
 *
 * RRF combines *ranks*, never scores. ts_rank_cd and cosine similarity are on
 * unrelated scales with unrelated distributions — any attempt to normalise one
 * onto the other is a fudge factor that has to be re-tuned every time the
 * corpus changes. Ranks are directly comparable, which is why RRF beats
 * weighted score blending in practice and needs no tuning at all.
 *
 * If the embedding provider is down, this degrades to keyword-only and says
 * so, rather than failing a search the database could have answered.
 */
export async function hybridSearch(
  q: string,
  opts: SemanticOptions,
): Promise<{ results: SemanticHit[]; total: number; degraded: boolean }> {
  const term = q.trim();
  if (!term) return { results: [], total: 0, degraded: false };

  // Fuse over a deeper slice than the caller asked for: a document ranked 30th
  // by one branch and 2nd by the other should be able to reach the first page.
  const depth = Math.min(Math.max((opts.limit + opts.offset) * 4, 40), 200);

  const keywordPromise = search(term, { source: opts.source, limit: depth, offset: 0 });
  const semanticPromise = semanticSearch(term, { ...opts, limit: depth, offset: 0 }).catch(
    (err: unknown) => {
      log.warn(`semantic branch unavailable, falling back to keyword: ${(err as Error).message}`);
      return null;
    },
  );

  const [keyword, semantic] = await Promise.all([keywordPromise, semanticPromise]);
  const degraded = semantic === null;

  interface Fused {
    hit: SemanticHit;
    score: number;
    branches: number;
  }
  const fused = new Map<string, Fused>();

  const add = (hit: SemanticHit, rank: number): void => {
    const key = `${hit.source_kind}:${hit.ref_path}`;
    const existing = fused.get(key);
    const contribution = 1 / (RRF_K + rank + 1);
    if (!existing) {
      fused.set(key, { hit, score: contribution, branches: 1 });
      return;
    }
    existing.score += contribution;
    existing.branches++;
    // Prefer the keyword branch's ts_headline snippet — it highlights the
    // matched terms — but keep whichever similarity we learned.
    if (hit.match_kind === 'text' || hit.match_kind === 'filename') {
      existing.hit = { ...hit, similarity: existing.hit.similarity, heading_path: existing.hit.heading_path };
    } else if (existing.hit.similarity === null) {
      existing.hit = { ...existing.hit, similarity: hit.similarity, heading_path: hit.heading_path, chunk_index: hit.chunk_index };
    }
  };

  keyword.results.forEach((r, i) =>
    add(
      {
        ...r,
        match_kind: r.rank <= 1e-6 ? 'filename' : 'text',
        similarity: null,
        heading_path: null,
        chunk_index: null,
      },
      i,
    ),
  );
  semantic?.results.forEach((r, i) => add(r, i));

  const ordered = [...fused.values()]
    .sort((a, b) => b.score - a.score || a.hit.ref_path.localeCompare(b.hit.ref_path))
    .map(({ hit, score, branches }) => ({
      ...hit,
      rank: score,
      match_kind: branches > 1 ? ('hybrid' as const) : hit.match_kind,
    }));

  return {
    results: ordered.slice(opts.offset, opts.offset + opts.limit),
    total: ordered.length,
    degraded,
  };
}
