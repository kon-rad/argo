import { query as dbQuery, withTransaction } from '../db.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import { complete, type ChatMessage, type ChatProvider } from '../llm/types.js';
import { log } from '../logger.js';
import { queryText } from '../semantic.js';
import type { Reranker } from './rerank.js';

/**
 * Retrieval for a question (docs/rag.md, section 4): condense the question
 * against the conversation, pull chunks by meaning and by words, fuse the two
 * rankings, optionally rerank, then widen each winner with its neighbours and
 * pack the result into a token budget. Every step degrades on its own: no
 * embedding provider means keyword only, no chat model means no condensing,
 * no reranker means fused order, and the result says which ran.
 */

export interface Passage {
  /** 1-based citation number the model is told to use. */
  n: number;
  file_id: number;
  path: string;
  title: string;
  heading_path: string;
  /** First and last chunk index this passage spans (neighbours included). */
  chunk_from: number;
  chunk_to: number;
  content: string;
  score: number;
  tokens: number;
}

export interface RetrievalResult {
  /** The query the chunks were fetched with, then any alternates that were fused in. */
  queries: string[];
  passages: Passage[];
  /** Which arms ran. */
  vector: boolean;
  keyword: boolean;
  reranked: boolean;
  ms: number;
}

export interface RetrieveOptions {
  /** null: the vector arm is skipped. */
  embedding?: EmbeddingProvider | null;
  /** The model that condenses the question; null: the question is used as typed. */
  llm?: ChatProvider | null;
  /** Earlier turns, oldest first; the last user turn is the question itself and must not be here. */
  history?: ChatMessage[];
  /** Passages handed to the model. */
  topK?: number;
  /** Candidates per arm before fusion. */
  candidates?: number;
  /** Ask the condenser for alternate phrasings and fuse them. */
  multiQuery?: boolean;
  reranker?: Reranker | null;
  /** Total token budget across passages (estimates). */
  maxTokens?: number;
  /** Passages from one note. */
  perFile?: number;
  signal?: AbortSignal;
}

const DEFAULTS = { topK: 8, candidates: 40, maxTokens: 6000, perFile: 3 };
const RRF_K = 60;
/** How many fused candidates the reranker sees. */
const RERANK_WINDOW = 30;
/** How many lines of history the condenser sees; older turns rarely change the meaning of the latest one. */
const HISTORY_TURNS = 8;
const HISTORY_CHARS = 600;

const toVectorLiteral = (v: readonly number[]): string => `[${v.join(',')}]`;

// ---------------------------------------------------------------------------
// 1. Condense
// ---------------------------------------------------------------------------

export interface Condensed {
  query: string;
  alternates: string[];
}

