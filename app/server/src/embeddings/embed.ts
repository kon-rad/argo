import { z } from 'zod';
import { config } from '../config.js';
import { query, withTransaction } from '../db.js';
import { log } from '../logger.js';
import type { Connector, RunContext } from '../connectors/types.js';
import { chunkMarkdown } from './chunk.js';
import { llmContextualizer, type Contextualizer } from './contextualize.js';
import { buildChatProvider, pickProvider, providerCatalog } from '../llm/registry.js';
import {
  createProvider,
  isContextLengthError,
  type EmbeddingProvider,
  type ProviderId,
} from './provider.js';
import type { Chunk } from './chunk.js';

export interface EmbedStats {
  filesEmbedded: number;
  filesSkipped: number;
  chunksWritten: number;
  chunksDeleted: number;
  tokensEstimated: number;
  apiCalls: number;
  /** Notes that got a model-written context line in front of each chunk. */
  filesContextualized: number;
  model: string;
  durationMs: number;
}

export interface EmbedOptions {
  provider: EmbeddingProvider;
  maxChunkTokens: number;
  overlapTokens: number;
  batchSize: number;
  /** Writes one line of context per chunk before embedding (contextual retrieval). Absent: plain chunks. */
  contextualizer?: Contextualizer;
  onProgress?: (p: { phase: string; filesDone: number; filesTotal: number; currentPath: string }) => void;
  signal?: AbortSignal;
}

interface Candidate {
  id: number;
  path: string;
  title: string | null;
  name: string;
  body: string;
  content_hash: string;
}

/** pgvector's text input format. */
const toVectorLiteral = (v: readonly number[]): string => `[${v.join(',')}]`;

/** What the encoder sees: the context line (when there is one) in front of the chunk. */
export const embedText = (c: Chunk): string => (c.context ? `${c.context}\n\n${c.content}` : c.content);

/** Below this a further split is pointless; the content is pathological. */
const MIN_SPLITTABLE_CHARS = 200;

/** Splits one chunk in half on the nearest paragraph, then line, then midpoint. */
function halve(chunk: Chunk): Chunk[] {
  const text = chunk.content;
  const mid = Math.floor(text.length / 2);
  const window = Math.floor(text.length / 4);
  const near = (needle: string): number => {
    const idx = text.lastIndexOf(needle, mid + window);
    return idx > mid - window ? idx + needle.length : -1;
  };
  const cut = [near('\n\n'), near('\n'), near('. ')].find((i) => i > 0) ?? mid;

  const span = chunk.charEnd - chunk.charStart;
  const ratio = cut / text.length;
  const splitAt = chunk.charStart + Math.round(span * ratio);
  return [
    { ...chunk, content: text.slice(0, cut).trim(), charEnd: splitAt },
    { ...chunk, content: text.slice(cut).trim(), charStart: splitAt },
  ].filter((c) => c.content.length > 0);
}

/**
 * Embeds every chunk, splitting any the encoder rejects as too long.
 *
 * The chunker sizes chunks from a chars-per-token estimate, and an estimate is
 * exactly as good as the corpus it was calibrated on. Rather than tune that
 * constant until the current vault happens to fit — and have the next dense
 * note or the next model break the run again — this asks the encoder and
 * believes the answer. A rejected batch is retried one chunk at a time, and a
 * rejected chunk is halved and retried, until it fits or is too small to be
 * worth splitting.
 *
 * Returns the chunks that were actually embedded, re-indexed, because a split
 * produces more chunks than went in.
 */
async function embedChunks(
  provider: EmbeddingProvider,
  chunks: readonly Chunk[],
  batchSize: number,
  signal: AbortSignal | undefined,
  onApiCall: () => void,
): Promise<{ chunks: Chunk[]; vectors: number[][] }> {
  const outChunks: Chunk[] = [];
  const outVectors: number[][] = [];

  /**
   * Embeds a group, and on a context-length rejection bisects it and retries
   * each half. A single oversized chunk is halved on a paragraph boundary.
   *
   * Bisecting rather than dropping straight to one-call-per-chunk matters:
   * with a batch of 32 the naive fallback costs 32 round trips every time one
   * chunk is too long, which measured out at ~11 s per note over the real
   * vault. Bisection isolates the offender in about log2(32) calls instead.
   */
  const embedGroup = async (group: readonly Chunk[]): Promise<void> => {
    if (group.length === 0) return;
    if (signal?.aborted) throw new Error('embedding run aborted');

    try {
      onApiCall();
      const vectors = await provider.embed(group.map(embedText));
      outChunks.push(...group);
      outVectors.push(...vectors);
      return;
    } catch (err) {
      if (!isContextLengthError(err)) throw err;

      if (group.length > 1) {
        const mid = Math.ceil(group.length / 2);
        await embedGroup(group.slice(0, mid));
        await embedGroup(group.slice(mid));
        return;
      }

      const chunk = group[0]!;
      if (chunk.content.length < MIN_SPLITTABLE_CHARS) throw err;
      const halves = halve(chunk);
      if (halves.length < 2) throw err;
      await embedGroup([halves[0]!]);
      await embedGroup([halves[1]!]);
    }
  };

  for (let i = 0; i < chunks.length; i += batchSize) {
    await embedGroup(chunks.slice(i, i + batchSize));
  }

  return {
    chunks: outChunks.map((c, i) => ({ ...c, chunkIndex: i })),
    vectors: outVectors,
  };
}

