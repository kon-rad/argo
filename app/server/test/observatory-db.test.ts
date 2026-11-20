import { backfillObservatory } from '../src/archive/observatoryProjection.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db.js';
import { authorizeDetail, coverage, loadWindow, readSnapshot } from '../src/addons/observatory/service.js';
const host = 'fixture-observatory';
beforeEach(async () => {
  await query("INSERT INTO usage_hosts(slug,display,kind) VALUES($1,'Observatory fixture','server') ON CONFLICT DO NOTHING", [host]);
});
afterEach(async () => {
  await query('DELETE FROM usage_calls WHERE host=$1', [host]);
  await query('DELETE FROM usage_runs WHERE host=$1', [host]);
  await query('DELETE FROM archive_sessions WHERE host=$1', [host]);
  await query('DELETE FROM usage_hosts WHERE slug=$1', [host]);
});
describe('observatory scratch schema and join cardinalities', () => {
  it('does not multiply archive parts by two runs and two usage matches; retains source identity', async () => {
    const session = (await query(`INSERT INTO archive_sessions(source,host,external_id) VALUES('codex',$1,'shared') RETURNING id`, [host])).rows[0]!.id;
    await query(`INSERT INTO archive_sessions(source,host,external_id) VALUES('claude-code',$1,'shared')`, [host]);
    const raw = { harness: 'codex', type: 'response_item', payload: { type: 'function_call', call_id: 'tool-a', name: 'read', arguments: '{}' } };
    await query(`INSERT INTO archive_messages(session_id,seq,external_id,role,kind,ts,raw,raw_sha) VALUES($1,1,'message-a','assistant','response_item','2025-01-01T00:00:10Z',$2,'synthetic')`, [session, raw]);
    for (const run of ['one', 'two']) {
      await query(`INSERT INTO usage_runs(host,run_id,session_id,runtime,started_at,ended_at,log_path)
        VALUES($1,$2,'shared','codex','2025-01-01T00:00:00Z','2025-01-01T00:00:30Z','synthetic.jsonl')`, [host, run]);
      await query(`INSERT INTO usage_calls(source,host,call_id,session_external_id,message_external_id,ts,model)
        VALUES('codex',$1,$2,'shared','message-a','2025-01-01T00:00:10Z','test-model')`, [host, run]);
    }
    while (await backfillObservatory(100)) {}
    const range = { from: Date.parse('2025-01-01T00:00:05Z'), to: Date.parse('2025-01-01T00:01:00Z'), host };
    const data = await readSnapshot(db => loadWindow(db, range, new Set(['usage'])));
    expect(data.window.events.filter(e => e.kind === 'tool_call')).toHaveLength(1);
    expect(data.window.events.filter(e => e.kind === 'usage')).toHaveLength(2);
    expect(data.window.intervals).toHaveLength(2);
    expect(data.window.intervals.every(i => i.session === `archive:${session}`)).toBe(true);
    expect(data.window.events.find(e => e.kind === 'tool_call')!.execution).toBeNull();
    await readSnapshot(db => authorizeDetail(db, data.window.events[0]!, new Set(['usage'])));
    const measured = await readSnapshot(db => coverage(db, range, new Set(['usage'])));
    expect(measured.sources.find(s => s.source === 'usage_calls')?.groups?.[0]?.records).toBe(2);
  });
  it('executes prior-card boundary query against the migrated schema without reading current cards', async () => {
    const data = await readSnapshot(db => loadWindow(db, { from: 0, to: 1000 }, new Set(['board', 'org'])));
    expect(data.window.intervals).toEqual([]);
    expect(data.diagnostics.historicalCompleteness).toBe('unknown');
  });
});

