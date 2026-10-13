import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { query } from '../src/db.js';
import { MAX_ROWS } from '../src/dbExplorer.js';
import { extractSql } from '../src/sqlgen.js';
import { truncateAll } from './helpers.js';

const asked: { question: string; schema: string }[] = [];
const app = createApp({
  sqlGenerator: () => async (question, schema) => {
    asked.push({ question, schema });
    return { sql: 'SELECT path FROM vault_files ORDER BY path', model: 'fake' };
  },
});

beforeEach(async () => {
  await truncateAll();
  asked.length = 0;
  for (const path of ['a.md', 'b.md']) {
    await query(
      `INSERT INTO vault_files (path,parent_path,name,title,ext,is_markdown,size_bytes,mtime,content_hash,body)
       VALUES ($1,'',$1,$1,'.md',true,1,now(),$1,'body')`,
      [path],
    );
  }
});

describe('GET /api/db/schema', () => {
  it('lists tables with columns, keys, notes and exact row counts', async () => {
    const res = await request(app).get('/api/db/schema');
    expect(res.status).toBe(200);
    const files = res.body.tables.find((t: { name: string }) => t.name === 'vault_files');
    expect(files.kind).toBe('table');
    expect(files.rows).toBe(2);
    expect(files.note).toMatch(/derived/);
    expect(files.columns.find((c: { name: string }) => c.name === 'id').pk).toBe(true);
    expect(files.columns.find((c: { name: string }) => c.name === 'tsv').generated).toBe(true);

    const chunks = res.body.tables.find((t: { name: string }) => t.name === 'vault_chunks');
    const fileId = chunks.columns.find((c: { name: string }) => c.name === 'file_id');
    expect(fileId.references).toEqual({ table: 'vault_files', column: 'id' });
    expect(chunks.columns.find((c: { name: string }) => c.name === 'embedding').type).toBe('vector(1024)');

    const view = res.body.tables.find((t: { name: string }) => t.name === 'search_documents');
    expect(view.kind).toBe('view');
    expect(view.rows).toBeNull();
  });
});

describe('POST /api/db/ask', () => {
  it('hands the model the question and the schema, and returns its SQL', async () => {
    const res = await request(app).post('/api/db/ask').send({ question: 'every file' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sql: 'SELECT path FROM vault_files ORDER BY path', model: 'fake' });
    expect(asked[0]!.question).toBe('every file');
    expect(asked[0]!.schema).toContain('table vault_files (2 rows)');
    expect(asked[0]!.schema).toContain('file_id integer -> vault_files.id NOT NULL');
  });

  it('answers 503 when no generator can be built', async () => {
    const bare = createApp({
      sqlGenerator: () => {
        throw new Error('no key');
      },
    });
    const res = await request(bare).post('/api/db/ask').send({ question: 'x' });
    expect(res.status).toBe(503);
    expect(res.body.error.message).toBe('no key');
  });

  it('rejects an empty question', async () => {
    const res = await request(app).post('/api/db/ask').send({ question: '  ' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/db/query', () => {
  const run = (sql: string) => request(app).post('/api/db/query').send({ sql });

  it('runs a SELECT and returns columns and array rows', async () => {
    const res = await run('SELECT path, size_bytes FROM vault_files ORDER BY path;');
    expect(res.status).toBe(200);
    expect(res.body.columns).toEqual(['path', 'size_bytes']);
    expect(res.body.rows).toEqual([['a.md', 1], ['b.md', 1]]);
    expect(res.body.truncated).toBe(false);
  });

  it('keeps duplicate column names from a join apart', async () => {
    const res = await run(
      `SELECT a.path, b.path FROM vault_files a JOIN vault_files b ON a.id = b.id ORDER BY 1`,
    );
    expect(res.status).toBe(200);
    expect(res.body.columns).toEqual(['path', 'path']);
    expect(res.body.rows[0]).toEqual(['a.md', 'a.md']);
  });

  it('accepts leading comments and a trailing comment', async () => {
    const res = await run('-- count them\nSELECT count(*)::int AS n FROM vault_files -- done');
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([[2]]);
  });

  it('refuses statements that are not queries', async () => {
    for (const sql of ['DELETE FROM vault_files', 'DROP TABLE vault_files', 'UPDATE vault_files SET title = 1']) {
      const res = await run(sql);
      expect(res.status, sql).toBe(400);
    }
    const { rows } = await query(`SELECT count(*)::int AS n FROM vault_files`);
    expect(rows[0]!.n).toBe(2);
  });

  it('cannot escape the read-only transaction with a second statement', async () => {
    const res = await run('SELECT 1; COMMIT; DELETE FROM vault_files');
    expect(res.status).toBe(400);
    const { rows } = await query(`SELECT count(*)::int AS n FROM vault_files`);
    expect(rows[0]!.n).toBe(2);
  });

  it('blocks a data-modifying CTE', async () => {
    const res = await run('WITH d AS (DELETE FROM vault_files RETURNING id) SELECT * FROM d');
    expect(res.status).toBe(400);
    const { rows } = await query(`SELECT count(*)::int AS n FROM vault_files`);
    expect(rows[0]!.n).toBe(2);
  });

  it('reports the Postgres error for bad SQL', async () => {
    const res = await run('SELECT nope FROM vault_files');
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/nope/);
  });

  it(`caps results at ${MAX_ROWS} rows and says so`, async () => {
    const res = await run(`SELECT g FROM generate_series(1, ${MAX_ROWS + 50}) g`);
    expect(res.status).toBe(200);
    expect(res.body.row_count).toBe(MAX_ROWS);
    expect(res.body.truncated).toBe(true);
  });

  it('truncates very long cells', async () => {
    const res = await run(`SELECT repeat('x', 5000) AS big`);
    expect(res.body.rows[0][0]).toMatch(/… \[3000 more chars\]$/);
  });
});

describe('extractSql', () => {
  it('strips fences and reasoning tags', () => {
    expect(extractSql('<think>hmm</think>\n```sql\nSELECT 1;\n```')).toBe('SELECT 1;');
    expect(extractSql('SELECT 2')).toBe('SELECT 2');
  });
});