/**
 * Re-embeds only what changed. `vault_chunks.content_hash` is a copy of the
 * parent file's hash at embed time, so the set of files needing work is a
 * single join — no timestamps, no bookkeeping table, and correct even if a
 * run dies halfway through.
 *
 * Switching models invalidates every vector at once: cosine distance between
 * two different encoders' outputs is meaningless, so a model change is a full
 * rebuild rather than a mixed index that silently returns nonsense.
 */
export async function embedVault(opts: EmbedOptions): Promise<EmbedStats> {
  const started = Date.now();
  const { provider } = opts;

  // Probe before deleting. An unconditional DELETE writes on every run even
  // when there is nothing stale, which breaks the zero-write invariant the
  // scanner holds to — and this table is on the same contract.
  const { rows: staleRows } = await query<{ n: number }>(
    `SELECT count(*)::int n FROM vault_chunks WHERE model <> $1`,
    [provider.model],
  );
  let chunksDeleted = staleRows[0]?.n ?? 0;
  if (chunksDeleted > 0) {
    await query(`DELETE FROM vault_chunks WHERE model <> $1`, [provider.model]);
  }

  const { rows: candidates } = await query<Candidate>(
    `SELECT f.id, f.path, f.title, f.name, f.body, f.content_hash
     FROM vault_files f
     WHERE f.is_markdown
       AND f.body IS NOT NULL
       AND btrim(f.body) <> ''
       AND NOT EXISTS (
         SELECT 1 FROM vault_chunks c
         WHERE c.file_id = f.id AND c.content_hash = f.content_hash AND c.model = $1
       )
     ORDER BY f.path`,
    [provider.model],
  );

  const { rows: totalRows } = await query<{ n: number }>(
    `SELECT count(*)::int n FROM vault_files WHERE is_markdown AND body IS NOT NULL AND btrim(body) <> ''`,
  );
  const filesSkipped = (totalRows[0]?.n ?? 0) - candidates.length;

  let filesEmbedded = 0;
  let chunksWritten = 0;
  let tokensEstimated = 0;
  let apiCalls = 0;
  let filesContextualized = 0;
  let filesDone = 0;

  for (const file of candidates) {
    if (opts.signal?.aborted) throw new Error('embedding run aborted');

    let chunks = chunkMarkdown(file.body, file.title ?? file.name, {
      maxTokens: opts.maxChunkTokens,
      overlapTokens: opts.overlapTokens,
    });
    if (opts.contextualizer && chunks.length > 0) {
      const contexts = await opts.contextualizer({ title: file.title ?? file.name, path: file.path, body: file.body }, chunks);
      chunks = chunks.map((c, i) => ({ ...c, context: contexts[i] ?? '' }));
      if (contexts.some((c) => c)) filesContextualized++;
    }

    if (chunks.length === 0) {
      // Nothing embeddable, but the stale rows still have to go or the next
      // run would keep picking this file up forever.
      const { rowCount } = await query(`DELETE FROM vault_chunks WHERE file_id = $1`, [file.id]);
      chunksDeleted += rowCount ?? 0;
      filesDone++;
      continue;
    }

    const { chunks: embedded, vectors } = await embedChunks(
      provider,
      chunks,
      opts.batchSize,
      opts.signal,
      () => apiCalls++,
    );

    // Replace in one transaction: a crash mid-file must not leave a note with
    // half its chunks and a hash claiming it is fully embedded.
    await withTransaction(async (tx) => {
      const { rowCount } = await tx.query(`DELETE FROM vault_chunks WHERE file_id = $1`, [file.id]);
      chunksDeleted += rowCount ?? 0;
      await tx.query(
        `INSERT INTO vault_chunks
           (file_id, chunk_index, heading_path, content, token_estimate,
            char_start, char_end, content_hash, model, embedding, context)
         SELECT $1, t.idx, t.heading, t.content, t.tokens, t.cstart, t.cend, $2, $3, t.vec::vector, t.ctx
         FROM unnest($4::int[], $5::text[], $6::text[], $7::int[], $8::int[], $9::int[], $10::text[], $11::text[])
              AS t(idx, heading, content, tokens, cstart, cend, vec, ctx)`,
        [
          file.id,
          file.content_hash,
          provider.model,
          embedded.map((c) => c.chunkIndex),
          embedded.map((c) => c.headingPath),
          embedded.map((c) => c.content),
          embedded.map((c) => c.tokenEstimate),
          embedded.map((c) => c.charStart),
          embedded.map((c) => c.charEnd),
          vectors.map(toVectorLiteral),
          embedded.map((c) => c.context ?? ''),
        ],
      );
    });

    filesEmbedded++;
    chunksWritten += embedded.length;
    tokensEstimated += embedded.reduce((n, c) => n + c.tokenEstimate, 0);
    filesDone++;

    opts.onProgress?.({
      phase: 'embedding',
      filesDone,
      filesTotal: candidates.length,
      currentPath: file.path,
    });
  }

  const stats: EmbedStats = {
    filesEmbedded,
    filesSkipped,
    chunksWritten,
    chunksDeleted,
    tokensEstimated,
    apiCalls,
    filesContextualized,
    model: provider.model,
    durationMs: Date.now() - started,
  };
  log.info(`embedding run complete: ${JSON.stringify(stats)}`);
  return stats;
}

