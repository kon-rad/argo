import { pool } from './db.js';
import { contextualizerFromConfig, embedVault, providerFromConfig } from './embeddings/embed.js';

/**
 * secondbrain embed. With `--api <url>` and a running server, it goes through
 * POST /api/sources/:id/sync for the embeddings source, so the server's queue owns
 * the run; otherwise it embeds new and changed notes directly through the provider
 * from the sources row (the same path as the nightly deploy/secondbrain-embed.mjs).
 */
const argv = process.argv.slice(2);
const apiArg = argv.indexOf('--api');
const api = apiArg >= 0 ? argv[apiArg + 1] : undefined;

if (api) {
  const res = await fetch(`${api}/api/sources`, { signal: AbortSignal.timeout(5000) });
  const { sources } = (await res.json()) as { sources: { id: number; kind: string }[] };
  const embeddings = sources.find((s) => s.kind === 'embeddings');
  if (!embeddings) {
    console.error('no embeddings source - apply migrations first');
    process.exit(1);
  }
  const sync = await fetch(`${api}/api/sources/${embeddings.id}/sync`, { method: 'POST', signal: AbortSignal.timeout(30000) });
  const j = (await sync.json()) as { run_id: number; status: string };
  console.log(`run ${j.run_id}: ${j.status}`);
} else {
  const { rows } = await pool.query<{ config: Record<string, unknown> }>('SELECT config FROM sources WHERE kind=$1', ['embeddings']);
  const c = rows[0]?.config;
  if (!c) {
    console.error('no embeddings source');
    await pool.end();
    process.exit(1);
  }
  const stats = await embedVault({
    provider: providerFromConfig(c as never),
    maxChunkTokens: (c.max_chunk_tokens as number) ?? 450,
    overlapTokens: (c.overlap_tokens as number) ?? 60,
    batchSize: (c.batch_size as number) ?? 32,
    contextualizer: contextualizerFromConfig(c as never),
    onProgress: (p) => process.stderr.write(`\r  ${p.filesDone}/${p.filesTotal} ${p.currentPath.slice(0, 60)}          `),
  });
  process.stderr.write('\n');
  console.log(JSON.stringify(stats, null, 2));
  await pool.end();
}
