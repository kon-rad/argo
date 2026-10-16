import pg from 'pg';
import { config } from './config.js';

// Postgres returns bigint (int8) as a string to preserve precision. Every
// bigint column here (size_bytes) fits a JS number comfortably, and the API
// contract says number, so parse it rather than leaking strings to JSON.
pg.types.setTypeParser(pg.types.builtins.INT8, (v: string) => Number(v));

export let pool = new pg.Pool({ connectionString: config.databaseUrl, max: 8 });

/**
 * Connects everything that follows to another database URL. cli-org calls it
 * before its first query when it runs as an agent (SB_ORG_DB_URL, the
 * row-level-security role); nothing else should. The previous pool is closed.
 */
export function setDatabaseUrl(url: string): void {
  const old = pool;
  pool = new pg.Pool({ connectionString: url, max: 4 });
  void old.end().catch(() => {});
}

/**
 * Write instrumentation. The spec requires that a re-scan with no changes
 * issues ZERO writes to the vault tables; counting them here is what makes
 * that assertion possible instead of aspirational.
 */
export const dbStats: { queries: number; writesByTable: Record<string, number> } = {
  queries: 0,
  writesByTable: {},
};

export function resetDbStats(): void {
  dbStats.queries = 0;
  dbStats.writesByTable = {};
}

const WRITE_RE = /^\s*(?:with\s+[\s\S]*?\)\s*)?(insert\s+into|update|delete\s+from)\s+"?([a-z_][a-z0-9_]*)"?/i;

function record(sql: string): void {
  dbStats.queries++;
  const m = WRITE_RE.exec(sql);
  if (!m) return;
  const table = m[2]!.toLowerCase();
  dbStats.writesByTable[table] = (dbStats.writesByTable[table] ?? 0) + 1;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<pg.QueryResult<T>> {
  record(sql);
  return pool.query<T>(sql, params as unknown[]);
}

/** Runs `fn` inside a transaction on a dedicated client. */
export async function withTransaction<T>(fn: (c: TxClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn({
      query: async (sql, params = []) => {
        record(sql);
        return client.query(sql, params as unknown[]);
      },
    });
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export interface TxClient {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<pg.QueryResult<T>>;
}
