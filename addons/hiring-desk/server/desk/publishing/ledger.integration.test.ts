import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgPublicationLedger } from './ledger.js';

const testUrl = process.env.DESK_PUBLICATION_TEST_DATABASE_URL;
const suite = testUrl ? describe : describe.skip;
suite('durable publication checkpoints on disposable remote PostgreSQL', () => {
  let pool: Pool;
  const ledger = (connection: Pool) => new PgPublicationLedger((sql, params) => connection.query(sql, params ? [...params] : undefined));
  const binding = { artifactHash: `sha256:${'a'.repeat(64)}`, mediaType: 'text/markdown', publicDestination: 'swarm:public' };
  const reserve = (id = 'release-1', claimRef = 'arkiv:1/claim-1') => ({ key: id, claimRef, binding });
  beforeAll(async () => {
    if (!/^\/sb_[a-z0-9_]+_test$/.test(new URL(testUrl!).pathname)) throw new Error('Disposable sb_*_test database required');
    pool = new Pool({ connectionString: testUrl });
    const migration = await readFile(new URL('../../../migrations/1756000017100_desk-publications.sql', import.meta.url), 'utf8');
    await pool.query(migration.split('-- Down Migration')[0]!);
  });
  afterAll(async () => { await pool?.end(); });

  it('serializes competing reservations, rejects changed terms and survives a separate connection', async () => {
    const db = ledger(pool);
    const results = await Promise.all([db.reserve(reserve()), db.reserve(reserve())]);
    expect(results.map(r => r.kind).sort()).toEqual(['existing', 'reserved']);
    expect((await db.reserve({ ...reserve(), binding: { ...binding, artifactHash: `sha256:${'b'.repeat(64)}` } })).kind).toBe('conflict');
    expect((await db.reserve({ ...reserve(), binding: { ...binding, publicDestination: 'other' } })).kind).toBe('conflict');
    expect((await db.reserve(reserve('release-1', 'arkiv:1/claim-2'))).kind).toBe('conflict');
    const other = new Pool({ connectionString: testUrl });
    try { expect((await ledger(other).get('release-1'))?.binding).toEqual(binding); }
    finally { await other.end(); }
  });

  it('checkpoints only one concurrent public reference and one immutable delivery', async () => {
    const db = ledger(pool); await db.reserve(reserve('release-race'));
    const refs = ['1'.repeat(64), '2'.repeat(64)];
    const results = await Promise.allSettled(refs.map(ref => db.recordUpload('release-race', ref)));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const uploaded = (await db.get('release-race'))!;
    expect(uploaded.status).toBe('uploaded');
    expect((await db.recordUpload('release-race', uploaded.publicRef!)).publicRef).toBe(uploaded.publicRef);
    expect((await db.recordDelivery('release-race', 'arkiv:1/delivery-1')).status).toBe('delivered');
    expect((await db.recordDelivery('release-race', 'arkiv:1/delivery-1')).deliveryRef).toBe('arkiv:1/delivery-1');
    await expect(db.recordDelivery('release-race', 'arkiv:1/different')).rejects.toThrow('conflicts');
    expect((await db.recordUpload('release-race', uploaded.publicRef!)).status).toBe('delivered');
  });

  it('rejects delivery before upload, reference reuse and malformed inputs', async () => {
    const db = ledger(pool); await db.reserve(reserve('release-early'));
    await expect(db.recordDelivery('release-early', 'arkiv:1/early')).rejects.toThrow('upload');
    await expect(db.recordUpload('missing', '3'.repeat(64))).rejects.toThrow('missing');
    await expect(db.recordUpload('release-early', 'swarm://secret')).rejects.toThrow('Invalid');
    await db.recordUpload('release-early', '3'.repeat(64));
    await expect(db.recordDelivery('release-early', 'arkiv:1/delivery-1')).rejects.toThrow();
    await expect(db.reserve({ ...reserve(), key: '' })).rejects.toThrow('Invalid');
    await expect(db.reserve({ ...reserve(), binding: { ...binding, mediaType: 'video/mp4' } })).rejects.toThrow('Invalid');
  });
});
