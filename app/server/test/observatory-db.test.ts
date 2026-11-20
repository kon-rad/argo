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

import { readFileSync } from 'node:fs';
import { withTransaction } from '../src/db.js';
import { replay } from '@secondbrain/contracts/observatory';
import type { ParsedMessage } from '../src/archive/types.js';
import { upsertMessages } from '../src/archive/store.js';
it('applies the capture migration twice and reingests one successful observation idempotently', async () => {
  const migration = readFileSync(new URL('../../db/migrations/1756000020700_archive-change-evidence.sql', import.meta.url), 'utf8');
  await withTransaction(async tx => { await tx.query(migration); await tx.query(migration); });
  const session = (await query(`INSERT INTO archive_sessions(source,host,external_id) VALUES('zen-agent',$1,'capture') RETURNING id`, [host])).rows[0]!.id;
  const raw = { harness: 'zen-agent', type: 'message', message: { role: 'toolResult', toolCallId: 'write-a', toolName: 'write_file', isError: false,
    details: { change: { version: 1, id: 'capture-a', repository: 'a'.repeat(64), worktree: 'b'.repeat(64), path: 'notes/demo.md', before: null, after: 'c'.repeat(64), diff: { format: 'replacement', before: '', after: 'fixture', truncated: false } } } } };
  const input: ParsedMessage[] = [{ seq: 2, externalId: 'capture-result', parentExternalId: null, role: 'tool', kind: 'message', ts: new Date('2025-01-01T00:00:01Z'), contentText: '', raw, rawSha: 'fixture-capture', isSidechain: false }];
  input.unshift({ ...input[0]!, seq: 1, externalId: 'capture-call', ts: new Date('2025-01-01T00:00:00Z'), rawSha: 'fixture-call',
    raw: { harness: 'zen-agent', type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'write-a', name: 'write_file', arguments: { path: 'notes/demo.md' } }] } } });
  expect(await withTransaction(tx => upsertMessages(tx, session, input))).toBe(2);
  expect(await withTransaction(tx => upsertMessages(tx, session, input))).toBe(0);
  const stored = (await query('SELECT change_evidence FROM archive_messages WHERE session_id=$1 AND change_evidence IS NOT NULL', [session])).rows;
  expect(stored).toHaveLength(1);
  expect(stored[0]!.change_evidence.level).toBe('captured-diff');
  expect(JSON.stringify(stored[0])).not.toContain('fixture"');
  const from = Date.parse('2025-01-01T00:00:00Z');
  const data = await readSnapshot(db => loadWindow(db, { from, to: from + 5000, host }, new Set(['usage'])));
  const call = data.window.events.find(e => e.kind === 'tool_call')!, result = data.window.events.find(e => e.kind === 'tool_result')!;
  expect(result.change?.level).toBe('captured-diff');
  expect(replay(data.window, from).tools[call.id]).toBe('pending');
  expect(replay(data.window, from + 1000).tools[call.id]).toBe('success');
  expect(replay(data.window, from).tools[call.id]).toBe('pending');
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
