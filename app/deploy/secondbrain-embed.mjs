// Nightly: embed vault files whose chunks are missing or stale, with the provider from the sources row.
// Run by secondbrain-embed.service from /opt/secondbrain-app. Resumes by content_hash, so a run cut short
// by its timeout just continues the next night.
const m = await import(process.cwd() + '/server/dist/embeddings/embed.js');
const db = await import(process.cwd() + '/server/dist/db.js');
const { rows } = await db.pool.query('SELECT config FROM sources WHERE kind=$1', ['embeddings']);
const c = rows[0].config;
const t = Date.now();
const stats = await m.embedVault({
  provider: m.providerFromConfig(c),
  maxChunkTokens: c.max_chunk_tokens ?? 450,
  overlapTokens: c.overlap_tokens ?? 60,
  // EMBED_BATCH_SIZE: the droplet CPU needs small batches (32 chunks take ~77 s, over the 60 s request timeout).
  batchSize: Number(process.env.EMBED_BATCH_SIZE) || (c.batch_size ?? 32),
  onProgress: (p) => { if (p.filesDone % 50 === 0) console.log(`${p.filesDone}/${p.filesTotal}`); },
});
console.log(JSON.stringify({ ...stats, seconds: Math.round((Date.now() - t) / 1000) }));
await db.pool.end();
