import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import * as dispatchStore from '../src/addons/dispatch/store.js';
import { query, withTransaction } from '../src/db.js';
import * as usageStore from '../src/usage/store.js';
import { ALL_MODULES, truncateAll } from './helpers.js';

const hosts = ['dispatcher-a', 'executor-b', 'migration-a', 'migration-b'];
const now = new Date();

async function addHost(slug: string, kind: 'server' | 'pi' = 'pi'): Promise<void> {
  await query(`INSERT INTO usage_hosts (slug, display, kind) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [slug, slug, kind]);
}

beforeEach(async () => {
  await truncateAll();
  await query(`DELETE FROM usage_hosts WHERE slug = ANY($1)`, [hosts]);
});

afterAll(async () => {
  await truncateAll();
  await query(`DELETE FROM usage_hosts WHERE slug = ANY($1)`, [hosts]);
});

describe('Codex dispatcher usage recording', () => {
  it('records the configured execution host, or the dispatcher server host when unset', async () => {
    await addHost('dispatcher-a', 'server');
    await addHost('executor-b');
    const base = {
      sessionId: '11111111-1111-4111-8111-111111111111', agent: 'builder', model: 'example-model', card: 'card-a',
      startedAt: new Date(now.getTime() - 120_000), endedAt: now, state: 'done', text: 'ok', inputTokens: 10,
      outputTokens: 5, wakeupIds: [],
    };

    await dispatchStore.recordCodexRun({ ...base, runId: 'configured-run', codexHost: 'executor-b' });
    await dispatchStore.recordCodexRun({ ...base, runId: 'default-run', sessionId: '22222222-2222-4222-8222-222222222222',
      startedAt: new Date(now.getTime() - 60_000), codexHost: null });

    expect((await query(`SELECT host, run_id FROM usage_runs WHERE run_id IN ('configured-run', 'default-run') ORDER BY run_id`)).rows)
      .toEqual([{ host: 'executor-b', run_id: 'configured-run' }, { host: 'dispatcher-a', run_id: 'default-run' }]);
    expect((await query(`SELECT host, call_id FROM usage_calls WHERE call_id IN ('configured-run', 'default-run') ORDER BY call_id`)).rows)
      .toEqual([{ host: 'executor-b', call_id: 'configured-run' }, { host: 'dispatcher-a', call_id: 'default-run' }]);
    expect(await dispatchStore.lastCodexSession('builder', 'card-a')).toBe('22222222-2222-4222-8222-222222222222');
    await expect(dispatchStore.recordCodexRun({ ...base, runId: 'bad-run', codexHost: 'missing-host' }))
      .rejects.toThrow('ORG_CODEX_HOST "missing-host" is not registered in usage_hosts');
  });

  it('replaces a summary with attached native calls, counts tokens once, and keeps a fallback without calls', async () => {
    await addHost('executor-b');
    const base = {
      codexHost: 'executor-b', agent: 'builder', model: 'example-model', card: null,
      startedAt: new Date(now.getTime() - 60_000), endedAt: now, state: 'done', text: 'ok', inputTokens: 20,
      wakeupIds: [],
    };
    await dispatchStore.recordCodexRun({ ...base, runId: 'native-run', sessionId: 'native-session', outputTokens: 100 });
    await dispatchStore.recordCodexRun({ ...base, runId: 'fallback-run', sessionId: 'fallback-session', outputTokens: 25 });
    await query(`INSERT INTO usage_calls
      (source, host, call_id, session_external_id, ts, model, entrypoint, input_tokens, output_tokens)
      VALUES ('codex','executor-b','native-1','native-session',$1,'example-model','exec',8,40),
             ('codex','executor-b','native-2','native-session',$1,'example-model','exec',12,60)`, [now]);

    expect(await withTransaction((tx) => usageStore.attachCallsToRuns(tx, 'executor-b'))).toBe(2);

    expect((await query(`SELECT call_id, run_id, output_tokens::int AS output FROM usage_calls ORDER BY call_id`)).rows)
      .toEqual([
        { call_id: 'fallback-run', run_id: 'fallback-run', output: 25 },
        { call_id: 'native-1', run_id: 'native-run', output: 40 },
        { call_id: 'native-2', run_id: 'native-run', output: 60 },
      ]);
    expect(await dispatchStore.tokensToday('UTC')).toBe(165);

    const from = new Date(now.getTime() - 86_400_000).toISOString();
    const to = new Date(now.getTime() + 86_400_000).toISOString();
    const response = await request(createApp({ modules: ALL_MODULES })).get('/api/usage/runs').query({ from, to }).expect(200);
    const outputs = new Map(response.body.runs.map((run: { run_id: string; output: number }) => [run.run_id, Number(run.output)]));
    expect(outputs.get('native-run')).toBe(100);
    expect(outputs.get('fallback-run')).toBe(25);
  });
});

describe('Codex host repair migration', () => {
  it('moves a mis-hosted run, attaches native calls, removes its summary, and is idempotent', async () => {
    await addHost('migration-a');
    await addHost('migration-b');
    await query(`INSERT INTO archive_sessions (source, host, external_id, started_at, ended_at)
      VALUES ('codex', 'migration-b', 'migrated-session', $1::timestamptz - interval '1 minute', $1::timestamptz + interval '1 minute'),
             ('codex', 'migration-b', 'fallback-session', $1::timestamptz - interval '1 minute', $1::timestamptz + interval '1 minute')`, [now]);
    await query(`INSERT INTO usage_runs
      (host, run_id, session_id, log_path, runtime, started_at, ended_at)
      VALUES ('migration-a', 'migrated-run', 'migrated-session', 'dispatch:migrated-run', 'codex', $1::timestamptz - interval '1 minute', $1::timestamptz + interval '1 minute'),
             ('migration-a', 'fallback-migration', 'fallback-session', 'dispatch:fallback-migration', 'codex', $1::timestamptz - interval '1 minute', $1::timestamptz + interval '1 minute')`, [now]);
    await query(`INSERT INTO usage_calls
      (source, host, call_id, session_external_id, ts, model, entrypoint, output_tokens, run_id)
      VALUES ('codex','migration-a','migrated-run','migrated-session',$1,'example-model','sdk-cli',70,'migrated-run'),
             ('codex','migration-b','native-migrated','migrated-session',$1,'example-model','exec',70,NULL),
             ('codex','migration-a','fallback-migration','fallback-session',$1,'example-model','sdk-cli',15,'fallback-migration')`, [now]);

    const sql = readFileSync(join(import.meta.dirname, '..', '..', 'db', 'migrations', '1756000018400_codex-run-hosts.sql'), 'utf8');
    const up = sql.split('-- Down Migration')[0]!;
    await query(up);
    const afterFirst = await query(`SELECT r.host, c.call_id, c.host AS call_host, c.run_id
      FROM usage_runs r JOIN usage_calls c ON c.run_id = r.run_id
      WHERE r.run_id = 'migrated-run' ORDER BY c.call_id`);
    await query(up);

    expect(afterFirst.rows).toEqual([{ host: 'migration-b', call_id: 'native-migrated', call_host: 'migration-b', run_id: 'migrated-run' }]);
    expect((await query(`SELECT host, run_id FROM usage_runs WHERE run_id = 'migrated-run'`)).rows).toEqual([
      { host: 'migration-b', run_id: 'migrated-run' },
    ]);
    expect((await query(`SELECT call_id FROM usage_calls WHERE call_id = 'migrated-run'`)).rows).toEqual([]);
    expect((await query(`SELECT host, run_id FROM usage_calls WHERE call_id = 'fallback-migration'`)).rows).toEqual([
      { host: 'migration-b', run_id: 'fallback-migration' },
    ]);
  });
});
