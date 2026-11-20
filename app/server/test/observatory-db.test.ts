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
  expect(result.change).toBeUndefined();
  expect(result.fileObservation).toMatchObject({ ownership: 'unknown', origin: 'legacy-reported' });
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


it('imports metadata-only unknown-owned observations through the new nullable migration without changing legacy ownership', async () => {
  const migration = readFileSync(new URL('../../db/migrations/1756000020750_archive-file-observations.sql', import.meta.url), 'utf8').split('-- Down Migration')[0]!;
  await withTransaction(async tx => { await tx.query(migration); await tx.query(migration); });
  const session = (await query(`INSERT INTO archive_sessions(source,host,external_id) VALUES('zen-agent',$1,'observed-current') RETURNING id`, [host])).rows[0]!.id;
  const observation = { version: 1, id: 'current-observation', repository: 'a'.repeat(64), worktree: 'b'.repeat(64), path: 'notes/demo.md',
    observedBefore: null, observedAfter: 'c'.repeat(64), ownership: 'unknown', diff: { format: 'changed-lines', context: 0, redacted: true, truncated: false,
      hunks: [{ oldStart: 1, newStart: 1, deleted: [], added: ['visible changed line\n'] }] } };
  const raw = { harness: 'zen-agent', type: 'message', message: { role: 'toolResult', toolCallId: 'observed-call', toolName: 'write_file', isError: false, details: { fileObservation: observation } } };
  const input: ParsedMessage[] = [{ seq: 1, externalId: 'observed-call', parentExternalId: null, role: 'assistant', kind: 'message', ts: new Date('2025-01-01T00:00:01Z'), contentText: '', rawSha: 'current-call', isSidechain: false,
    raw: { harness: 'zen-agent', type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'observed-call', name: 'write_file', arguments: { path: observation.path } }] } } },
    { seq: 2, externalId: 'observed-result', parentExternalId: null, role: 'tool', kind: 'message', ts: new Date('2025-01-01T00:00:02Z'), contentText: '', raw, rawSha: 'current-result', isSidechain: false }];
  expect(await withTransaction(tx => upsertMessages(tx, session, input))).toBe(2);
  expect(await withTransaction(tx => upsertMessages(tx, session, input))).toBe(0);
  const stored = (await query('SELECT file_observation, change_evidence FROM archive_messages WHERE session_id=$1 AND seq=2', [session])).rows[0]!;
  expect(stored.change_evidence).toBeNull(); expect(stored.file_observation).toMatchObject({ ownership: 'unknown', origin: 'runtime-observation' });
  expect(JSON.stringify(stored)).not.toMatch(/hunks|visible changed line/);
  const data = await readSnapshot(db => loadWindow(db, { from: Date.parse('2025-01-01T00:00:00Z'), to: Date.parse('2025-01-01T00:00:04Z'), host, session }, new Set(['usage'])));
  const event = data.window.events.find(e => e.fileObservation)!;
  expect(event.change).toBeUndefined(); expect(event.writeEvidence).toBe('tool-reported-success');
  expect(JSON.stringify(data.window)).not.toMatch(/hunks|visible changed line/);
});


