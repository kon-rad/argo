import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { query } from '../src/db.js';
import { embedVault } from '../src/embeddings/embed.js';
import { fakeProvider } from './embedProvider.js';
import { truncateAll } from './helpers.js';

const app = createApp({ embeddingProvider: () => fakeProvider() });

beforeEach(async () => {
  await truncateAll();
  for (const [path, title, body] of [
    ['baking.md', 'Weekend Baking', '## Starter\n\nFeed the sourdough starter with flour before baking bread.'],
    ['pg.md', 'Postgres Notes', '## Indexes\n\nA postgres index makes a sql query fast.'],
  ] as [string, string, string][]) {
    await query(
      `INSERT INTO vault_files (path,parent_path,name,title,ext,is_markdown,size_bytes,mtime,content_hash,body)
       VALUES ($1,'',$2,$3,'.md',true,$4,now(),$5,$6)`,
      [path, path, title, body.length, `h-${path}`, body],
    );
  }
  await embedVault({ provider: fakeProvider(), maxChunkTokens: 200, overlapTokens: 20, batchSize: 8 });
});

describe('GET /api/search modes', () => {
  it('defaults to keyword so the existing contract is unchanged', async () => {
    const res = await request(app).get('/api/search').query({ q: 'sourdough' });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('keyword');
    expect(res.body.results[0].ref_path).toBe('baking.md');
  });

  it('serves semantic mode', async () => {
    const res = await request(app).get('/api/search').query({ q: 'dough oven flour', mode: 'semantic' });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('semantic');
    expect(res.body.results[0].ref_path).toBe('baking.md');
    expect(res.body.results[0].similarity).toBeGreaterThan(0);
    expect(res.body.results[0].match_kind).toBe('semantic');
  });

  it('serves hybrid mode', async () => {
    const res = await request(app).get('/api/search').query({ q: 'sourdough', mode: 'hybrid' });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('hybrid');
    expect(res.body.degraded).toBe(false);
    expect(res.body.results.some((r: { ref_path: string }) => r.ref_path === 'baking.md')).toBe(true);
  });

  it('rejects an unknown mode with 400', async () => {
    const res = await request(app).get('/api/search').query({ q: 'x', mode: 'telepathy' });
    expect(res.status).toBe(400);
  });

  it('reports 503, not 500, when semantic mode has no provider configured', async () => {
    const noProvider = createApp({
      embeddingProvider: () => {
        throw new Error('TOGETHER_API_KEY is not set');
      },
    });
    const res = await request(noProvider).get('/api/search').query({ q: 'x', mode: 'semantic' });
    expect(res.status).toBe(503);
    expect(res.body.error.message).toContain('TOGETHER_API_KEY');
  });

  it('still answers hybrid when the provider is broken, flagged as degraded', async () => {
    const broken = createApp({
      embeddingProvider: () => ({
        id: 'together' as const,
        model: 'fake-test-model',
        dimensions: 1024,
        embed: () => Promise.reject(new Error('network down')),
      }),
    });
    const res = await request(broken).get('/api/search').query({ q: 'postgres', mode: 'hybrid' });
    expect(res.status).toBe(200);
    expect(res.body.degraded).toBe(true);
    expect(res.body.results.length).toBeGreaterThan(0);
  });
});

describe('GET /api/system embedding coverage', () => {
  it('reports how much of the vault is embedded', async () => {
    const res = await request(app).get('/api/system');
    expect(res.status).toBe(200);
    expect(res.body.embeddings.chunks).toBeGreaterThan(0);
    expect(res.body.embeddings.files_embedded).toBe(2);
    expect(res.body.embeddings.files_embeddable).toBe(2);
    expect(res.body.embeddings.model).toBe('fake-test-model');
  });

  it('reports zero coverage without erroring when nothing is embedded', async () => {
    await query(`DELETE FROM vault_chunks`);
    const res = await request(app).get('/api/system');
    expect(res.body.embeddings.chunks).toBe(0);
    expect(res.body.embeddings.model).toBeNull();
  });
});
