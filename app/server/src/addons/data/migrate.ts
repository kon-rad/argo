import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool, query } from '../../db.js';

/**
 * The vault's own migrations (docs/data.md#tables). Files `<data.dir>/migrations/*.sql`
 * run in name order, each in its own transaction with search_path set to schema
 * `data`, and are recorded in `data_migrations` with a checksum. An applied file
 * that changes is refused: schema history only moves forward, in new files.
 */

export interface VaultMigration {
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrateResult {
  applied: string[];
  pending: string[];
}

const NAME = /^\d{4}_[a-z0-9][a-z0-9_-]*\.sql$/;

/**
 * A guard against mistakes, not a security boundary: vault migrations create and
 * change tables in schema `data` and nothing else.
 */
const FORBIDDEN: { re: RegExp; what: string }[] = [
  { re: /\bpublic\s*\./i, what: 'public.' },
  { re: /\bpg_catalog\s*\./i, what: 'pg_catalog.' },
  { re: /\binformation_schema\s*\./i, what: 'information_schema.' },
  { re: /\b(create|drop|alter)\s+schema\b/i, what: 'CREATE/ALTER/DROP SCHEMA' },
  { re: /\b(create|alter|drop)\s+(role|user)\b/i, what: 'roles' },
  { re: /\b(grant|revoke)\b/i, what: 'GRANT/REVOKE' },
  { re: /\bset\s+(session\s+)?(search_path|role)\b/i, what: 'SET search_path/role' },
  { re: /\bcreate\s+extension\b/i, what: 'CREATE EXTENSION' },
];

/** Strips comments and string literals so a caption like 'public.' in a comment doesn't trip the guard. */
function codeOnly(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
}

/** The guard's error for a file, or null when it only touches schema `data`. */
export function checkSql(sql: string): string | null {
  const code = codeOnly(sql);
  for (const f of FORBIDDEN) if (f.re.test(code)) return `reaches outside schema data (${f.what})`;
  // Any other schema-qualified name: `other.table`. `data.x` is fine; so are column refs like `t.col`
  // inside queries, so only DDL targets are checked.
  const ddl = /\b(?:create|alter|drop)\s+(?:unique\s+)?(?:table|index|view|materialized\s+view|sequence|type|function)\s+(?:if\s+(?:not\s+)?exists\s+)?(?:\w+\s+on\s+)?([a-z_][\w]*)\.([a-z_][\w]*)/gi;
  for (const m of code.matchAll(ddl)) {
    if (m[1]!.toLowerCase() !== 'data') return `reaches outside schema data (${m[1]}.${m[2]})`;
  }
  return null;
}

export function listMigrations(dir: string): VaultMigration[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => {
      if (!NAME.test(name)) throw new Error(`bad migration file name: ${name} (want NNNN_slug.sql)`);
      const sql = readFileSync(join(dir, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

export async function migrate(dir: string, opts: { dryRun?: boolean } = {}): Promise<MigrateResult> {
  const files = listMigrations(dir);
  const { rows } = await query<{ name: string; checksum: string }>('SELECT name, checksum FROM data_migrations');
  const done = new Map(rows.map((r) => [r.name, r.checksum]));

  for (const f of files) {
    const prev = done.get(f.name);
    if (prev && prev !== f.checksum) throw new Error(`changed after it was applied: ${f.name}. Write a new migration instead`);
  }
  const pending = files.filter((f) => !done.has(f.name));
  // Check every pending file before running any, so one bad file applies nothing.
  for (const f of pending) {
    const err = checkSql(f.sql);
    if (err) throw new Error(`${f.name} ${err}`);
  }
  if (opts.dryRun) return { applied: [], pending: pending.map((f) => f.name) };

  const applied: string[] = [];
  for (const f of pending) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL search_path = data');
      await client.query(f.sql);
      await client.query('INSERT INTO public.data_migrations (name, checksum) VALUES ($1, $2)', [f.name, f.checksum]);
      await client.query('COMMIT');
      applied.push(f.name);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`${f.name} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  return { applied, pending: [] };
}