export function condensePrompt(history: ChatMessage[], question: string, wantAlternates: boolean): string {
  const turns = history
    .filter((m) => m.role !== 'system')
    .slice(-HISTORY_TURNS)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, HISTORY_CHARS).replace(/\s+/g, ' ')}`)
    .join('\n');
  return [
    turns ? `Conversation so far:\n${turns}\n` : '',
    `Latest message from the user:\n${question}\n`,
    'Rewrite the latest message as one standalone search query over the user\'s personal notes: resolve "it", "that", "the second one" and other references from the conversation, keep names, dates and terms exactly as written, and drop pleasantries. If the message is not a question about the notes (a greeting, a thank-you), return it unchanged.',
    wantAlternates
      ? 'Also give up to 2 alternate queries that would find the same notes with different words (a synonym, a sub-question, a likely note title); none when the message is already specific.'
      : 'Give no alternates.',
    'Answer with JSON only: {"query": "...", "alternates": ["...", "..."]}',
  ]
    .filter(Boolean)
    .join('\n');
}

export function parseCondensed(text: string, fallback: string): Condensed {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return { query: fallback, alternates: [] };
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1)) as { query?: unknown; alternates?: unknown };
    const query = typeof obj.query === 'string' && obj.query.trim() ? obj.query.trim() : fallback;
    const alternates = Array.isArray(obj.alternates)
      ? obj.alternates
          .filter((a): a is string => typeof a === 'string')
          .map((a) => a.trim())
          .filter((a) => a && a.toLowerCase() !== query.toLowerCase())
          .slice(0, 2)
      : [];
    return { query, alternates };
  } catch {
    return { query: fallback, alternates: [] };
  }
}

export async function condense(
  llm: ChatProvider,
  history: ChatMessage[],
  question: string,
  wantAlternates: boolean,
  signal?: AbortSignal,
): Promise<Condensed> {
  try {
    const { text } = await complete(llm, {
      system: 'You turn chat messages into search queries. Output JSON only.',
      messages: [{ role: 'user', content: condensePrompt(history, question, wantAlternates) }],
      maxTokens: 300,
      temperature: 0,
      signal,
    });
    return parseCondensed(text, question);
  } catch (err) {
    if (signal?.aborted) throw err;
    log.warn(`condense: ${(err as Error).message}; searching the question as typed`);
    return { query: question, alternates: [] };
  }
}

// ---------------------------------------------------------------------------
// 2. Hybrid chunk retrieval
// ---------------------------------------------------------------------------

interface ChunkRow {
  id: number;
  file_id: number;
  chunk_index: number;
  heading_path: string;
  content: string;
  context: string;
  token_estimate: number;
  path: string;
  title: string;
  score: number;
}

/**
 * The lexical arm's query. `websearch_to_tsquery` ANDs plain words, which is
 * right for a search box and wrong for a question: "what did I decide about
 * the garage heater" must still find a note that never says "decide". The
 * words are OR'd and `ts_rank_cd` ranks the chunks that match more of them
 * higher. Quoted phrases and -exclusions are kept as the user wrote them.
 */
export function keywordQuery(q: string): string {
  const phrases = [...q.matchAll(/"[^"]+"/g)].map((m) => m[0]);
  const rest = q.replace(/"[^"]+"/g, ' ');
  const words = rest
    .split(/[^\p{L}\p{N}_'-]+/u)
    .map((w) => w.trim())
    .filter((w) => w.length > 1 && !/^or$|^and$/i.test(w));
  return [...phrases, ...words].join(' OR ');
}

async function hybridChunks(
  q: string,
  embedding: EmbeddingProvider | null,
  candidates: number,
): Promise<{ rows: ChunkRow[]; vector: boolean; keyword: boolean }> {
  let vector: number[] | null = null;
  if (embedding) {
    try {
      vector = (await embedding.embed([queryText(q, embedding.model)]))[0] ?? null;
    } catch (err) {
      log.warn(`retrieve: vector arm unavailable (${(err as Error).message}); keyword only`);
    }
  }
  const kq = keywordQuery(q);
  const rows = await withTransaction(async (c) => {
    // A deeper graph search at query time buys recall for a few milliseconds;
    // relaxed ordering keeps the index in play should a filter be added.
    await c.query('SET LOCAL hnsw.ef_search = 100; SET LOCAL hnsw.iterative_scan = relaxed_order');
    const { rows } = await c.query<ChunkRow>(
      `WITH vec AS (
         SELECT c.id, row_number() OVER (ORDER BY c.embedding <=> $1::vector) AS r
         FROM vault_chunks c
         WHERE $1::text IS NOT NULL
         ORDER BY c.embedding <=> $1::vector
         LIMIT $2
       ),
       kw AS (
         SELECT c.id, row_number() OVER (ORDER BY ts_rank_cd(c.tsv, q.tsq) DESC, c.id) AS r
         FROM vault_chunks c, (SELECT websearch_to_tsquery('english', $3) AS tsq) q
         WHERE $3 <> '' AND c.tsv @@ q.tsq
         ORDER BY ts_rank_cd(c.tsv, q.tsq) DESC, c.id
         LIMIT $2
       ),
       fused AS (
         SELECT id, sum(1.0 / (${RRF_K} + r)) AS score
         FROM (SELECT id, r FROM vec UNION ALL SELECT id, r FROM kw) u
         GROUP BY id
       )
       SELECT c.id, c.file_id, c.chunk_index, c.heading_path, c.content, c.context, c.token_estimate,
              f.path, coalesce(f.title, f.name) AS title, fused.score::float8 AS score
       FROM fused
       JOIN vault_chunks c ON c.id = fused.id
       JOIN vault_files f ON f.id = c.file_id
       ORDER BY fused.score DESC, c.file_id, c.chunk_index
       LIMIT $2`,
      [vector ? toVectorLiteral(vector) : null, candidates, kq],
    );
    return rows;
  });
  return { rows, vector: vector !== null, keyword: kq !== '' };
}

// ---------------------------------------------------------------------------
// 3 to 6. Fuse, rerank, expand, pack
// ---------------------------------------------------------------------------

function fuseAcrossQueries(lists: ChunkRow[][]): ChunkRow[] {
  if (lists.length === 1) return lists[0]!;
  const fused = new Map<number, { row: ChunkRow; score: number }>();
  for (const list of lists) {
    list.forEach((row, i) => {
      const e = fused.get(row.id);
      const contribution = 1 / (RRF_K + i + 1);
      if (e) e.score += contribution;
      else fused.set(row.id, { row, score: contribution });
    });
  }
  return [...fused.values()]
    .sort((a, b) => b.score - a.score || a.row.file_id - b.row.file_id || a.row.chunk_index - b.row.chunk_index)
    .map(({ row, score }) => ({ ...row, score }));
}

/** The chunk's own text, without the `Title > Heading` line the embedder put in front. */
export function chunkBody(content: string): string {
  return content.includes('\n\n') ? content.slice(content.indexOf('\n\n') + 2) : content;
}

/**
 * Widens each winning chunk by one neighbour on each side, merges spans that
 * touch, and keeps a per-note cap and a total budget. Winners are visited
 * best first, so the budget goes to the strongest matches.
 */
async function expand(winners: ChunkRow[], opts: Required<Pick<RetrieveOptions, 'topK' | 'maxTokens' | 'perFile'>>): Promise<Passage[]> {
  if (winners.length === 0) return [];
  const fileIds = [...new Set(winners.map((w) => w.file_id))];
  const { rows: all } = await dbQuery<Pick<ChunkRow, 'id' | 'file_id' | 'chunk_index' | 'heading_path' | 'content' | 'token_estimate'>>(
    `SELECT id, file_id, chunk_index, heading_path, content, token_estimate
     FROM vault_chunks WHERE file_id = ANY($1::int[]) ORDER BY file_id, chunk_index`,
    [fileIds],
  );
  const byFile = new Map<number, typeof all>();
  for (const r of all) {
    const list = byFile.get(r.file_id) ?? [];
    list.push(r);
    byFile.set(r.file_id, list);
  }

  const passages: Passage[] = [];
  const perFile = new Map<number, number>();
  const covered = new Map<number, Set<number>>();
  let tokens = 0;

  for (const w of winners) {
    if (passages.length >= opts.topK) break;
    if ((perFile.get(w.file_id) ?? 0) >= opts.perFile) continue;
    const seen = covered.get(w.file_id) ?? new Set<number>();
    if (seen.has(w.chunk_index)) continue; // already inside an earlier passage of this note

    const chunks = byFile.get(w.file_id) ?? [];
    const from = Math.max(0, w.chunk_index - 1);
    const to = w.chunk_index + 1;
    const span = chunks.filter((c) => c.chunk_index >= from && c.chunk_index <= to && !seen.has(c.chunk_index));
    if (span.length === 0) continue;
    const estimate = span.reduce((n, c) => n + c.token_estimate, 0);
    if (passages.length > 0 && tokens + estimate > opts.maxTokens) continue;

    const text = span
      .map((c, i) => (i === 0 ? c.content : chunkBody(c.content)))
      .join('\n\n');
    for (const c of span) seen.add(c.chunk_index);
    covered.set(w.file_id, seen);
    perFile.set(w.file_id, (perFile.get(w.file_id) ?? 0) + 1);
    tokens += estimate;
    passages.push({
      n: passages.length + 1,
      file_id: w.file_id,
      path: w.path,
      title: w.title,
      heading_path: w.heading_path,
      chunk_from: span[0]!.chunk_index,
      chunk_to: span[span.length - 1]!.chunk_index,
      content: text,
      score: w.score,
      tokens: estimate,
    });
  }
  return passages;
}

export async function retrieve(question: string, o: RetrieveOptions = {}): Promise<RetrievalResult> {
  const started = Date.now();
  const topK = o.topK ?? DEFAULTS.topK;
  const candidates = o.candidates ?? DEFAULTS.candidates;
  const history = o.history ?? [];
  const q = question.trim();
  if (!q) return { queries: [], passages: [], vector: false, keyword: false, reranked: false, ms: 0 };

  // Condense only when it can change something: a follow-up turn, or when
  // alternates are wanted. A first question is already standalone.
  let condensed: Condensed = { query: q, alternates: [] };
  if (o.llm && (history.length > 0 || o.multiQuery)) {
    condensed = await condense(o.llm, history, q, o.multiQuery ?? false, o.signal);
  }
  const queries = [condensed.query, ...condensed.alternates];

  const arms = await Promise.all(queries.map((query) => hybridChunks(query, o.embedding ?? null, candidates)));
  let fused = fuseAcrossQueries(arms.map((a) => a.rows));
  const vector = arms.some((a) => a.vector);
  const keyword = arms.some((a) => a.keyword);

  let reranked = false;
  if (o.reranker && fused.length > 1) {
    const window = fused.slice(0, RERANK_WINDOW);
    try {
      const order = await o.reranker.rerank(
        condensed.query,
        window.map((c) => (c.context ? `${c.context}\n\n${c.content}` : c.content)),
        window.length,
      );
      if (order.length > 0) {
        const picked = order.map((r) => ({ ...window[r.index]!, score: r.score }));
        const pickedIds = new Set(picked.map((p) => p.id));
        fused = [...picked, ...fused.filter((c) => !pickedIds.has(c.id))];
        reranked = true;
      }
    } catch (err) {
      log.warn(`rerank: ${(err as Error).message}; keeping fused order`);
    }
  }

  const passages = await expand(fused, { topK, maxTokens: o.maxTokens ?? DEFAULTS.maxTokens, perFile: o.perFile ?? DEFAULTS.perFile });
  return { queries, passages, vector, keyword, reranked, ms: Date.now() - started };
}
