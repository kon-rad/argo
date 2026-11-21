import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CybazaarIntegration } from './cybazaar-integration.js';

type Database = ConstructorParameters<typeof CybazaarIntegration>[0]['database'];

describe.skipIf(!process.env.SB_TEST_DB)('Cybazaar revision cycle on scratch PostgreSQL', () => {
  let pool: Pool;
  let created = false;
  const schema = 'cyba_sync_test_' + randomUUID().replaceAll('-', '');
  beforeAll(async () => {
    const database = process.env.SB_TEST_DB!;
    if (!/^sb_[a-z0-9_]+_test$/.test(database)) throw new Error('An isolated sb_*_test database is required');
    const host = process.env.PGHOST ?? '127.0.0.1';
    if (!['localhost', '127.0.0.1', '::1'].includes(host) && !host.startsWith('/')) throw new Error('A local scratch PostgreSQL server is required');
    pool = new Pool({ host, database, options: `-c search_path=${schema},public` });
    await pool.query(`CREATE SCHEMA ${schema}`);
    created = true;
    await pool.query(await readFile(new URL('../../../../app/db/migrations/1756000020700_cybazaar_marketplace_sync.sql', import.meta.url), 'utf8'));
  });
  afterAll(async () => {
    if (!pool) return;
    try { if (created) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await pool.end(); }
  });

  it('persists distinct revision events and retries an uncertain delivery with the same key', async () => {
    const id = randomUUID();
    await pool.query(`INSERT INTO desk_cybazaar_requests(request_id,listing_id,title,description,listing_snapshot,requester_wallet,marketplace_status,local_status,marketplace_updated_at)
      VALUES($1,$2,'Fixture','Public brief','{}','fixture-wallet','accepted','accepted',now())`, [id, randomUUID()]);
    const database: Database = {
      query: (sql, params) => pool.query(sql, params ? [...params] : undefined),
      async transact(fn) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await fn((sql, params) => client.query(sql, params ? [...params] : undefined));
          await client.query('COMMIT');
          return result;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
      },
    };
    const applied = new Map<string, string>(), attempts: string[] = [];
    let loseResponse = false;
    const service = () => new CybazaarIntegration({ origin: 'https://market.example.com', secret: 'test-secret-'.repeat(4), database,
      board: { get: vi.fn(), create: vi.fn(), assign: vi.fn(), move: vi.fn() },
      fetcher: vi.fn(async (_url, init) => {
        const event = JSON.parse(String(init?.body));
        attempts.push(event.idempotencyKey);
        applied.set(event.idempotencyKey, event.status);
        if (loseResponse) throw new Error('Response lost after remote commit');
        return Response.json({});
      }) as typeof fetch,
    });
    const cycle = ['in_progress', 'revision_requested', 'in_progress'] as const;
    for (const status of cycle) expect(await service().transition(id, status)).toBe(true);
    expect([...applied.values()]).toEqual(cycle);
    loseResponse = true;
    expect(await service().transition(id, 'completed')).toBe(false);
    const savedKey = attempts.at(-1);
    loseResponse = false;
    expect(await service().transition(id, 'completed')).toBe(true);
    expect(attempts.at(-1)).toBe(savedKey);
    expect(applied.size).toBe(4);
    const rows = (await pool.query('SELECT status,idempotency_key,delivered_at FROM desk_cybazaar_outbox ORDER BY id')).rows;
    expect(rows.map(row => row.status)).toEqual([...cycle, 'completed']);
    expect(new Set(rows.map(row => row.idempotency_key)).size).toBe(4);
    expect(rows.every(row => row.delivered_at)).toBe(true);
  });
});
