import { query } from '../db.js';
import { log } from '../logger.js';
import { providerFromConfig } from './embed.js';
import type { EmbeddingProvider } from './provider.js';

let cached: { provider: EmbeddingProvider; configJson: string } | null = null;
let configJson: string | null = null;

/**
 * Loads the embeddings source config once at boot and builds a provider from
 * it on demand. Read at boot rather than per request because a search should
 * not pay a database round trip to discover which model to call, and the
 * config only changes when someone PATCHes the source — which invalidates it.
 */
export async function loadEmbeddingConfig(): Promise<void> {
  const { rows } = await query<{ config: Record<string, unknown> }>(
    `SELECT config FROM sources WHERE kind = 'embeddings' LIMIT 1`,
  );
  configJson = rows[0] ? JSON.stringify(rows[0].config) : null;
  cached = null;
  if (!configJson) log.warn('no embeddings source configured; semantic search will report 503');
}

export function invalidateEmbeddingProvider(): void {
  cached = null;
  configJson = null;
}

/** Throws when the source is missing or its provider has no credential. */
export function defaultEmbeddingProvider(): EmbeddingProvider {
  if (!configJson) {
    throw new Error('semantic search is not configured — run the Embeddings source once');
  }
  if (cached && cached.configJson === configJson) return cached.provider;
  const provider = providerFromConfig(JSON.parse(configJson) as Record<string, unknown>);
  cached = { provider, configJson };
  return provider;
}
