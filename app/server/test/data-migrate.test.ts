import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { checkSql, migrate } from '../src/addons/data/migrate.js';
import { query } from '../src/db.js';
import { resetDataSchema } from './data-helpers.js';

let dir: string;
beforeEach(async () => {
  await resetDataSchema();
  dir = mkdtempSync(join(tmpdir(), 'data-mig-'));
});

const put = (name: string, sql: string) => writeFileSync(join(dir, name), sql);
const tables = async () =>
  (await query<{ t: string }>(`SELECT table_name t FROM information_schema.tables WHERE table_schema='data' ORDER BY 1`)).rows.map((r) => r.t);

describe('data migrate', () => {
  it('applies files in name order into schema data and records them', async () => {
    put('0002_b.sql', 'CREATE TABLE b (id int PRIMARY KEY, a_id int REFERENCES a(id));');
    put('0001_a.sql', 'CREATE TABLE a (id int PRIMARY KEY);');
    expect(await migrate(dir)).toEqual({ applied: ['0001_a.sql', '0002_b.sql'], pending: [] });
    expect(await tables()).toEqual(['a', 'b']);
    expect((await query('SELECT name FROM data_migrations ORDER BY name')).rows.map((r) => r.name)).toEqual(['0001_a.sql', '0002_b.sql']);
    expect((await migrate(dir)).applied).toEqual([]);
  });

  it('refuses an applied file that changed', async () => {
    put('0001_a.sql', 'CREATE TABLE a (id int PRIMARY KEY);');
    await migrate(dir);
    put('0001_a.sql', 'CREATE TABLE a (id bigint PRIMARY KEY);');
    await expect(migrate(dir)).rejects.toThrow(/changed after it was applied: 0001_a.sql/);
  });

  it('refuses a pending file that leaves schema data, before applying anything', async () => {
    put('0001_a.sql', 'CREATE TABLE a (id int PRIMARY KEY);');
    put('0002_bad.sql', 'DROP TABLE public.vault_files;');
    await expect(migrate(dir)).rejects.toThrow(/0002_bad.sql reaches outside schema data/);
    expect(await tables()).toEqual([]);
  });

  it('rolls back only the failing file', async () => {
    put('0001_a.sql', 'CREATE TABLE a (id int PRIMARY KEY);');
    put('0002_b.sql', 'CREATE TABLE b (id int PRIMARY KEY); SELECT nope FROM nowhere;');
    await expect(migrate(dir)).rejects.toThrow(/0002_b.sql failed/);
    expect(await tables()).toEqual(['a']);
  });

  it('dry run lists pending and applies nothing', async () => {
    put('0001_a.sql', 'CREATE TABLE a (id int PRIMARY KEY);');
    expect(await migrate(dir, { dryRun: true })).toEqual({ applied: [], pending: ['0001_a.sql'] });
    expect(await tables()).toEqual([]);
  });

  it('checkSql ignores comments and strings, catches other schemas', () => {
    expect(checkSql("-- copies from public.social_post_stats\nCREATE TABLE data.x (c text DEFAULT 'public.y');")).toBeNull();
    expect(checkSql('CREATE TABLE other.x (id int);')).toMatch(/other\.x/);
    expect(checkSql('GRANT SELECT ON x TO someone;')).toMatch(/GRANT/);
  });
});
