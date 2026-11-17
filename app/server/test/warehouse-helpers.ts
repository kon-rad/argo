import { query } from '../src/db.js';

/** Empties schema `data` and the ledger between warehouse tests. */
export async function resetDataSchema(): Promise<void> {
  await query('DROP SCHEMA IF EXISTS data CASCADE');
  await query('CREATE SCHEMA data');
  await query('TRUNCATE data_migrations');
  await query(`DELETE FROM sources WHERE kind = 'warehouse-connector'`);
}