import express from 'express';
import request from 'supertest';
import { observatoryRouter } from '../src/addons/observatory/routes.js';
import { errorHandler } from '../src/routes/http.js';
it('rechecks owner, export sources, modules, current binding and raw size on the real observation endpoint', async () => {
  const session = (await query(`INSERT INTO archive_sessions(source,host,external_id) VALUES('zen-agent',$1,'observation-api') RETURNING id`, [host])).rows[0]!.id;
  const observation = { version: 1, id: 'api-observation', repository: 'a'.repeat(64), worktree: 'b'.repeat(64), path: 'notes/demo.md',
    observedBefore: null, observedAfter: 'c'.repeat(64), ownership: 'unknown', diff: { format: 'replacement', before: '', after: 'readable observed text', truncated: false } };
  const raw = { harness: 'zen-agent', type: 'message', message: { role: 'toolResult', toolCallId: 'api-call', toolName: 'write_file', isError: false, details: { fileObservation: observation } } };
  const input: ParsedMessage[] = [{ seq: 1, externalId: 'api-call', parentExternalId: null, role: 'assistant', kind: 'message', ts: new Date('2025-01-01T00:00:01Z'), contentText: '', rawSha: 'api-call', isSidechain: false,
    raw: { harness: 'zen-agent', type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'api-call', name: 'write_file', arguments: { path: observation.path } }] } } },
    { seq: 2, externalId: 'api-result', parentExternalId: null, role: 'tool', kind: 'message', ts: new Date('2025-01-01T00:00:02Z'), contentText: '', raw, rawSha: 'api-result', isSidechain: false }];
  await withTransaction(tx => upsertMessages(tx, session, input));
  const modules = new Set(['usage']), app = express();
  // Trusted fixture middleware stands in for the existing authenticated session middleware.
  app.use((req, res, next) => { res.locals.sessionHash = req.get('x-fixture-owner') ?? 'fixture-owner'; next(); });
  app.use('/api/observatory', observatoryRouter(modules)); app.use(errorHandler);
  const window = (await request(app).get('/api/observatory/window').query({ from: '2025-01-01T00:00:00Z', to: '2025-01-01T00:00:04Z', host, session }).expect(200)).body;
  const event = window.window.events.find((e: { fileObservation?: unknown }) => e.fileObservation);
  expect(event.change).toBeUndefined(); expect(JSON.stringify(window)).not.toContain('readable observed text');
  const url = `/api/observatory/events/${encodeURIComponent(event.id)}/observation`, token = { export: window.export };
  const detail = (await request(app).get(url).query(token).expect(200)).body.detail;
  expect(detail).toMatchObject({ ownership: 'unknown', origin: 'runtime-observation', diff: { after: 'readable observed text' } });
  // Same stored metadata and observed hashes, different source-only body: the pinned export must reject it.
  await query('UPDATE archive_messages SET raw=$1 WHERE id=$2', [{ ...raw, message: { ...raw.message, details: { fileObservation: { ...observation, diff: { ...observation.diff, after: 'rewritten source-only body' } } } } }, event.source.id]);
  await request(app).get(url).query(token).expect(409);
  await query('UPDATE archive_messages SET raw=$1 WHERE id=$2', [raw, event.source.id]);
  await request(app).get(url).query(token).expect(200);
  await request(app).get(url).set('x-fixture-owner', 'other-fixture-owner').query(token).expect(410);
  modules.clear(); await request(app).get(url).query(token).expect(403); modules.add('usage');
  const rewritten = { ...input[0]!, rawSha: 'api-rewritten-parent', raw: { harness: 'zen-agent', type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'api-call', name: 'write_file', arguments: { path: 'notes/other.md' } }] } } };
  await withTransaction(tx => upsertMessages(tx, session, [rewritten]));
  await request(app).get(url).query(token).expect(409);
  await withTransaction(tx => upsertMessages(tx, session, [input[0]!]));
  await query('UPDATE archive_messages SET raw=$1 WHERE id=$2', [{ ...raw, message: { ...raw.message, toolCallId: 'other-call' } }, event.source.id]);
  await request(app).get(url).query(token).expect(409);
  await query('UPDATE archive_messages SET raw=$1 WHERE id=$2', [{ ...raw, message: { ...raw.message, details: { ...raw.message.details, path: 'notes/other.md' } } }, event.source.id]);
  await request(app).get(url).query(token).expect(409);
  await query('UPDATE archive_messages SET raw=$1 WHERE id=$2', [{ ...raw, message: { ...raw.message, details: { ...raw.message.details, captureRequest: null } } }, event.source.id]);
  await request(app).get(url).query(token).expect(409);
  await query('UPDATE archive_messages SET raw=$1 WHERE id=$2', [{ ...raw, oversizedFixture: 'x'.repeat(1048576) }, event.source.id]);
  await request(app).get(url).query(token).expect(413);
  await query('DELETE FROM archive_messages WHERE id=$1', [event.source.id]);
  await request(app).get(url).query(token).expect(403);
});

it('audits migrated observation-only, legacy-only and missing rows as distinct coverage buckets', async () => {
  const session = (await query(`INSERT INTO archive_sessions(source,host,external_id) VALUES('zen-agent',$1,'audit-evidence') RETURNING id`, [host])).rows[0]!.id;
  for (const [index, observation, legacy] of [
    [1, { origin: 'runtime-observation', diff: { truncated: false } }, null],
    [2, null, { level: 'captured-hashes' }], [3, null, null],
  ] as const) await query(`INSERT INTO archive_messages(session_id,seq,external_id,role,kind,ts,raw,raw_sha,file_observation,change_evidence)
    VALUES($1,$2,$3,'tool','message','2025-01-01T00:00:10Z','{}',$3,$4,$5)`, [session,index,`audit-${index}`,observation,legacy]);
  const sql = readFileSync(new URL('../../../docs/audits/observatory.sql', import.meta.url), 'utf8');
  const statement = sql.split('-- BEGIN prospective-evidence-audit')[1]?.split('-- END prospective-evidence-audit')[0];
  expect(statement).toBeTruthy();
  const rows = (await query(statement!)).rows.filter(row => row.host === host);
  expect(rows.map(row => ({ kind: row.evidence_kind, origin: row.observation_origin, availability: row.diff_availability, level: row.legacy_level, records: Number(row.records) })))
    .toEqual(expect.arrayContaining([
      { kind: 'file-observation', origin: 'runtime-observation', availability: 'readable', level: null, records: 1 },
      { kind: 'legacy-change', origin: null, availability: 'unknown', level: 'captured-hashes', records: 1 },
      { kind: 'missing', origin: null, availability: 'unknown', level: null, records: 1 },
    ]));
  expect(rows).toHaveLength(3);
});
