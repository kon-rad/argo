import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ConnectorDef } from '../src/addons/warehouse/connectors.js';
import { runConnector, runDue } from '../src/addons/warehouse/runner.js';
import { query } from '../src/db.js';
import { encryptToken } from '../src/social/crypto.js';
import { resetDataSchema } from './warehouse-helpers.js';

let root: string;
const rawRoot = () => join(root, 'raw');

beforeEach(async () => {
  await resetDataSchema();
  await query(`CREATE TABLE data.things (id text PRIMARY KEY, n int, label text, meta jsonb)`);
  await query(`CREATE TABLE data.nokey (id text)`);
  root = mkdtempSync(join(tmpdir(), 'data-run-'));
});

/** A connector whose script is the given JavaScript, run with node. */
function connector(name: string, script: string, extra: Partial<ConnectorDef> = {}): ConnectorDef {
  const dir = join(root, 'connectors', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.mjs'), script);
  const def = { name, description: '', command: [process.execPath, 'run.mjs'], timeoutSec: 30, tables: ['things', 'nokey'], env: [], secrets: {}, config: {}, enabled: true, dir, ...extra };
  writeFileSync(join(dir, 'connector.json'), JSON.stringify({ ...def, dir: undefined }));
  return def;
}
const out = (o: unknown) => `console.log(${JSON.stringify(JSON.stringify(o))});`;
const things = async () => (await query('SELECT id, n, label, meta FROM data.things ORDER BY id')).rows;

describe('runConnector', () => {
  it('upserts declared rows and leaves unspecified columns alone', async () => {
    const c = connector('c1', out({ table: 'things', row: { id: 'a', n: 1, label: 'first', meta: { k: [1] } } }) + out({ table: 'things', row: { id: 'b', n: 2 } }));
    const r = await runConnector(c, { rawRoot: rawRoot() });
    expect(r).toMatchObject({ status: 'ok', rows: { things: 2 } });
    writeFileSync(join(c.dir, 'run.mjs'), out({ table: 'things', row: { id: 'a', n: 5 } }));
    await runConnector(c, { rawRoot: rawRoot() });
    expect(await things()).toEqual([
      { id: 'a', n: 5, label: 'first', meta: { k: [1] } },
      { id: 'b', n: 2, label: null, meta: null },
    ]);
  });

  it('hands the saved state and config to the next run', async () => {
    const c = connector('c2', `
      const prev = JSON.parse(process.env.DATA_STATE);
      const cfg = JSON.parse(process.env.DATA_CONFIG);
      ${out({ log: 'hi' })}
      console.log(JSON.stringify({ table: 'things', row: { id: 'run' + ((prev.count ?? 0) + 1), label: cfg.who } }));
      console.log(JSON.stringify({ state: { count: (prev.count ?? 0) + 1 } }));
    `, { config: { who: 'cfg' } });
    await runConnector(c, { rawRoot: rawRoot() });
    await runConnector(c, { rawRoot: rawRoot() });
    expect((await things()).map((t) => [t.id, t.label])).toEqual([['run1', 'cfg'], ['run2', 'cfg']]);
  });

  it('fails on a table it did not declare', async () => {
    const c = connector('c3', out({ table: 'vault_files', row: { id: 'x' } }));
    const r = await runConnector(c, { rawRoot: rawRoot() });
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/"vault_files" is not in this connector's tables/);
  });

  it('fails on an unknown column, naming it', async () => {
    const r = await runConnector(connector('c4', out({ table: 'things', row: { id: 'x', bogus: 1 } })), { rawRoot: rawRoot() });
    expect(r.error).toMatch(/no column "bogus"/);
  });

  it('fails on a table without a primary key', async () => {
    const r = await runConnector(connector('c5', out({ table: 'nokey', row: { id: 'x' } })), { rawRoot: rawRoot() });
    expect(r.error).toMatch(/no primary key/);
  });

  it('fails with the stderr tail on a non-zero exit, redacting env secrets', async () => {
    const c = connector('c6', `console.error('boom with ' + process.env.MY_TOKEN); process.exit(3);`, { env: ['MY_TOKEN'] });
    const r = await runConnector(c, { rawRoot: rawRoot(), env: { ...process.env, MY_TOKEN: 'supersecretvalue' } });
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/exited 3: boom with \[redacted\]/);
    const run = (await query('SELECT status, error FROM ingest_runs WHERE id = $1', [r.runId])).rows[0];
    expect(run).toEqual({ status: 'failed', error: r.error });
  });

  it('kills a connector that runs past its timeout', async () => {
    const r = await runConnector(connector('c7', `setTimeout(() => {}, 60000);`, { timeoutSec: 1 }), { rawRoot: rawRoot() });
    expect(r.error).toMatch(/timed out after 1s/);
  }, 15000);
});

describe('secrets', () => {
  const KEY = 'ab'.repeat(32);
  it('fills a social-token secret into the env and redacts it from errors', async () => {
    await query(`DELETE FROM social_metric_tokens`);
    await query(`INSERT INTO social_metric_tokens (platform, account, access_token, token_kind, asset_id) VALUES ('instagram', 'someone', $1, 'facebook-system-user', '1784')`, [encryptToken('the-stored-token-value', KEY)]);
    const c = connector('s1', `console.error('saw ' + process.env.IG_TOKEN); process.exit(1);`, { secrets: { IG_TOKEN: 'social-token:instagram:someone' } } as Partial<ConnectorDef>);
    const r = await runConnector(c, { rawRoot: rawRoot(), encKey: KEY });
    expect(r.error).toBe('exited 1: saw [redacted]');
  });

  it('fails naming the secret when no token is stored', async () => {
    await query(`DELETE FROM social_metric_tokens`);
    const c = connector('s2', out({ log: 'never runs' }), { secrets: { IG_TOKEN: 'social-token:instagram:nobody' } } as Partial<ConnectorDef>);
    const r = await runConnector(c, { rawRoot: rawRoot(), encKey: KEY });
    expect(r).toMatchObject({ status: 'failed', error: 'secret IG_TOKEN (social-token:instagram:nobody): no stored token for that account' });
  });
});

describe('runDue', () => {
  it('runs only enabled connectors that are due', async () => {
    connector('due', out({ table: 'things', row: { id: 'due' } }), { schedule: { every: '1d' } } as Partial<ConnectorDef>);
    connector('off', out({ table: 'things', row: { id: 'off' } }), { schedule: { every: '1d' }, enabled: false } as Partial<ConnectorDef>);
    connector('manual', out({ table: 'things', row: { id: 'manual' } }));
    const first = await runDue(root, { rawRoot: rawRoot() });
    expect(first.map((r) => r.connector)).toEqual(['due']);
    expect(await runDue(root, { rawRoot: rawRoot() })).toEqual([]);
  });
});
