import { describe, it, expect, beforeEach } from 'vitest';
import { appendFileSync, copyFileSync, renameSync, mkdirSync, mkdtempSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { query, dbStats, resetDbStats } from '../src/db.js';
import { runArchive, walk, type RunDeps } from '../src/archive/run.js';
import { truncateAll } from './helpers.js';

const PREFIX = '-Users-k-Documents-secondbrain';
const L = (o: unknown) => JSON.stringify(o) + '\n';

function hermesDb(path: string, msgs: number): void {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, source TEXT, model TEXT, started_at REAL NOT NULL, ended_at REAL,
    message_count INTEGER, title TEXT); CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT, role TEXT, content TEXT, timestamp REAL NOT NULL);`);
  db.exec(`INSERT OR IGNORE INTO sessions VALUES ('h1','cli','m',1790000000,NULL,${msgs},'t')`);
  for (let i = 0; i < msgs; i++) db.prepare(`INSERT INTO messages (session_id, role, content, timestamp) VALUES ('h1','user',?,?)`).run(`m${i}`, 1790000000 + i);
  db.close();
}

let root: string; let uploads: string[][]; let deps: RunDeps; let dropletFails: boolean; let uploadFails: boolean;

beforeEach(async () => {
  await truncateAll();
  root = mkdtempSync(join(tmpdir(), 'arch-'));
  const proj = join(root, 'claude', PREFIX);
  mkdirSync(join(proj, 'S1', 'subagents'), { recursive: true });
  mkdirSync(join(proj, 'memory'), { recursive: true });
  mkdirSync(join(root, 'claude', '-Users-k-other'), { recursive: true });
  writeFileSync(join(root, 'claude', '-Users-k-other', 'X.jsonl'), L({ type: 'user', uuid: 'x' }));
  writeFileSync(join(proj, 'S1.jsonl'), L({ type: 'user', uuid: 'u1', sessionId: 'S1', timestamp: '2026-09-28T01:00:00Z', message: { content: 'hi' } }));
  writeFileSync(join(proj, 'S1', 'subagents', 'agent-a1.jsonl'), L({ type: 'assistant', uuid: 'a1', isSidechain: true, timestamp: '2026-09-28T01:00:01Z', message: { content: 'sub' } }));
  writeFileSync(join(proj, 'memory', 'MEMORY.md'), '- index');
  const hh = join(root, 'hermes');
  for (const d of ['logs', 'memories', 'sessions', 'pastes']) mkdirSync(join(hh, d), { recursive: true });
  hermesDb(join(hh, 'state.db'), 2);
  writeFileSync(join(hh, 'logs', 'agent.log'), '2026-09-27 12:00:01 INFO a\n');
  writeFileSync(join(hh, 'memories', 'MEMORY.md'), 'hermes mem');
  writeFileSync(join(hh, 'memories', 'MEMORY.md.lock'), '');
  writeFileSync(join(hh, 'sessions', 'request_dump_1.json'), '{}');
  writeFileSync(join(hh, 'pastes', 'p1.txt'), 'paste');
  uploads = []; dropletFails = false; uploadFails = false;
  deps = {
    paths: { claudeProjectsDir: join(root, 'claude'), claudePrefix: PREFIX, hermesHome: hh, stateDir: join(root, 'state') },
    now: () => new Date('2026-09-30T01:02:03Z'),
    log: () => {},
    snapshotSqlite: async (src, dest) => { mkdirSync(join(dest, '..'), { recursive: true }); copyFileSync(src, dest); },
    pullDroplet: async (dest) => {
      if (dropletFails) throw new Error('ssh: connect timed out');
      mkdirSync(join(dest, 'logs'), { recursive: true }); mkdirSync(join(dest, 'memories'), { recursive: true }); mkdirSync(join(dest, 'sessions'), { recursive: true });
      hermesDb(join(dest, 'state.db'), 1);
      writeFileSync(join(dest, 'logs', 'agent.log'), '2026-09-27 12:00:01 INFO droplet\n');
    },
    upload: async (outbox) => {
      if (uploadFails) throw new Error('b2 down');
      const files: string[] = [];
      const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name)) : files.push(join(d, e.name).slice(outbox.length + 1)); };
      walk(outbox); uploads.push(files.sort());
    },
  };
});

const count = async (t: string) => (await query<{ n: number }>(`SELECT count(*)::int n FROM ${t}`)).rows[0]!.n;

describe('runArchive', () => {
  it('archives a second Hermes home as hermes:user, skipping the sessions the main home already has', async () => {
    const uh = join(root, 'user-hermes');
    mkdirSync(uh, { recursive: true });
    hermesDb(join(uh, 'state.db'), 2); // h1: the same session the main home holds
    const db = new DatabaseSync(join(uh, 'state.db'));
    db.exec(`INSERT INTO sessions VALUES ('h9','cli','m',1790000500,NULL,1,'only here')`);
    db.prepare(`INSERT INTO messages (session_id, role, content, timestamp) VALUES ('h9','user','hello',1790000501)`).run();
    db.close();
    deps.paths.hermesUserHome = uh;
    const s = (await runArchive(deps))!;
    expect(s.errors).toEqual([]);
    const { rows } = await query(`SELECT source, host, external_id, harness, profile FROM archive_sessions WHERE harness='hermes' ORDER BY source, host, external_id`);
    expect(rows).toEqual([
      { source: 'hermes', host: 'droplet', external_id: 'h1', harness: 'hermes', profile: 'main' },
      { source: 'hermes', host: 'mac', external_id: 'h1', harness: 'hermes', profile: 'main' },
      { source: 'hermes:user', host: 'mac', external_id: 'h9', harness: 'hermes', profile: 'user' },
    ]);
    expect(uploads[0]).toContain('archives/hermes/mac-user/state/2026-09-30.sqlite.gz');
  });

  it('reads the Hermes plugin\'s per-request calls from both Mac homes', async () => {
    const uh = join(root, 'user-hermes');
    mkdirSync(join(uh, 'usage'), { recursive: true });
    hermesDb(join(uh, 'state.db'), 1);
    mkdirSync(join(deps.paths.hermesHome, 'usage'), { recursive: true });
    const line = (sid: string, req: string) => JSON.stringify({ v: 1, kind: 'main', ts: '2026-09-30T10:00:00+00:00', session_id: sid,
      api_request_id: req, provider: 'openrouter', model: 'm', input: 5, output: 1, cache_read: 0, cache_write: 0, reasoning: 0 }) + '\n';
    writeFileSync(join(deps.paths.hermesHome, 'usage', 'calls-2026-09-30.jsonl'), line('h1', 'r-vault'));
    writeFileSync(join(uh, 'usage', 'calls-2026-09-30.jsonl'), line('h9', 'r-user'));
    deps.paths.hermesUserHome = uh;
    const s = (await runArchive(deps))!;
    expect(s.hermesCalls).toBe(2);
    const { rows } = await query(`SELECT source, host, call_id FROM usage_calls ORDER BY call_id`);
    expect(rows).toEqual([{ source: 'hermes:user', host: 'mac', call_id: 'r-user' }, { source: 'hermes', host: 'mac', call_id: 'r-vault' }]);
  });

  it('ignores a user home that is the main home', async () => {
    deps.paths.hermesUserHome = deps.paths.hermesHome;
    const s = (await runArchive(deps))!;
    expect(s.errors).toEqual([]);
    expect((await query(`SELECT count(*)::int n FROM archive_sessions WHERE source='hermes:user'`)).rows[0]!.n).toBe(0);
  });

  it('redacts rows added since its last run with this machine\'s env values', async () => {
    process.env.RUN_TEST_TOKEN = 'run-secret-value-424242';
    const { resetRedactor } = await import('../src/archive/redact.js');
    resetRedactor();
    try {
      expect((await runArchive(deps))!.redacted).toEqual({ messages: 0, sessions: 0 });
      // A row that arrived from elsewhere (another machine's push), unredacted.
      const sid = (await query<{ id: number }>(`SELECT id FROM archive_sessions LIMIT 1`)).rows[0]!.id;
      await query(`INSERT INTO archive_messages (session_id, seq, external_id, role, kind, content_text, raw, raw_sha)
        VALUES ($1, 99, 'pushed', 'user', 'user', 'token run-secret-value-424242', '{"t":"run-secret-value-424242"}', 'x')`, [sid]);
      const s = (await runArchive(deps))!;
      expect(s.redacted).toEqual({ messages: 1, sessions: 0 });
      const { rows } = await query(`SELECT content_text, raw FROM archive_messages WHERE external_id='pushed'`);
      expect(rows[0]).toEqual({ content_text: 'token [redacted:RUN_TEST_TOKEN]', raw: { t: '[redacted:RUN_TEST_TOKEN]' } });
    } finally {
      delete process.env.RUN_TEST_TOKEN;
      resetRedactor();
    }
  });

  it('archives everything once, then nothing on a re-run', async () => {
    const s = (await runArchive(deps))!;
    expect(s.errors).toEqual([]);
    expect(s.droplet).toBe('ok');
    const up = uploads[0]!;
    expect(up).toContain(`archives/claude-code/${PREFIX}/2026-09-28_S1.jsonl.gz`);
    expect(up).toContain(`archives/claude-code/${PREFIX}/2026-09-28_S1/subagents/agent-a1.jsonl.gz`);
    expect(up).toContain('archives/claude-memory/20260930T010203Z/MEMORY.md.gz');
    expect(up).toContain('archives/hermes/mac/state/2026-09-30.sqlite.gz');
    expect(up).toContain('archives/hermes/droplet/state/2026-09-30.sqlite.gz');
    expect(up).toContain('archives/hermes/mac/logs/2026-09-30/agent.log.gz');
    expect(up).toContain('archives/hermes/mac/memories/20260930T010203Z/MEMORY.md.gz');
    expect(up).toContain('archives/hermes/mac/request-dumps/request_dump_1.json.gz');
    expect(up).toContain('archives/hermes/mac/pastes/p1.txt.gz');
    expect(up.some((f) => f.includes('other') || f.endsWith('.lock.gz'))).toBe(false);
    expect(await count('archive_sessions')).toBe(4); // S1, agent-a1, hermes mac h1, hermes droplet h1
    expect(await count('archive_messages')).toBe(5); // 1 + 1 + 2 + 1
    expect(await count('archive_log_lines')).toBe(2);
    expect(await count('archive_memory_versions')).toBe(2);
    const sub = await query(`SELECT parent_external_id FROM archive_sessions WHERE external_id='agent-a1'`);
    expect(sub.rows[0]!.parent_external_id).toBe('S1');
    expect(existsSync(join(root, 'state', 'outbox', 'archives'))).toBe(false);

    resetDbStats();
    const again = (await runArchive(deps))!;
    for (const t of ['archive_files', 'archive_messages', 'archive_log_lines', 'archive_memory_versions'])
      expect(dbStats.writesByTable[t] ?? 0, t).toBe(0);
    expect(uploads).toHaveLength(1); // nothing staged, upload not called
    expect(again.staged).toBe(0);
    for (const v of Object.values(again.ingested)) expect(v.messages + v.logLines + v.memoryVersions).toBe(0);
  });

  it('ingests only appended transcript lines', async () => {
    await runArchive(deps);
    appendFileSync(join(root, 'claude', PREFIX, 'S1.jsonl'), L({ type: 'assistant', uuid: 'a2', timestamp: '2026-09-28T01:05:00Z', message: { content: 'more' } }));
    const s = (await runArchive(deps))!;
    expect(s.ingested['claude-code']!.messages).toBe(1);
    const r = await query(`SELECT seq FROM archive_messages WHERE external_id='a2'`);
    expect(r.rows[0]!.seq).toBe(2);
  });

  it('re-reads a rotated log', async () => {
    await runArchive(deps);
    writeFileSync(join(root, 'hermes', 'logs', 'agent.log'), '2026-09-28 00:00:00 INFO new file\n');
    const s = (await runArchive(deps))!;
    expect(s.ingested['hermes-logs']!.logLines).toBe(1);
    expect(await count('archive_log_lines')).toBe(3);
  });

  it('continues when droplet pull fails', async () => {
    dropletFails = true;
    const s = (await runArchive(deps))!;
    expect(s.droplet).toBe('skipped');
    expect(await count('archive_sessions')).toBe(3);
  });

  it('retries upload after failure', async () => {
    uploadFails = true;
    const s1 = (await runArchive(deps))!;
    expect(s1.uploadError).toContain('b2 down');
    expect(await count('archive_messages')).toBe(5); // ingest still ran
    uploadFails = false;
    const s2 = (await runArchive(deps))!;
    expect(s2.uploaded).toBeGreaterThan(0);
    expect(uploads[0]).toContain(`archives/claude-code/${PREFIX}/2026-09-28_S1.jsonl.gz`);
  });

  it('returns null while another run holds the lock', async () => {
    mkdirSync(join(root, 'state', 'lock'), { recursive: true });
    writeFileSync(join(root, 'state', 'lock', 'pid'), String(process.pid));
    expect(await runArchive(deps)).toBeNull();
  });

  it('records a vanished file as an error and keeps going', async () => {
    const gone = join(root, 'claude', PREFIX, 'S2.jsonl');
    writeFileSync(gone, L({ type: 'user', uuid: 'u2', sessionId: 'S2', timestamp: '2026-09-28T02:00:00Z', message: { content: 'x' } }));
    const snap = deps.snapshotSqlite;
    deps.snapshotSqlite = async (a, b) => { rmSync(gone); await snap(a, b); };
    const s = (await runArchive(deps))!;
    expect(s.errors.some((e) => e.includes('S2.jsonl'))).toBe(true);
    expect(await count('archive_messages')).toBe(5);
  });

  it('still archives mac hermes files when the snapshot fails', async () => {
    deps.snapshotSqlite = async () => { throw new Error('python3 missing'); };
    const s = (await runArchive(deps))!;
    expect(s.errors.some((e) => e.includes('python3 missing'))).toBe(true);
    expect(uploads[0]).toContain('archives/hermes/mac/logs/2026-09-30/agent.log.gz');
    expect(uploads[0]).toContain('archives/hermes/mac/pastes/p1.txt.gz');
    expect(uploads[0]).not.toContain('archives/hermes/mac/state/2026-09-30.sqlite.gz');
  });

  it('never moves the canonical key when a file shrinks', async () => {
    const canon = `archives/claude-code/${PREFIX}/2026-09-28_S1.jsonl.gz`;
    const f = join(root, 'claude', PREFIX, 'S1.jsonl');
    const line = (u: string) => L({ type: 'user', uuid: u, timestamp: '2026-09-28T01:00:00Z', message: { content: 'hello there' } });
    writeFileSync(f, line('a') + line('b') + line('c'));
    await runArchive(deps);
    const path = async () => (await query(`SELECT b2_path p FROM archive_files WHERE local_path=$1`, [f])).rows[0]!.p;
    expect(await path()).toBe(canon);
    writeFileSync(f, line('a'));
    await runArchive(deps);
    expect(uploads[1]!.some((k) => k.includes('.truncated-'))).toBe(true);
    expect(await path()).toBe(canon);
    writeFileSync(f, line('a') + line('b'));
    await runArchive(deps);
    expect(uploads[2]!.some((k) => k.includes('.truncated-'))).toBe(true);
    expect(uploads[2]).not.toContain(canon);
    expect(await path()).toBe(canon);
  });

  it('dry run has no side effects', async () => {
    let called = 0;
    deps.snapshotSqlite = async () => { called++; };
    deps.pullDroplet = async () => { called++; };
    const s = (await runArchive(deps, { dryRun: true }))!;
    expect(called).toBe(0);
    expect(s.staged).toBe(0);
    expect(await count('archive_files')).toBe(0);
  });

  it('ingests and uploads the tail of a log rotated to .1', async () => {
    await runArchive(deps);
    const logs = join(deps.paths.hermesHome, 'logs');
    appendFileSync(join(logs, 'agent.log'), '2026-09-29 10:00:00 INFO tail-of-old\n');
    renameSync(join(logs, 'agent.log'), join(logs, 'agent.log.1'));
    writeFileSync(join(logs, 'agent.log'), '2026-09-30 00:30:00 INFO first-of-new\n');
    uploads = [];
    const s = (await runArchive(deps))!;
    expect(s.errors).toEqual([]);
    const msgs = (await query<{ message: string }>(`SELECT message FROM archive_log_lines WHERE host='mac' ORDER BY message`)).rows.map((r) => r.message);
    expect(msgs).toEqual(['2026-09-27 12:00:01 INFO a', '2026-09-29 10:00:00 INFO tail-of-old', '2026-09-30 00:30:00 INFO first-of-new']);
    expect(uploads[0]).toContain('archives/hermes/mac/logs/2026-09-30/agent.log.1.gz');
    await runArchive(deps);
    expect(await count('archive_log_lines')).toBe(4); // + droplet line, no duplicates
  });

  it('walk skips a directory that does not exist', () => {
    expect(walk(join(root, 'nope'))).toEqual([]);
  });

  it('reports hermes messages whose session is missing', async () => {
    const db = new DatabaseSync(join(deps.paths.hermesHome, 'state.db'));
    db.exec(`INSERT INTO messages (session_id, role, content, timestamp) VALUES ('ghost','user','x',1790000100),('ghost','user','y',1790000101)`);
    db.close();
    const s = (await runArchive(deps, { droplet: false }))!;
    expect(s.errors).toContain('hermes mac: 2 messages with unknown session skipped');
  });
});