const ConfigSchema = z
  .object({
    provider: z.enum(['together', 'ollama']).default('together'),
    model: z.string().default('intfloat/multilingual-e5-large-instruct'),
    dimensions: z.number().int().positive().default(1024),
    max_chunk_tokens: z.number().int().positive().default(400),
    overlap_tokens: z.number().int().min(0).default(60),
    batch_size: z.number().int().positive().max(128).default(32),
    // Contextual retrieval: a chat model writes one line of context per chunk
    // before it is embedded (docs/rag.md). One call per changed note.
    contextualize: z.boolean().default(false),
    // A preset provider id and one of its models; unset: the chat's default provider and its default model.
    context_provider: z.string().optional(),
    context_model: z.string().optional(),
  })
  .passthrough();

/** The schema column is `vector(1024)`; anything else cannot be stored. */
export const EMBEDDING_DIMENSIONS = 1024;

export function providerFromConfig(raw: Record<string, unknown>): EmbeddingProvider {
  const cfg = ConfigSchema.parse(raw);
  if (cfg.dimensions !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `vault_chunks.embedding is vector(${EMBEDDING_DIMENSIONS}); model '${cfg.model}' declares ${cfg.dimensions}. ` +
        `Change the column in a migration before switching to a model of a different width.`,
    );
  }
  return createProvider({
    provider: cfg.provider as ProviderId,
    model: cfg.model,
    dimensions: cfg.dimensions,
    apiKey: config.togetherApiKey,
    baseUrl: cfg.provider === 'ollama' ? config.ollamaUrl : undefined,
  });
}

/**
 * The contextualizer the source config asks for, or undefined when the step
 * is off or no chat provider has a key: a missing key degrades to plain
 * chunks with a warning, never a failed run, because the vectors are still
 * worth having.
 */
export function contextualizerFromConfig(raw: Record<string, unknown>, signal?: AbortSignal): Contextualizer | undefined {
  const cfg = ConfigSchema.parse(raw);
  if (!cfg.contextualize) return undefined;
  try {
    const catalog = providerCatalog();
    const option = pickProvider(catalog, cfg.context_provider);
    if (!option) throw new Error('no chat provider has a key');
    const model = cfg.context_provider === option.id && cfg.context_model ? cfg.context_model : option.default;
    return llmContextualizer(buildChatProvider(option.id, model), { signal });
  } catch (err) {
    log.warn(`contextualize is on but no model can be called (${(err as Error).message}); embedding plain chunks`);
    return undefined;
  }
}

export const embeddingsConnector: Connector<EmbedStats> = {
  id: 'embeddings',
  configSchema: ConfigSchema,
  run: (ctx: RunContext) => {
    const cfg = ConfigSchema.parse(ctx.config);
    return embedVault({
      provider: providerFromConfig(ctx.config),
      maxChunkTokens: cfg.max_chunk_tokens,
      overlapTokens: cfg.overlap_tokens,
      batchSize: cfg.batch_size,
      contextualizer: contextualizerFromConfig(ctx.config, ctx.signal),
      onProgress: (p) => ctx.onProgress(p),
      signal: ctx.signal,
    });
  },
};
