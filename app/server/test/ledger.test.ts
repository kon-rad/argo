import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { query } from '../src/db.js';
import { addDevice, revokeDevice } from '../src/ingest/devices.js';
import { collectClaude, collectHermes, hermesNames } from '../src/ledger/collect.js';
import { defaultConfig } from '../src/ledger/config.js';
import { launchdPlist, schtasksArgs, schtasksProxyArgs, systemdProxyUnit, systemdUnits } from '../src/ledger/install.js';
import { Ledger } from '../src/ledger/store.js';
import { backoffMs, syncOnce } from '../src/ledger/sync.js';
import type { LedgerConfig } from '../src/ledger/types.js';
import { truncateAll } from './helpers.js';

const assistant = (uuid: string, id: string, ts: string, output: number, extra: Record<string, unknown> = {}) => JSON.stringify({
  type: 'assistant', uuid, parentUuid: null, timestamp: ts, sessionId: 's1', entrypoint: 'cli', requestId: `req_${id}`,
  message: { id, model: 'claude-opus-5-5', role: 'assistant',
    content: [{ type: 'thinking', thinking: 'let me look' }, { type: 'tool_use', id: `tu_${uuid}`, name: 'Bash', input: { command: 'ls' } }],
    usage: { input_tokens: 3, cache_creation_input_tokens: 100, cache_read_input_tokens: 50, output_tokens: output, output_tokens_details: { thinking_tokens: 7 } } },
  ...extra,
}) + '\n';
const user = (uuid: string, ts: string, text: string) => JSON.stringify({ type: 'user', uuid, timestamp: ts, message: { role: 'user', content: text } }) + '\n';