it('captures org sender at insertion and never rewrites history from a changed roster', async () => {
  const { withTransaction } = await import('../src/db.js');
  // Roll back all synthetic org rows, even if an assertion fails.
  const rollback = new Error('fixture rollback');
  try {
    await withTransaction(async db => {
      await db.query("INSERT INTO org_agents(name,runtime,role,org_version) VALUES('fixture-human','human','fixture','fixture'),('fixture-agent','codex','fixture','fixture')");
      await db.query("INSERT INTO org_channels(slug,kind) VALUES('fixture-observatory','shared')");
      const insert = (author: string) => db.query("INSERT INTO org_messages(channel_slug,author,kind,body) VALUES('fixture-observatory',$1,'message','Synthetic') RETURNING id,author_kind", [author]);
      const human = (await insert('fixture-human')).rows[0]!;
      const agent = (await insert('fixture-agent')).rows[0]!;
      expect(human.author_kind).toBe('human'); expect(agent.author_kind).toBe('agent');
      await db.query("UPDATE org_agents SET runtime='codex' WHERE name='fixture-human'");
      await db.query("UPDATE org_messages SET author_kind='agent',body='Synthetic edit' WHERE id=$1", [human.id]);
      const historical = await db.query('SELECT author_kind FROM org_messages WHERE id=$1', [human.id]);
      expect(historical.rows[0]!.author_kind).toBe('human');
      expect((await insert('fixture-human')).rows[0]!.author_kind).toBe('agent');
      throw rollback;
    });
  } catch (error) { if (error !== rollback) throw error; }
});

it('seeks a tiny window after a >8 MiB prefix without transferring prefix bodies', async () => {
  const session = (await query(`INSERT INTO archive_sessions(source,host,external_id) VALUES('codex',$1,'long') RETURNING id`, [host])).rows[0]!.id;
  await query(`INSERT INTO archive_messages(session_id,seq,external_id,role,kind,ts,raw,raw_sha)
    SELECT $1,n,'prefix-'||n,'assistant','response_item','2025-01-01T00:00:00Z',
      jsonb_build_object('harness','codex','payload',jsonb_build_object('role','assistant','content',repeat('x',100000))), 'fake'
    FROM generate_series(1,90) n`, [session]);
  expect(Number((await query('SELECT sum(octet_length(raw::text)) AS bytes FROM archive_messages WHERE session_id=$1', [session])).rows[0]!.bytes)).toBeGreaterThan(8 * 1024 * 1024);
  const insert = async (seq: number, type: string, ts: string) => (await query(`INSERT INTO archive_messages(session_id,seq,external_id,role,kind,ts,raw,raw_sha)
    VALUES($1,$2,$2::text,'assistant','response_item',$3,$4,'fake') RETURNING id`,
    [session,seq,ts,{ harness: 'codex', payload: { type, call_id: 'pending', name: 'read', arguments: '{}' } }])).rows[0]!.id;
  const call = await insert(91,'function_call','2025-01-01T00:00:01Z');
  await insert(92,'function_call_output','2025-01-01T00:05:01Z');
  await expect(readSnapshot(db => loadWindow(db, { from: Date.parse('2025-01-01T00:05:00Z'), to: Date.parse('2025-01-01T00:05:02Z'), host }, new Set(['usage'])))).rejects.toHaveProperty('status', 503);
  while (await backfillObservatory(100)) {}
  const range = { from: Date.parse('2025-01-01T00:05:00Z'), to: Date.parse('2025-01-01T00:05:02Z'), host };
  const statements: string[] = [];
  const data = await readSnapshot(db => loadWindow({ query: async (sql, args) => {
    statements.push(sql);
    const result = await db.query(sql, args);
    if (sql.includes('WITH active AS MATERIALIZED')) {
      expect(result.rows).toHaveLength(2);
      expect(result.rows.every(row => row.raw === null)).toBe(true);
    }
    return result;
  } } as typeof db, range, new Set(['usage'])));
  expect(statements).toHaveLength(3);
  expect(data.window.events).toHaveLength(1);
  expect(data.window.events[0]!.parent).toBe(`archive_messages:${call}:${call}`);
  expect(data.window.boundary.tools[`archive_messages:${call}:${call}`]).toBe('pending');
  expect(JSON.stringify(data).length).toBeLessThan(10000);
  expect(await backfillObservatory(100)).toBe(0);
  await query("UPDATE archive_messages SET role='system' WHERE id=$1", [call]);
  await expect(readSnapshot(db => loadWindow(db, range, new Set(['usage'])))).rejects.toHaveProperty('status', 503);
  while (await backfillObservatory(100)) {}
  // A genuinely large selected source still hits the original guard after rebuilding.
  await query(`UPDATE archive_messages SET raw=jsonb_build_object('harness','codex','payload',jsonb_build_object('role','assistant','content',repeat('x',4200000))) WHERE session_id=$1 AND seq=92`, [session]);
  while (await backfillObservatory(100)) {}
  await expect(readSnapshot(db => loadWindow(db, range, new Set(['usage'])))).rejects.toHaveProperty('status', 413);
});
