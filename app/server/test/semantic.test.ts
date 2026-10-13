import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db.js';
import { embedVault } from '../src/embeddings/embed.js';
import { hybridSearch, queryText, semanticSearch } from '../src/semantic.js';
import { fakeProvider } from './embedProvider.js';
import { truncateAll } from './helpers.js';

const NOTES: [string, string, string][] = [
  ['baking.md', 'Weekend Baking', '## Starter\n\nFeed the sourdough starter with flour before baking bread in the oven.'],
  ['pg.md', 'Postgres Notes', '## Indexes\n\nA postgres index makes a sql query fast; the schema matters. The database plans it.'],
  ['music.md', 'Practice Log', '## Chords\n\nThe song needs one more chord; the melody carries the music.'],
  ['mixed.md', 'Mixed Bag', '## Both\n\nI baked bread while waiting for the postgres query to finish.'],
];

async function seed(): Promise<void> {
  for (const [path, title, body] of NOTES) {
    await query(
      `INSERT INTO vault_files (path,parent_path,name,title,ext,is_markdown,size_bytes,mtime,content_hash,body)
       VALUES ($1,'',$2,$3,'.md',true,$4,now(),$5,$6)`,
      [path, path, title, body.length, `h-${path}`, body],
    );
  }
  await embedVault({ provider: fakeProvider(), maxChunkTokens: 200, overlapTokens: 20, batchSize: 8 });
}

const provider = fakeProvider();
const opts = { provider, limit: 10, offset: 0 };

beforeEach(async () => {
  await truncateAll();
  await seed();
});

