/** Synthetic runtime -> JSONL -> collector -> migrated scratch DB -> authorized lazy detail.
 * Build app and zen-agent first. Requires explicit PGHOST/PGPORT/SB_TEST_DB ending _test.
 * Never connects to the configured application database or reads credentials.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

assert.equal(process.env.PGHOST, '127.0.0.1', 'explicit loopback scratch database required');
assert.match(process.env.SB_TEST_DB ?? '', /^[a-z0-9_]+_test$/);
assert.match(process.env.PGPORT ?? '', /^\d+$/);
assert.ok(process.argv.slice(2).every(arg => arg === '--nested'));
const repository = mkdtempSync(join(tmpdir(), 'observatory-roundtrip-'));
const workdir = process.argv.includes('--nested') ? join(repository, 'sub') : repository;
mkdirSync(workdir, { recursive: true });
process.env.VAULT_ROOT = workdir;
process.env.DEPLOYMENT = 'local';
const { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } = await import('@earendil-works/pi-ai');
const { ZenAgent } = await import('../dist/src/agent.js');
const { loadConfig } = await import('../dist/src/config.js');
const { parseZenTrace } = await import('../../app/server/dist/usage/zenTrace.js');
const { upsertMessages } = await import('../../app/server/dist/archive/store.js');
const { query, withTransaction, setDatabaseUrl } = await import('../../app/server/dist/db.js');
const { readSnapshot, loadWindow } = await import('../../app/server/dist/addons/observatory/service.js');
const { observationDetail } = await import('../../app/server/dist/addons/observatory/observationDetail.js');
setDatabaseUrl(`postgres://${process.env.PGHOST}:${process.env.PGPORT}/${process.env.SB_TEST_DB}`);
const host = `fixture-change-roundtrip-${process.pid}`;
try {
  execFileSync('git', ['-C', repository, 'init', '-q']);
  const untouched = 'fixture-untouched-credential-123456';
  const deleted = 'fixture-deleted-credential-123456';
  const added = 'fixture-added-credential-123456';
  writeFileSync(join(workdir, 'note.md'), `credential=${untouched}\ninitial public\npassword=${deleted}\nstable context\n`);
  const writeArgs = { path: './note.md', content: `credential=${untouched}\nold public\npassword=${deleted}\nstable context\n` };
  const emptyArgs = { path: './empty.md', content: '' };
  const editArgs = { path: './note.md', old: `old public\npassword=${deleted}`, new: `new public\npassword=${added}` };
  const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('write_file', writeArgs)], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxToolCall('edit_file', editArgs)], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxToolCall('write_file', emptyArgs)], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxText('synthetic capture complete')]),
  ]);
  const config = loadConfig({ workdir, env: {}, overrides: { model: 'faux/faux-1', tools: ['fs'] } });
  const agent = new ZenAgent({ config, models, env: {} });
  const run = await agent.run('synthetic roundtrip');
  const records = readFileSync(run.sessionPath, 'utf8').trim().split('\n').map(JSON.parse);
  const results = records.filter(r => r.type === 'message' && r.message.role === 'toolResult');
  assert.equal(results.length, 3);
  for (const r of results) {
    assert.equal(r.message.details.change, undefined);
    assert.equal(r.message.details.fileObservation.ownership, 'unknown');
    assert.equal(r.message.details.fileObservation.diff.format, 'changed-lines');
    assert.ok(r.message.details.captureRequest.path.startsWith('./'));
    assert.ok(r.message.details.captureRequest.resolvedPath.startsWith('/'));
    assert.equal('captureRequest' in r.message.details.fileObservation, false);
    if (r.message.details.fileObservation.path.split('/').at(-1) === 'empty.md') {
      assert.equal(r.message.details.fileObservation.observedBefore, null);
      assert.equal(r.message.details.fileObservation.diff.truncated, true);
      assert.equal(r.message.details.fileObservation.diff.reason, 'empty-change');
    } else assert.equal(r.message.details.fileObservation.diff.truncated, false);
    const text = JSON.stringify(r.message.details.fileObservation);
    for (const value of [untouched, deleted, added, 'stable context']) assert.equal(text.includes(value), false);
  }
  const resumed = new ZenAgent({ config, models, env: {}, resume: run.sessionId });
  const calls = resumed.agent.state.messages.filter(m => m.role === 'assistant').flatMap(m => m.content.filter(b => b.type === 'toolCall'));
  assert.deepEqual(calls.map(c => c.arguments), [writeArgs, editArgs, emptyArgs]);
  const collected = parseZenTrace(records, host, '/synthetic/session.jsonl', new Date()).session;
  assert.ok(collected);
  assert.ok(JSON.stringify(collected.messages).includes(untouched), 'ordinary private arguments remain content-bearing');
  await query('INSERT INTO usage_hosts(slug,display,kind) VALUES($1,$1,\'server\')', [host]);
  const session = (await query('INSERT INTO archive_sessions(source,host,external_id) VALUES(\'zen-agent\',$1,$2) RETURNING id', [host, run.sessionId])).rows[0].id;
  assert.ok(await withTransaction(tx => upsertMessages(tx, session, collected.messages)));
  const projected = (await query('SELECT file_observation, change_evidence FROM archive_messages WHERE session_id=$1 AND file_observation IS NOT NULL', [session])).rows;
  assert.equal(projected.length, 3);
  const from = Math.min(...collected.messages.filter(m => m.ts).map(m => m.ts.getTime())) - 1;
  const data = await readSnapshot(db => loadWindow(db, { from, to: Date.now() + 1000, host }, new Set(['usage'])));
  const observed = data.window.events.filter(e => e.fileObservation);
  assert.ok(data.window.events.every(e => !e.change), 'no ordinary or legacy snapshot is a verified transition');
  assert.ok(projected.every(row => row.change_evidence === null));
  assert.equal(observed.length, 3);
  for (const value of ['initial public', 'old public', 'new public', untouched, deleted, added, 'hunks', 'captureRequest', 'resolvedPath']) {
    assert.equal(JSON.stringify(projected).includes(value), false);
    assert.equal(JSON.stringify(data.window).includes(value), false);
  }
  for (const event of observed) {
    await assert.rejects(readSnapshot(db => observationDetail(db, event, new Set())), e => e.status === 403);
    const detail = await readSnapshot(db => observationDetail(db, event, new Set(['usage'])));
    assert.equal(detail.diff.format, 'changed-lines');
    if (event.fileObservation.path.split('/').at(-1) === 'empty.md') {
      assert.equal(event.fileObservation.ownership, 'unknown');
      assert.equal(detail.diff.truncated, true); assert.equal(detail.diff.reason, 'empty-change');
      assert.equal('hunks' in detail.diff, false); continue;
    }
    assert.equal(detail.diff.truncated, false);
    assert.ok(JSON.stringify(detail.diff).includes(event.tool === 'write_file' ? 'old public' : 'new public'));
    for (const value of [untouched, deleted, added, 'stable context']) assert.equal(JSON.stringify(detail).includes(value), false);
    assert.equal(detail.ownership, 'unknown');
    assert.equal(detail.origin, 'runtime-observation');
    assert.equal(event.fileObservation.ownership, 'unknown');
    assert.deepEqual(detail.observedHashes, { before: event.fileObservation.observedBefore, after: event.fileObservation.observedAfter });
  }
  console.log('PASS: actual write/edit -> JSONL/resume -> collector/upsert -> metadata-only window -> authorized unattributed observed diff (2 readable observations plus empty-file hash observation; zero transition captures)');
} finally {
  await query('DELETE FROM archive_sessions WHERE host=$1', [host]);
  await query('DELETE FROM usage_hosts WHERE slug=$1', [host]);
  // setDatabaseUrl replaces the initial pool; close its current live binding.
  await (await import('../../app/server/dist/db.js')).pool.end();
  rmSync(repository, { recursive: true, force: true });
}
