import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PgCybaStore, type MarketDatabase, type MarketQuery } from './store.js';
/** Isolated scratch schema only; refuses production/retired local-master endpoints. */
export async function scratchMarketStore() {
    const url = new URL(process.env.CYBA_TEST_DB_URL!);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.pathname.startsWith('/sb_') || !url.pathname.endsWith('_test') || url.port === '5432')
        throw new Error('CYBA_TEST_DB_URL must name an isolated non-master scratch database');
    const schema = 'cyba_test_' + randomUUID().replaceAll('-', '');
    const admin = new pg.Pool({ connectionString: url.href });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({ connectionString: url.href, options: `-c search_path=${schema},public`, max: 8 });
    await pool.query(await readFile(new URL('../../../../app/db/migrations/1756000020500_cybazaar.sql', import.meta.url), 'utf8'));
    const database: MarketDatabase = { query: ((sql, params) => pool.query(sql, params as unknown[])) as MarketQuery, transact: async (fn) => { const client = await pool.connect(); try {
            await client.query('BEGIN');
            const value = await fn(((sql, params) => client.query(sql, params as unknown[])) as MarketQuery);
            await client.query('COMMIT');
            return value;
        }
        catch (e) {
            await client.query('ROLLBACK');
            throw e;
        }
        finally {
            client.release();
        } } };
    return { store: new PgCybaStore(database), database, pool, async close() { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); } };
}