describe('semanticSearch', () => {
  it('ranks by meaning, not by the words the query used', async () => {
    // "dough" and "oven" never appear together in the query; the topical
    // vector is what has to do the work here.
    const { results } = await semanticSearch('dough oven flour', opts);
    expect(results[0]!.ref_path).toBe('baking.md');
  });

  it('finds the database note from vocabulary the note does not contain', async () => {
    const { results } = await semanticSearch('sql schema', opts);
    expect(results[0]!.ref_path).toBe('pg.md');
  });

  it('returns one row per file, not one per chunk', async () => {
    const { results } = await semanticSearch('bread baking sourdough', opts);
    const paths = results.map((r) => r.ref_path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('carries the similarity, the heading path and the chunk text', async () => {
    const { results } = await semanticSearch('sourdough bread', opts);
    const hit = results[0]!;
    expect(hit.similarity).toBeGreaterThan(0.5);
    expect(hit.similarity).toBeLessThanOrEqual(1);
    expect(hit.heading_path).toBe('Starter');
    expect(hit.snippet).toContain('sourdough');
    expect(hit.match_kind).toBe('semantic');
  });

  it('escapes HTML in the snippet', async () => {
    await query(
      `INSERT INTO vault_files (path,parent_path,name,title,ext,is_markdown,size_bytes,mtime,content_hash,body)
       VALUES ('xss.md','','xss.md','Bread XSS','.md',true,10,now(),'h-xss',$1)`,
      ['## Starter\n\nsourdough bread <script>alert(1)</script> baking'],
    );
    await embedVault({ provider: fakeProvider(), maxChunkTokens: 200, overlapTokens: 20, batchSize: 8 });
    const { results } = await semanticSearch('sourdough bread baking', opts);
    const hit = results.find((r) => r.ref_path === 'xss.md')!;
    expect(hit.snippet).not.toContain('<script>');
    expect(hit.snippet).toContain('&lt;script&gt;');
  });

  it('drops results below the similarity floor', async () => {
    const loose = await semanticSearch('sourdough bread', { ...opts, minSimilarity: 0 });
    const strict = await semanticSearch('sourdough bread', { ...opts, minSimilarity: 0.99 });
    expect(strict.results.length).toBeLessThan(loose.results.length);
  });

  it('pages without repeating a result', async () => {
    const first = await semanticSearch('bread postgres', { ...opts, limit: 2, offset: 0 });
    const second = await semanticSearch('bread postgres', { ...opts, limit: 2, offset: 2 });
    const overlap = first.results.filter((a) => second.results.some((b) => b.ref_path === a.ref_path));
    expect(overlap).toEqual([]);
    expect(first.total).toBe(second.total);
  });

  it('returns nothing for an empty query without calling the provider', async () => {
    const p = fakeProvider();
    const { results } = await semanticSearch('   ', { ...opts, provider: p });
    expect(results).toEqual([]);
    expect(p.calls).toBe(0);
  });

  it('returns an empty result, not a 500, when nothing is embedded', async () => {
    await query(`DELETE FROM vault_chunks`);
    const { results, total } = await semanticSearch('sourdough', opts);
    expect(results).toEqual([]);
    expect(total).toBe(0);
  });
});

describe('hybridSearch', () => {
  it('surfaces a note that only the keyword branch can find', async () => {
    // "Mixed Bag" is the exact title; lexically unmissable, topically muddy.
    const { results } = await hybridSearch('Mixed Bag', opts);
    expect(results.some((r) => r.ref_path === 'mixed.md')).toBe(true);
  });

  it('surfaces a note that only the vector branch can find', async () => {
    const { results } = await hybridSearch('dough oven flour', opts);
    expect(results.some((r) => r.ref_path === 'baking.md')).toBe(true);
  });

  it('ranks a note found by BOTH branches above one found by only one', async () => {
    // Only baking.md contains the literal word "sourdough", so it is the sole
    // keyword hit; mixed.md ("I baked bread...") reaches the vector branch on
    // topic alone. Appearing twice has to beat appearing once.
    const { results } = await hybridSearch('sourdough', opts);
    const paths = results.map((r) => r.ref_path);
    expect(paths.indexOf('baking.md')).toBeLessThan(paths.indexOf('mixed.md'));
    expect(results.find((r) => r.ref_path === 'baking.md')!.match_kind).toBe('hybrid');
    expect(results.find((r) => r.ref_path === 'mixed.md')!.match_kind).toBe('semantic');
  });

  it('gives two branches that disagree the same fused score', async () => {
    // Both notes match "postgres query" lexically and topically; the branches
    // order them oppositely. RRF is supposed to call that a tie rather than
    // let whichever branch ran first decide.
    const { results } = await hybridSearch('postgres query', opts);
    const pg = results.find((r) => r.ref_path === 'pg.md')!;
    const mixed = results.find((r) => r.ref_path === 'mixed.md')!;
    expect(pg.rank).toBeCloseTo(mixed.rank, 10);
    expect(pg.match_kind).toBe('hybrid');
  });

  it('never returns the same file twice', async () => {
    const { results } = await hybridSearch('bread postgres query', opts);
    const paths = results.map((r) => r.ref_path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('degrades to keyword-only when the provider is unavailable', async () => {
    const broken = {
      id: 'together' as const,
      model: 'fake-test-model',
      dimensions: 1024,
      embed: () => Promise.reject(new Error('network down')),
    };
    const { results, degraded } = await hybridSearch('postgres', { ...opts, provider: broken });
    expect(degraded).toBe(true);
    expect(results.some((r) => r.ref_path === 'pg.md')).toBe(true);
  });
});

describe('queryText', () => {
  it('wraps an e5-instruct query in the Instruct/Query pair', () => {
    const out = queryText('sourdough', 'intfloat/multilingual-e5-large-instruct');
    expect(out).toMatch(/^Instruct: .+\nQuery: sourdough$/);
  });

  it('uses the bare marker for a plain e5 model', () => {
    expect(queryText('sourdough', 'intfloat/e5-large-v2')).toBe('query: sourdough');
  });

  it('uses the sentence-representation instruction for bge', () => {
    expect(queryText('sourdough', 'BAAI/bge-large-en-v1.5')).toBe(
      'Represent this sentence for searching relevant passages: sourdough',
    );
  });

  it('leaves an unrecognised model untouched', () => {
    expect(queryText('sourdough', 'some/symmetric-encoder')).toBe('sourdough');
  });
});