function buildHermes(dbPath: string, messages: number): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, model TEXT, parent_session_id TEXT,
    started_at REAL NOT NULL, ended_at REAL, message_count INTEGER, input_tokens INTEGER, output_tokens INTEGER,
    cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER, api_call_count INTEGER,
    billing_provider TEXT, cwd TEXT, title TEXT, system_prompt TEXT, estimated_cost_usd REAL);
    CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
    content TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL, reasoning TEXT);`);
  db.prepare(`INSERT OR REPLACE INTO sessions (id, source, model, started_at, ended_at, message_count, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, reasoning_tokens, api_call_count, billing_provider, cwd, title, system_prompt, estimated_cost_usd)
    VALUES ('h1', 'cli', 'qwen3', 1790000000, 1790000100, ?, 10, 20, 5, 0, 3, 2, 'openrouter', '/work', 'Hello', 'You are Hermes', 0.01)`).run(messages);
  const have = Number((db.prepare('SELECT count(*) n FROM messages').get() as { n: number }).n);
  for (let i = have; i < messages; i++) {
    db.prepare(`INSERT INTO messages (session_id, role, content, tool_calls, timestamp, reasoning) VALUES ('h1', ?, ?, ?, ?, ?)`)
      .run(i % 2 ? 'assistant' : 'user', `m${i}`, i % 2 ? '[{"name":"terminal"}]' : null, 1790000001 + i, i % 2 ? 'thinking hard' : null);
  }
  db.close();
}

let root: string;
let ledger: Ledger;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ledger-'));
  ledger = new Ledger(join(root, 'data', 'ledger.db'));
});
afterEach(() => ledger.close());

describe('ledger store', () => {
  it('gives a row a new seq only when its JSON changes', () => {
    expect(ledger.put('session', 'a', { x: 1 })).toBe(true);
    expect(ledger.put('session', 'a', { x: 1 })).toBe(false);
    expect(ledger.headSeq).toBe(1);
    expect(ledger.put('session', 'a', { x: 2 })).toBe(true);
    expect(ledger.pending(0, 1e6).map((r) => [r.seq, r.key])).toEqual([[2, 'a']]);
  });

  it('caps a batch by bytes but always returns at least one row', () => {
    ledger.put('message', 'big', { t: 'x'.repeat(5000) });
    ledger.put('message', 'small', { t: 'y' });
    expect(ledger.pending(0, 100)).toHaveLength(1);
    expect(ledger.pending(0, 1e6)).toHaveLength(2);
  });

  it('prunes only turns the server acknowledged and that are older than the window', () => {
    ledger.put('message', 'old', { a: 1 }, { ts: '2026-01-01T00:00:00Z' });
    ledger.put('message', 'recent', { a: 2 }, { ts: '2026-10-18T00:00:00Z' });
    ledger.put('message', 'old-unsynced', { a: 3 }, { ts: '2026-01-01T00:00:00Z' });
    ledger.setMeta('acked_seq', 2);
    expect(ledger.prune(30, new Date('2026-10-19T00:00:00Z'))).toBe(1);
    expect(ledger.get('message', 'old')).toBeNull();
    expect(ledger.get('message', 'recent')).toEqual({ a: 2 });
    expect(ledger.get('message', 'old-unsynced')).toEqual({ a: 3 });
  });

  it('prune empties rows but keeps their hash, so an identical re-read is not resent, and spares quarantined rows', () => {
    ledger.put('message', 'm', { a: 1 }, { ts: '2026-01-01T00:00:00Z' });
    ledger.put('blob', 'b', { body: 'system prompt' }, { ts: '2026-01-01T00:00:00Z' });
    ledger.put('exchange', 'x', { e: 1 }, { ts: '2026-01-01T00:00:00Z' });
    ledger.put('message', 'refused', { a: 2 }, { ts: '2026-01-01T00:00:00Z' });
    ledger.setMeta('acked_seq', ledger.headSeq);
    ledger.quarantine(ledger.pending(3, 1e6)[0]!, 'HTTP 422');
    expect(ledger.prune(30, new Date('2026-10-19T00:00:00Z'))).toBe(3);
    expect(ledger.get('message', 'm')).toBeNull();
    expect(ledger.get('message', 'refused')).toEqual({ a: 2 });
    const head = ledger.headSeq;
    expect(ledger.put('message', 'm', { a: 1 })).toBe(false); // Hermes reads the same turn again
    expect(ledger.headSeq).toBe(head);
    expect(ledger.put('message', 'm', { a: 9 })).toBe(true); // a real change still goes out
    expect(ledger.get('message', 'm')).toEqual({ a: 9 });
  });

  it('requeues refused rows: a day later on schedule, at once on request, and counts the attempts', () => {
    ledger.put('exchange', 'x', { a: 1 });
    const row = ledger.pending(0, 1e6)[0]!;
    ledger.setMeta('acked_seq', row.seq);
    ledger.quarantine(row, 'HTTP 422: unknown kind');
    expect(ledger.requeue({ olderThanMs: 86_400_000, maxAttempts: 7 })).toBe(0); // refused just now
    expect(ledger.requeue()).toBe(1);
    const again = ledger.pending(row.seq, 1e6);
    expect(again.map((r) => r.key)).toEqual(['x']);
    expect((ledger.stats().sync as { quarantined: number }).quarantined).toBe(0);
    ledger.quarantine(again[0]!, 'still refused');
    expect(ledger.db.prepare('SELECT attempts FROM quarantine').get()).toEqual({ attempts: 2 });
    expect(ledger.requeue({ maxAttempts: 2 })).toBe(0); // gave up
  });

  it('survives a reopen with its seq and acked mark', () => {
    ledger.put('call', 'c', { n: 1 });
    ledger.setMeta('acked_seq', 1);
    ledger.close();
    ledger = new Ledger(join(root, 'data', 'ledger.db'));
    expect(ledger.syncState().ackedSeq).toBe(1);
    ledger.put('call', 'd', { n: 2 });
    expect(ledger.headSeq).toBe(2);
  });
});

describe('collectClaude', () => {
  let projects: string;
  let file: string;
  beforeEach(() => {
    projects = join(root, 'projects');
    mkdirSync(join(projects, '-work-app'), { recursive: true });
    file = join(projects, '-work-app', 's1.jsonl');
    writeFileSync(file, user('u1', '2026-10-19T01:00:00Z', 'list the files') + assistant('a1', 'msg_1', '2026-10-19T01:00:01Z', 40));
  });

  it('stores prompts, thinking, tool calls and tokens, then reads only what was appended', () => {
    const first = collectClaude(ledger, projects, 'anthropic');
    expect(first).toMatchObject({ files: 1, sessions: 1, messages: 2, calls: 1, errors: [] });
    const session = ledger.get('session', 'claude-code|s1');
    expect(session).toMatchObject({ source: 'claude-code', externalId: 's1', project: '-work-app', model: 'claude-opus-5-5', provider: 'anthropic' });
    const msg = ledger.get<{ contentText: string }>('message', 'claude-code|s1|a1')!;
    expect(msg.contentText).toContain('[thinking] let me look');
    expect(msg.contentText).toContain('[tool_use Bash]');
    expect(ledger.get('call', 'claude-code|msg_1')).toMatchObject({
      model: 'claude-opus-5-5', provider: 'anthropic', inputTokens: 3, cacheWriteTokens: 100, cacheReadTokens: 50,
      outputTokens: 40, thinkingTokens: 7, tool: 'Bash', action: 'shell',
    });
    expect(collectClaude(ledger, projects, 'anthropic')).toMatchObject({ files: 0, messages: 0 });

    appendFileSync(file, user('u2', '2026-10-19T01:01:00Z', 'thanks') + '{"type":"user","uuid":"torn"');
    expect(collectClaude(ledger, projects, 'anthropic')).toMatchObject({ messages: 1 }); // the torn line waits
    appendFileSync(file, ',"timestamp":"2026-10-19T01:02:00Z","message":{"content":"x"}}\n');
    expect(collectClaude(ledger, projects, 'anthropic')).toMatchObject({ messages: 1 });
    expect(ledger.get('message', 'claude-code|s1|torn')).toMatchObject({ kind: 'user' });
  });

  it('keeps the fullest copy of a response repeated across blocks', () => {
    appendFileSync(file, assistant('a2', 'msg_1', '2026-10-19T01:00:02Z', 90));
    collectClaude(ledger, projects, 'anthropic');
    expect(ledger.get('call', 'claude-code|msg_1')).toMatchObject({ outputTokens: 90, ts: '2026-10-19T01:00:01.000Z' });
    appendFileSync(file, assistant('a3', 'msg_1', '2026-10-19T01:00:03Z', 10));
    collectClaude(ledger, projects, 'anthropic');
    expect(ledger.get('call', 'claude-code|msg_1')).toMatchObject({ outputTokens: 90 });
  });

  it('marks subagent transcripts as sidechains of their parent session', () => {
    mkdirSync(join(projects, '-work-app', 's1', 'subagents'), { recursive: true });
    writeFileSync(join(projects, '-work-app', 's1', 'subagents', 'agent-x.jsonl'), user('x1', '2026-10-19T02:00:00Z', 'sub task'));
    collectClaude(ledger, projects, 'anthropic');
    expect(ledger.get('session', 'claude-code|agent-x')).toMatchObject({ parentExternalId: 's1' });
    expect(ledger.get('message', 'claude-code|agent-x|x1')).toMatchObject({ isSidechain: true });
  });

  it('re-reads a shrunk file from the start without re-queueing rows it already has', () => {
    collectClaude(ledger, projects, 'anthropic');
    const head = ledger.headSeq;
    writeFileSync(file, user('u1', '2026-10-19T01:00:00Z', 'list the files'));
    expect(collectClaude(ledger, projects, 'anthropic')).toMatchObject({ files: 1, messages: 0, sessions: 0 });
    expect(ledger.headSeq).toBe(head);
  });
});

describe('collectHermes', () => {
  it('names sources the way the archive does', () => {
    expect(hermesNames('main', 'main')).toEqual({ source: 'hermes', profile: 'main' });
    expect(hermesNames('main', 'builder')).toEqual({ source: 'hermes:builder', profile: 'builder' });
    expect(hermesNames('vault', 'main')).toEqual({ source: 'hermes:vault', profile: 'vault' });
    expect(hermesNames('vault', 'lena')).toEqual({ source: 'hermes:vault-lena', profile: 'vault-lena' });
  });

  it('reads every home and profile, skips unchanged databases and queues only new rows', async () => {
    // A private temp dir: a ledger running on the same machine makes its own sb-ledger-* folders.
    const tmp = join(root, 'tmp');
    mkdirSync(tmp);
    const before = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
    try { await readsEveryHome(); } finally { if (before === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = before; }
  });
  async function readsEveryHome(): Promise<void> {
    const home = join(root, 'hermes');
    mkdirSync(join(home, 'profiles', 'builder'), { recursive: true });
    buildHermes(join(home, 'state.db'), 2);
    buildHermes(join(home, 'profiles', 'builder', 'state.db'), 2);
    writeFileSync(join(home, 'config.yaml'), 'timezone: Asia/Tokyo\n');

    const first = await collectHermes(ledger, [{ dir: home, label: 'main' }]);
    expect(first).toMatchObject({ files: 2, sessions: 2, messages: 4, counters: 2, errors: [] });
    expect(ledger.get('session', 'hermes|h1')).toMatchObject({
      source: 'hermes', model: 'qwen3', messageCount: 2, costUsd: 0.01, meta: { profile: 'main', timezone: 'Asia/Tokyo', system_prompt: 'You are Hermes' },
    });
    expect(ledger.get<{ contentText: string }>('message', 'hermes|h1|msg:2')!.contentText).toContain('[reasoning] thinking hard');
    expect(ledger.get('counter', 'builder|h1')).toMatchObject({ billingProvider: 'openrouter', reasoningTokens: 3, apiCalls: 2 });
    expect(await collectHermes(ledger, [{ dir: home, label: 'main' }])).toMatchObject({ files: 0 });

    buildHermes(join(home, 'state.db'), 3);
    expect(await collectHermes(ledger, [{ dir: home, label: 'main' }])).toMatchObject({ files: 1, messages: 1, sessions: 1 });
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith('sb-ledger-'))).toEqual([]); // no plaintext snapshot left
  }
});

describe('collectHermes with a second home', () => {
  it('skips sessions the first home already has, with their messages and counters', async () => {
    const vault = join(root, 'vault-hermes');
    const user = join(root, 'user-hermes');
    mkdirSync(vault);
    mkdirSync(user);
    buildHermes(join(vault, 'state.db'), 2);
    buildHermes(join(user, 'state.db'), 2);               // h1: a copy of the vault's session
    const db = new DatabaseSync(join(user, 'state.db'));
    db.exec(`INSERT INTO sessions (id, source, started_at) VALUES ('h9', 'cli', 1790000500)`);
    db.prepare(`INSERT INTO messages (session_id, role, content, timestamp) VALUES ('h9', 'user', 'only here', 1790000501)`).run();
    db.close();
    const c = await collectHermes(ledger, [{ dir: vault, label: 'main' }, { dir: user, label: 'user' }]);
    expect(c.errors).toEqual([]);
    expect(ledger.get('session', 'hermes|h1')).not.toBeNull();
    expect(ledger.get('session', 'hermes:user|h1')).toBeNull();
    expect(ledger.get('message', 'hermes:user|h1|msg:1')).toBeNull();
    expect(ledger.get('counter', 'user|h1')).toBeNull();
    expect(ledger.get('session', 'hermes:user|h9')).not.toBeNull();
  });
});

describe('install units', () => {
  const spec = { node: '/opt/node/bin/node', bundle: '/data/bin/ledger.mjs', intervalSec: 120, dataDir: '/data', logFile: '/logs/ledger.log' };
  it('launchd runs `ledger run` on an interval', () => {
    const p = launchdPlist(spec);
    expect(p).toContain('<string>/opt/node/bin/node</string><string>--no-warnings</string><string>/data/bin/ledger.mjs</string><string>run</string>');
    expect(p).toContain('<integer>120</integer>');
    expect(p).toContain('<key>SB_LEDGER_DIR</key><string>/data</string>');
  });
  it('systemd gets a oneshot service and a timer', () => {
    const u = systemdUnits(spec);
    expect(u.service).toContain('ExecStart="/opt/node/bin/node" --no-warnings "/data/bin/ledger.mjs" run');
    expect(u.timer).toContain('OnUnitActiveSec=120');
  });
  it('Task Scheduler repeats in whole minutes and fits its 261-character command limit', () => {
    const args = schtasksArgs({ ...spec, intervalSec: 90 });
    expect(args).toEqual(expect.arrayContaining(['/SC', 'MINUTE', '/MO', '2', '/TN', 'SecondBrainLedger']));
    expect(args[args.indexOf('/TR') + 1]!.length).toBeLessThan(261);
    expect(schtasksProxyArgs(spec).join(' ')).toContain('for /l %i in (0,0,1) do');
  });
  it('systemd units escape % and send a log path with spaces to the journal', () => {
    const u = systemdUnits({ ...spec, dataDir: '/data/100%', logFile: '/my logs/ledger.log' });
    expect(u.service).toContain('SB_LEDGER_DIR="/data/100%%"');
    expect(u.service).toContain('StandardOutput=journal');
    expect(systemdProxyUnit(spec)).toContain('Restart=always');
  });
});

describe('sync to the server', () => {
  let server: Server;
  let base: string;
  let token: string;
  let deviceId: number;
  let cfg: LedgerConfig;
  let projects: string;
  const deps = { fetch, now: () => new Date(), bundle: 'test' };

  beforeEach(async () => {
    await truncateAll();
    ({ id: deviceId, token } = await addDevice('test-box', { display: 'Test box', kind: 'laptop' }));
    const app = createApp({ modules: new Set(['usage']), deployment: 'local' });
    server = await new Promise<Server>((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    projects = join(root, 'projects');
    mkdirSync(join(projects, '-work'), { recursive: true });
    writeFileSync(join(projects, '-work', 's1.jsonl'),
      user('u1', '2026-10-19T01:00:00Z', 'hi') + assistant('a1', 'msg_1', '2026-10-19T01:00:01Z', 40));
    cfg = { ...defaultConfig(root), server: base, token, host: 'test-box', claudeProjectsDir: projects, hermesHomes: [], batchBytes: 1_000_000 };
  });
  afterEach(async () => { await new Promise((ok) => server.close(ok)); });
  // usage_hosts survives truncateAll (migrations seed it): leave it as the schema tests expect.
  afterAll(async () => {
    await query(`DELETE FROM ingest_devices WHERE host='test-box'`);
    await query(`DELETE FROM usage_hosts WHERE slug='test-box'`);
  });

  it('keeps everything local while offline, then sends it all once the server is back', async () => {
    collectClaude(ledger, projects, 'anthropic');
    const offline = await syncOnce(ledger, { ...cfg, server: 'http://127.0.0.1:1' }, deps);
    expect(offline).toMatchObject({ status: 'retry', sent: 0, ackedSeq: 0 });
    expect(ledger.syncState()).toMatchObject({ fails: 1, ackedSeq: 0 });
    expect(Date.parse(ledger.syncState().nextAttemptAt!) - Date.now()).toBeGreaterThan(backoffMs(1) - 5000);
    expect((await syncOnce(ledger, cfg, deps)).status).toBe('waiting'); // backoff holds without --force

    const online = await syncOnce(ledger, cfg, deps, { force: true });
    expect(online).toMatchObject({ status: 'ok', sent: ledger.headSeq, ackedSeq: ledger.headSeq });
    expect(ledger.syncState()).toMatchObject({ fails: 0, lastError: null, nextAttemptAt: null });

    const s = await query(`SELECT host, source, message_count, meta FROM archive_sessions WHERE external_id='s1'`);
    expect(s.rows[0]).toMatchObject({ host: 'test-box', source: 'claude-code', message_count: 2, meta: { provider: 'anthropic' } });
    const m = await query(`SELECT content_text FROM archive_messages ORDER BY seq`);
    expect(m.rows.map((r) => r.content_text).join('\n')).toContain('[thinking] let me look');
    const c = await query(`SELECT host, provider, output_tokens, thinking_tokens, model FROM usage_calls`);
    expect(c.rows).toEqual([{ host: 'test-box', provider: 'anthropic', output_tokens: 40, thinking_tokens: 7, model: 'claude-opus-5-5' }]);
    const b = await query(`SELECT host, rows FROM ingest_batches`);
    expect(b.rows).toEqual([{ host: 'test-box', rows: 4 }]);

    expect(await syncOnce(ledger, cfg, deps)).toMatchObject({ status: 'ok', sent: 0 });
  });

  it('resending an acknowledged batch changes nothing on the server', async () => {
    collectClaude(ledger, projects, 'anthropic');
    await syncOnce(ledger, cfg, deps, { force: true });
    ledger.setMeta('acked_seq', 0);
    expect(await syncOnce(ledger, cfg, deps, { force: true })).toMatchObject({ status: 'ok', sent: 4 });
    const n = await query(`SELECT (SELECT count(*) FROM archive_sessions)::int s, (SELECT count(*) FROM archive_messages)::int m, (SELECT count(*) FROM usage_calls)::int c`);
    expect(n.rows[0]).toEqual({ s: 1, m: 2, c: 1 });
  });

  it('writes rows as the token\'s host, whatever the row claims', async () => {
    ledger.put('session', 'claude-code|spoof', { source: 'claude-code', externalId: 'spoof', host: 'mac' });
    await syncOnce(ledger, cfg, deps, { force: true });
    const r = await query(`SELECT host FROM archive_sessions WHERE external_id='spoof'`);
    expect(r.rows).toEqual([{ host: 'test-box' }]);
  });

  it('accepts messages that arrive before their session row', async () => {
    // A forked session copies a subagent file under a second parent: the session row changes, takes a
    // later seq, and the first sync sends that session's earlier messages first (seen on a real laptop's data).
    ledger.put('message', 'claude-code|late|m1', { sessionExternalId: 'late', seq: 1, externalId: 'm1', parentExternalId: null,
      role: 'user', kind: 'user', ts: '2026-10-19T01:00:00Z', contentText: 'hello', raw: { type: 'user' }, rawSha: 'x', isSidechain: true });
    ledger.put('session', 'claude-code|late', { source: 'claude-code', externalId: 'late', parentExternalId: 'p2', project: '-work', title: 'Late' });
    expect(await syncOnce(ledger, cfg, deps, { force: true })).toMatchObject({ status: 'ok', quarantined: 0 });
    const s = await query(`SELECT parent_external_id, title, message_count FROM archive_sessions WHERE external_id='late'`);
    expect(s.rows).toEqual([{ parent_external_id: 'p2', title: 'Late', message_count: 1 }]);
  });

  it('quarantines a malformed row and delivers the rest', async () => {
    collectClaude(ledger, projects, 'anthropic');
    ledger.put('message', 'claude-code|s1|bad', { sessionExternalId: 's1', seq: 9, externalId: 'bad', role: 'user', kind: 'user', rawSha: 42 });
    const r = await syncOnce(ledger, cfg, deps, { force: true });
    expect(r).toMatchObject({ status: 'ok', quarantined: 1, ackedSeq: ledger.headSeq });
    expect((ledger.stats().sync as { quarantined: number }).quarantined).toBe(1);
    expect((await query(`SELECT count(*)::int n FROM archive_messages`)).rows[0].n).toBe(2);
  });

  it('treats a bare 400 (a cut-off upload) as noise to retry, not a bad row', async () => {
    collectClaude(ledger, projects, 'anthropic');
    const fake = (async () => new Response('{"error":{"message":"request aborted"}}', { status: 400 })) as typeof fetch;
    expect(await syncOnce(ledger, cfg, { ...deps, fetch: fake }, { force: true })).toMatchObject({ status: 'retry', quarantined: 0, ackedSeq: 0 });
  });

  it('refuses a request without a token before reading its body', async () => {
    const res = await fetch(`${base}/api/ingest/batch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
    expect(res.status).toBe(401);
  });

  it('stops on a revoked token and keeps the rows', async () => {
    collectClaude(ledger, projects, 'anthropic');
    await revokeDevice(deviceId);
    expect(await syncOnce(ledger, cfg, deps, { force: true })).toMatchObject({ status: 'auth', ackedSeq: 0 });
    expect(ledger.syncState().lastError).toContain('401');
  });

  it('retries when the server has no ingest route yet', async () => {
    const bare = createApp({ modules: new Set(), deployment: 'local' });
    const s2 = await new Promise<Server>((ok) => { const s = bare.listen(0, '127.0.0.1', () => ok(s)); });
    try {
      collectClaude(ledger, projects, 'anthropic');
      const r = await syncOnce(ledger, { ...cfg, server: `http://127.0.0.1:${(s2.address() as AddressInfo).port}` }, deps, { force: true });
      expect(r).toMatchObject({ status: 'retry', ackedSeq: 0 });
    } finally {
      await new Promise((ok) => s2.close(ok));
    }
  });

  it('syncs Hermes sessions, messages and token counters', async () => {
    const home = join(root, 'hermes');
    mkdirSync(home);
    buildHermes(join(home, 'state.db'), 2);
    await collectHermes(ledger, [{ dir: home, label: 'main' }]);
    expect(await syncOnce(ledger, cfg, deps, { force: true })).toMatchObject({ status: 'ok' });
    const s = await query(`SELECT host, source, message_count, cost_usd FROM archive_sessions`);
    expect(s.rows).toEqual([{ host: 'test-box', source: 'hermes', message_count: 2, cost_usd: 0.01 }]);
    const h = await query(`SELECT host, profile, reasoning_tokens, billing_provider FROM hermes_usage_snapshots`);
    expect(h.rows).toEqual([{ host: 'test-box', profile: 'main', reasoning_tokens: 3, billing_provider: 'openrouter' }]);
  });

  it('syncs the Hermes plugin\'s per-request calls for every profile, once, with this machine\'s keys removed', async () => {
    const home = join(root, 'hermes');
    const line = (sid: string, req: string, extra: Record<string, unknown> = {}) => JSON.stringify({ v: 1, kind: 'main',
      ts: '2026-10-19T02:00:00+00:00', session_id: sid, api_request_id: req, platform: 'cli', provider: 'openrouter',
      model: 'qwen3', input: 100, output: 9, cache_read: 50, cache_write: 0, reasoning: 4, tools: ['terminal'], match: 't:call_a', ...extra }) + '\n';
    mkdirSync(join(home, 'usage'), { recursive: true });
    mkdirSync(join(home, 'profiles', 'builder', 'usage'), { recursive: true });
    writeFileSync(join(home, 'profiles', 'builder', 'state.db'), '');
    writeFileSync(join(home, 'usage', 'calls-2026-10-19.jsonl'), line('h1', 'r1') + '{"cut off');
    writeFileSync(join(home, 'profiles', 'builder', 'usage', 'calls-2026-10-19.jsonl'), line('b1', 'r2', { platform: 'MYTOKEN-abcdefghijklmnop' }));
    const envFile = join(root, 'machine.env');
    writeFileSync(envFile, 'SOME_API_KEY=MYTOKEN-abcdefghijklmnop\n');
    await collectHermes(ledger, [{ dir: home, label: 'main' }]);
    const again = await collectHermes(ledger, [{ dir: home, label: 'main' }]);
    expect(again.calls).toBe(0);
    expect(await syncOnce(ledger, { ...cfg, redactEnvFiles: [envFile] }, deps, { force: true })).toMatchObject({ status: 'ok' });
    const c = await query(`SELECT source, host, call_id, session_external_id, input_tokens, thinking_tokens, provider, match_key, entrypoint
      FROM usage_calls ORDER BY call_id`);
    expect(c.rows).toEqual([
      { source: 'hermes', host: 'test-box', call_id: 'r1', session_external_id: 'h1', input_tokens: 100, thinking_tokens: 4,
        provider: 'openrouter', match_key: 't:call_a', entrypoint: 'cli' },
      { source: 'hermes:builder', host: 'test-box', call_id: 'r2', session_external_id: 'b1', input_tokens: 100, thinking_tokens: 4,
        provider: 'openrouter', match_key: 't:call_a', entrypoint: '[redacted:SOME_API_KEY]' },
    ]);
  });

  it('sends nothing while the capture proxy is on without an env file to redact with', async () => {
    collectClaude(ledger, projects, 'anthropic');
    const r = await syncOnce(ledger, { ...cfg, proxy: { ...cfg.proxy, enabled: true } }, deps, { force: true });
    expect(r).toMatchObject({ status: 'disabled', sent: 0 });
    expect(r.error).toMatch(/redact-env/);
  });

  it('stops, never sends, when an env file to redact with cannot be read', async () => {
    collectClaude(ledger, projects, 'anthropic');
    const r = await syncOnce(ledger, { ...cfg, redactEnvFiles: [root] }, deps, { force: true });  // a directory: unreadable as a file
    expect(r).toMatchObject({ status: 'retry', sent: 0 });
    expect(r.error).toMatch(/redact env file/);
    expect((await query(`SELECT count(*)::int n FROM archive_messages`)).rows[0].n).toBe(0);
  });

  it('a later copy that names the provider fills it in without lowering token counts', async () => {
    collectClaude(ledger, projects, 'anthropic');
    await query(`INSERT INTO usage_calls (source, host, call_id, session_external_id, ts, model, is_sidechain, input_tokens,
      cache_write_tokens, cache_read_tokens, output_tokens, thinking_tokens, web_search_requests)
      VALUES ('claude-code', 'test-box', 'msg_1', 's1', now(), 'claude-opus-5-5', false, 3, 100, 50, 99, 9, 0)`);
    await syncOnce(ledger, cfg, deps, { force: true });
    const c = await query(`SELECT provider, output_tokens, thinking_tokens FROM usage_calls`);
    expect(c.rows).toEqual([{ provider: 'anthropic', output_tokens: 99, thinking_tokens: 9 }]);
  });

  it('refuses unknown hosts unless asked to register them', async () => {
    await expect(addDevice('nowhere')).rejects.toThrow(/unknown host/);
    expect(existsSync(root)).toBe(true);
  });
});
