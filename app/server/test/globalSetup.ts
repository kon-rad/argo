import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const APP_ROOT = resolve(import.meta.dirname, '..', '..');
const TEST_DB = 'secondbrain_test';
const TEST_URL = `postgres://localhost:5432/${TEST_DB}`;

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
}
