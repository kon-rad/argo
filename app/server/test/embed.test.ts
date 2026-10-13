import { beforeEach, describe, expect, it } from 'vitest';
import { dbStats, query, resetDbStats } from '../src/db.js';
import { embedVault } from '../src/embeddings/embed.js';
import { ProviderError } from '../src/embeddings/provider.js';
import { fakeProvider, fakeVector } from './embedProvider.js';
import { truncateAll } from './helpers.js';

async function addFile(path: string, title: string, body: string, hash = `h-${path}`): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO vault_files (path,parent_path,name,title,ext,is_markdown,size_bytes,mtime,content_hash,body)
     VALUES ($1,'',$2,$3,'.md',true,$4,now(),$5,$6)
     ON CONFLICT (path) DO UPDATE SET body=EXCLUDED.body, content_hash=EXCLUDED.content_hash,
       title=EXCLUDED.title
     RETURNING id`,
    [path, path, title, body.length, hash, body],
  );
  return rows[0]!.id;
}

const run = (provider = fakeProvider()) =>
  embedVault({ provider, maxChunkTokens: 100, overlapTokens: 20, batchSize: 4 });

beforeEach(truncateAll);

describe('embedVault', () => {
  it('chunks and embeds every markdown file', async () => {
    await addFile('a.md', 'Bread', '## Starter\n\nFeed the sourdough starter daily.');
    await addFile('b.md', 'DB', '## Index\n\nA postgres index speeds a query.');
    const stats = await run();

    expect(stats.filesEmbedded).toBe(2);
    expect(stats.chunksWritten).toBeGreaterThanOrEqual(2);
    const { rows } = await query<{ n: number }>(`SELECT count(*)::int n FROM vault_chunks`);
    expect(rows[0]!.n).toBe(stats.chunksWritten);
  });

  it('never embeds a non-markdown file', async () => {
    await query(
      `INSERT INTO vault_files (path,parent_path,name,ext,is_markdown,size_bytes,mtime,content_hash)
       VALUES ('img.png','','img.png','.png',false,10,now(),'h')`,
    );
    const stats = await run();
    expect(stats.filesEmbedded).toBe(0);
  });

  it('skips a file whose body is empty rather than storing a null vector', async () => {
    await addFile('empty.md', 'Empty', '   \n\n  ');
    const stats = await run();
    expect(stats.filesEmbedded).toBe(0);
    expect(stats.chunksWritten).toBe(0);
  });

  it('a re-run with no changes issues ZERO writes to vault_chunks', async () => {
    await addFile('a.md', 'Bread', '## Starter\n\nFeed the sourdough starter daily.');
    await run();

    resetDbStats();
    const provider = fakeProvider();
    const stats = await embedVault({ provider, maxChunkTokens: 100, overlapTokens: 20, batchSize: 4 });

    expect(stats.filesSkipped).toBe(1);
    expect(stats.filesEmbedded).toBe(0);
    expect(dbStats.writesByTable['vault_chunks'] ?? 0).toBe(0);
    // And it must not have paid an API call for work it skipped.
    expect(provider.calls).toBe(0);
  });

  it('re-embeds a file whose content_hash changed, replacing its chunks', async () => {
    const id = await addFile('a.md', 'Bread', 'Feed the sourdough starter.', 'h1');
    await run();
    const before = await query<{ n: number }>(`SELECT count(*)::int n FROM vault_chunks WHERE file_id=$1`, [id]);

    await addFile('a.md', 'Bread', 'A postgres index speeds a query. '.repeat(40), 'h2');
    const stats = await run();

    expect(stats.filesEmbedded).toBe(1);
    const { rows } = await query<{ n: number; hash: string }>(
      `SELECT count(*)::int n, min(content_hash) hash FROM vault_chunks WHERE file_id=$1`,
      [id],
    );
    expect(rows[0]!.hash).toBe('h2');
    expect(rows[0]!.n).not.toBe(before.rows[0]!.n);
  });

  it('deletes a file and its chunks go with it', async () => {
    const id = await addFile('a.md', 'Bread', 'Feed the sourdough starter.');
    await run();
    await query(`DELETE FROM vault_files WHERE id=$1`, [id]);
    const { rows } = await query<{ n: number }>(`SELECT count(*)::int n FROM vault_chunks`);
    expect(rows[0]!.n).toBe(0);
  });

  it('re-embeds everything when the model changes', async () => {
    await addFile('a.md', 'Bread', 'Feed the sourdough starter.');
    await run(fakeProvider('model-one'));

    const stats = await run(fakeProvider('model-two'));
    expect(stats.filesEmbedded).toBe(1);
    const { rows } = await query<{ model: string }>(`SELECT DISTINCT model FROM vault_chunks`);
    expect(rows.map((r) => r.model)).toEqual(['model-two']);
  });

  it('batches API calls instead of one request per chunk', async () => {
    await addFile('big.md', 'Big', 'alpha beta gamma delta. '.repeat(300));
    const provider = fakeProvider();
    const stats = await embedVault({ provider, maxChunkTokens: 100, overlapTokens: 20, batchSize: 4 });
    expect(stats.chunksWritten).toBeGreaterThan(4);
    expect(provider.calls).toBeLessThan(stats.chunksWritten);
    expect(Math.max(...provider.batches)).toBeLessThanOrEqual(4);
  });

  it('reports progress as it goes', async () => {
    await addFile('a.md', 'A', 'Feed the sourdough starter.');
    await addFile('b.md', 'B', 'A postgres query.');
    const seen: string[] = [];
    await embedVault({
      provider: fakeProvider(),
      maxChunkTokens: 100,
      overlapTokens: 20,
      batchSize: 4,
      onProgress: (p) => seen.push(p.phase),
    });
    expect(seen).toContain('embedding');
  });

  it('stops when the signal aborts', async () => {
    for (let i = 0; i < 5; i++) await addFile(`f${i}.md`, `F${i}`, 'sourdough starter '.repeat(50));
    const controller = new AbortController();
    controller.abort();
    await expect(
      embedVault({ provider: fakeProvider(), maxChunkTokens: 100, overlapTokens: 20, batchSize: 4, signal: controller.signal }),
    ).rejects.toThrow(/abort/i);
  });
});

describe('oversized chunks', () => {
  /** Mimics an encoder with a hard token ceiling, like the real e5 endpoint. */
  function ceilingProvider(maxChars: number) {
    const calls: number[] = [];
    return {
      id: 'together' as const,
      model: 'fake-test-model',
      dimensions: 1024,
      calls,
      async embed(texts: readonly string[]): Promise<number[][]> {
        calls.push(texts.length);
        const total = texts.reduce((n, t) => n + t.length, 0);
        if (total > maxChars) {
          throw new ProviderError(400, "maximum context length is 512 tokens", true);
        }
        return texts.map(fakeVector);
      },
    };
  }

  it('splits and retries a chunk the encoder rejects instead of failing the run', async () => {
    await addFile('dense.md', 'Dense', 'sourdough starter bread. '.repeat(200));
    const provider = ceilingProvider(700);

    const stats = await embedVault({ provider, maxChunkTokens: 400, overlapTokens: 20, batchSize: 8 });

    expect(stats.filesEmbedded).toBe(1);
    expect(stats.chunksWritten).toBeGreaterThan(0);
    const { rows } = await query<{ n: number; maxlen: number }>(
      `SELECT count(*)::int n, max(length(content))::int maxlen FROM vault_chunks`,
    );
    expect(rows[0]!.n).toBe(stats.chunksWritten);
    expect(rows[0]!.maxlen).toBeLessThanOrEqual(700);
  });

  it('renumbers chunk_index contiguously after a split', async () => {
    await addFile('dense.md', 'Dense', 'sourdough starter bread. '.repeat(200));
    await embedVault({ provider: ceilingProvider(700), maxChunkTokens: 400, overlapTokens: 20, batchSize: 8 });
    const { rows } = await query<{ chunk_index: number }>(
      `SELECT chunk_index FROM vault_chunks ORDER BY chunk_index`,
    );
    expect(rows.map((r) => r.chunk_index)).toEqual(rows.map((_, i) => i));
  });

  it('still fails loudly on an error that is not about length', async () => {
    await addFile('a.md', 'A', 'sourdough starter');
    const provider = {
      id: 'together' as const,
      model: 'fake-test-model',
      dimensions: 1024,
      embed: () => Promise.reject(new ProviderError(401, 'unauthorized', false)),
    };
    await expect(
      embedVault({ provider, maxChunkTokens: 400, overlapTokens: 20, batchSize: 8 }),
    ).rejects.toThrow(/unauthorized/);
  });
});
