import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDeskPersistence, type AssignmentRecord } from './store.js';

const testUrl = process.env.DESK_TEST_DATABASE_URL;
const suite = testUrl ? describe : describe.skip;

suite('durable PostgreSQL desk receipts', () => {
  let pool: Pool;
  const assignment = (id: string): AssignmentRecord => ({ id, revision: 0, publicState: { stage: 'posted', jobRef: id, conflict: false, rejected: [] }, execution: 'awaiting_operator' });
  const store = (connection: Pool) => new PgDeskPersistence(async fn => {
    const client = await connection.connect();
    try {
      await client.query('BEGIN');
      const value = await fn((sql, params) => client.query(sql, params ? [...params] : undefined));
      await client.query('COMMIT');
      return value;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }, (sql, params) => connection.query(sql, params ? [...params] : undefined));

  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!/^\/sb_[a-z0-9_]+_test$/.test(url.pathname)) throw new Error('Dedicated sb_*_test database required');
    pool = new Pool({ connectionString: testUrl });
    await pool.query('DROP TABLE IF EXISTS desk_audit_events, desk_idempotency, desk_payment_allocations, desk_assignments CASCADE');
    // A dedicated empty database exercises the shipped migration, without the
    // unrelated vault vector-index migrations or any production connection.
    const migration = await readFile(new URL('../../../../../db/migrations/1756000017000_hiring-desk.sql', import.meta.url), 'utf8');
    await pool.query(migration.split('-- Down Migration')[0]!);
    await store(pool).seed(assignment('arkiv:1/job-a'));
    await store(pool).seed(assignment('arkiv:1/job-b'));
  });
  afterAll(async () => { await pool?.end(); });

  it('allows one competing assignment and preserves ownership through a new connection', async () => {
    const receiptId = `arc:5042002:0x${'ab'.repeat(32)}:7`;
    const db = store(pool);
    const winners = await Promise.all([
      db.reservePayment('arkiv:1/job-a', receiptId),
      db.reservePayment('arkiv:1/job-b', receiptId),
    ]);
    expect(winners.filter(Boolean)).toHaveLength(1);
    const owner = winners[0] ? 'arkiv:1/job-a' : 'arkiv:1/job-b';
    const other = winners[0] ? 'arkiv:1/job-b' : 'arkiv:1/job-a';
    const independent = new Pool({ connectionString: testUrl });
    try {
      expect(await store(independent).reservePayment(owner, receiptId)).toBe(true);
      expect(await store(independent).reservePayment(other, receiptId)).toBe(false);
      const rows = await independent.query('SELECT job_ref FROM desk_payment_allocations WHERE receipt_id=$1', [receiptId]);
      expect(rows.rows).toEqual([{ job_ref: owner }]);
    } finally { await independent.end(); }
  });
});
