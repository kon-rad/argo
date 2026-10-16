import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const APP_ROOT = resolve(import.meta.dirname, '..', '..');
// SB_TEST_DB lets a session use its own scratch database (e.g. sb_inventory_test) and drop it after.
const TEST_DB = process.env.SB_TEST_DB ?? 'secondbrain_test';
if (!/^[a-z_][a-z0-9_]*_test$/.test(TEST_DB)) throw new Error(`SB_TEST_DB must be a lowercase name ending in _test, got "${TEST_DB}"`);
// PGHOST/PGPORT (also read by psql and createdb below) point the run at any server.
const TEST_URL = `postgres://${process.env.PGHOST ?? "localhost"}:${process.env.PGPORT ?? "5432"}/${TEST_DB}`;

function psql(db: string, sql: string): string {
  return execFileSync('psql', ['-tA', '-d', db, '-c', sql], { encoding: 'utf8' }).trim();
}

export default function setup(): void {
  process.env.DATABASE_URL = TEST_URL;

  const exists = psql('postgres', `SELECT 1 FROM pg_database WHERE datname='${TEST_DB}'`);
  if (!exists) {
    execFileSync('createdb', [TEST_DB], { stdio: 'inherit' });
  }

  // Rebuild from zero every run: migrations are the only source of schema truth.
  psql(TEST_DB, 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;');

  execFileSync(
    'npx',
    ['node-pg-migrate', '-m', 'db/migrations', '-j', 'sql', '--no-check-order', 'up'],
    { cwd: APP_ROOT, stdio: 'inherit', env: { ...process.env, DATABASE_URL: TEST_URL } },
  );

  // The org tests connect as sb_org with no password in the URL. On a server that
  // checks passwords (CI), give the role the run's PGPASSWORD, which pg sends.
  const pw = process.env.PGPASSWORD;
  if (pw) psql(TEST_DB, `ALTER ROLE sb_org PASSWORD '${pw.replace(/'/g, "''")}'`);
}
