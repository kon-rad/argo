/** Synthetic runtime -> JSONL -> collector -> migrated scratch DB -> authorized lazy detail.
 * Build app and zen-agent first. Requires explicit PGHOST/PGPORT/SB_TEST_DB ending _test.
 * Never connects to the configured application database or reads credentials.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

assert.equal(process.env.PGHOST, '127.0.0.1', 'explicit loopback scratch database required');
assert.match(process.env.SB_TEST_DB ?? '', /^[a-z0-9_]+_test$/);
assert.match(process.env.PGPORT ?? '', /^\d+$/);
const workdir = mkdtempSync(join(tmpdir(), 'observatory-roundtrip-'));
process.env.VAULT_ROOT = workdir;
process.env.DEPLOYMENT = 'local';
const { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } = await import('@earendil-works/pi-ai');
const { ZenAgent } = await import('../dist/src/agent.js');
const { loadConfig } = await import('../dist/src/config.js');
const { parseZenTrace } = await import('../../app/server/dist/usage/zenTrace.js');
const { upsertMessages } = await import('../../app/server/dist/archive/store.js');
const { query, withTransaction, setDatabaseUrl } = await import('../../app/server/dist/db.js');
const { readSnapshot, loadWindow } = await import('../../app/server/dist/addons/observatory/service.js');
const { changeDetail } = await import('../../app/server/dist/addons/observatory/changeDetail.js');
setDatabaseUrl(`postgres://${process.env.PGHOST}:${process.env.PGPORT}/${process.env.SB_TEST_DB}`);
const host = `fixture-change-roundtrip-${process.pid}`;
try {
  execFileSync('git', ['-C', workdir, 'init', '-q']);
  const untouched = 'fixture-untouched-credential-123456';
  const deleted = 'fixture-deleted-credential-123456';
  const added = 'fixture-added-credential-123456';
  writeFileSync(join(workdir, 'note.md'), `credential=${untouched}\ninitial public\npassword=${deleted}\nstable context\n`);
  const writeArgs = { path: 'note.md', content: `credential=${untouched}\nold public\npassword=${deleted}\nstable context\n` };
  const editArgs = { path: 'note.md', old: `old public\npassword=${deleted}`, new: `new public\npassword=${added}` };
  const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('write_file', writeArgs)], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxToolCall('edit_file', editArgs)], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxText('synthetic capture complete')]),
  ]);
  const config = loadConfig({ workdir, env: {}, overrides: { model: 'faux/faux-1', tools: ['fs'] } });
  const agent = new ZenAgent({ config, models, env: {} });
  const run = await agent.run('synthetic roundtrip');
  const records = readFileSync(run.sessionPath, 'utf8').trim().split('\n').map(JSON.parse);
  const results = records.filter(r => r.type === 'message' && r.message.role === 'toolResult');
  assert.equal(results.length, 2);
  for (const r of results) {
    assert.equal(r.message.details.change.diff.format, 'changed-lines');
    assert.equal(r.message.details.change.diff.truncated, false);
    const text = JSON.stringify(r.message.details.change);
    for (const value of [untouched, deleted, added, 'stable context']) assert.equal(text.includes(value), false);
  }
  const resumed = new ZenAgent({ config, models, env: {}, resume: run.sessionId });
  const calls = resumed.agent.state.messages.filter(m => m.role === 'assistant').flatMap(m => m.content.filter(b => b.type === 'toolCall'));
  assert.deepEqual(calls.map(c => c.arguments), [writeArgs, editArgs]);
  const collected = parseZenTrace(records, host, '/synthetic/session.jsonl', new Date()).session;
  assert.ok(collected);
  assert.ok(JSON.stringify(collected.messages).includes(untouched), 'ordinary private arguments remain content-bearing');
  await query('INSERT INTO usage_hosts(slug,display,kind) VALUES($1,$1,\'server\')', [host]);
  const session = (await query('INSERT INTO archive_sessions(source,host,external_id) VALUES(\'zen-agent\',$1,$2) RETURNING id', [host, run.sessionId])).rows[0].id;
  assert.ok(await withTransaction(tx => upsertMessages(tx, session, collected.messages)));
  const projected = (await query('SELECT change_evidence FROM archive_messages WHERE session_id=$1 AND change_evidence IS NOT NULL', [session])).rows;
  assert.equal(projected.length, 2);
  const from = Math.min(...collected.messages.filter(m => m.ts).map(m => m.ts.getTime())) - 1;
  const data = await readSnapshot(db => loadWindow(db, { from, to: Date.now() + 1000, host }, new Set(['usage'])));
  const captured = data.window.events.filter(e => e.change);
  assert.equal(captured.length, 2);
  for (const value of ['initial public', 'old public', 'new public', untouched, deleted, added, 'hunks']) {
    assert.equal(JSON.stringify(projected).includes(value), false);
    assert.equal(JSON.stringify(data.window).includes(value), false);
  }
  for (const event of captured) {
    await assert.rejects(readSnapshot(db => changeDetail(db, event, new Set())), e => e.status === 403);
    const detail = await readSnapshot(db => changeDetail(db, event, new Set(['usage'])));
    assert.equal(detail.diff.format, 'changed-lines'); assert.equal(detail.diff.truncated, false);
    assert.ok(JSON.stringify(detail.diff).includes(event.tool === 'write_file' ? 'old public' : 'new public'));
    for (const value of [untouched, deleted, added, 'stable context']) assert.equal(JSON.stringify(detail).includes(value), false);
    assert.deepEqual(detail.originalHashes, { before: event.change.before, after: event.change.after });
  }
  console.log('PASS: actual write/edit -> JSONL/resume -> collector/upsert -> metadata-only window -> authorized redacted changed-line detail (2 captures)');
} finally {
  await query('DELETE FROM archive_sessions WHERE host=$1', [host]);
  await query('DELETE FROM usage_hosts WHERE slug=$1', [host]);
  // setDatabaseUrl replaces the initial pool; close its current live binding.
  await (await import('../../app/server/dist/db.js')).pool.end();
  rmSync(workdir, { recursive: true, force: true });
}
