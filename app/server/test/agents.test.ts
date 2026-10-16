import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { findHomes, outputRunAt, syncAgents } from '../src/agents/sync.js';
import { createApp } from '../src/app.js';
import { query } from '../src/db.js';
import { truncateAll } from './helpers.js';

const STANDUP = 'e857f6518232';
const T0 = 1791700000; // 2026-10-11 ~06:26 UTC

function stateDb(path: string, sessions: { id: string; source: string; origin?: object }[]): void {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, user_id TEXT, chat_id TEXT,
             chat_type TEXT, display_name TEXT, origin_json TEXT, model TEXT, parent_session_id TEXT,
             started_at REAL NOT NULL, ended_at REAL, title TEXT);
           CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
             content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL, reasoning TEXT);`);
  for (const [i, s] of sessions.entries()) {
    db.prepare(`INSERT INTO sessions (id, source, user_id, chat_id, chat_type, display_name, origin_json, model, started_at)
                VALUES (?,?,?,?,?,?,?,?,?)`).run(
      s.id, s.source, '1975564489', '1975564489', s.source === 'telegram' ? 'dm' : null,
      s.source === 'telegram' ? 'Owner' : null, JSON.stringify(s.origin ?? {}), 'opus', T0 + i * 100);
    db.prepare(`INSERT INTO messages (session_id, role, content, timestamp) VALUES (?,?,?,?)`).run(s.id, 'user', `hello ${s.id}`, T0 + i * 100);
    db.prepare(`INSERT INTO messages (session_id, role, content, tool_name, timestamp) VALUES (?,?,?,?,?)`)
      .run(s.id, 'assistant', `reply ${s.id}`, null, T0 + i * 100 + 5);
  }
  db.close();
}

function hermesHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'hermes-'));
  writeFileSync(join(root, 'config.yaml'), 'model: x\ntimezone: Asia/Tokyo\n');
  stateDb(join(root, 'state.db'), [
    { id: '20261011_070000_aaaa', source: 'telegram', origin: { platform: 'telegram', chat_name: 'Owner' } },
    { id: `cron_${STANDUP}_20261011_152154`, source: 'cron' },
  ]);
  mkdirSync(join(root, 'cron', 'output', STANDUP), { recursive: true });
  writeFileSync(join(root, 'cron', 'jobs.json'), JSON.stringify({
    jobs: [
      { id: STANDUP, name: 'daily-stand-up', schedule: { kind: 'cron', expr: '40 6 * * *', display: '40 6 * * *' },
        enabled: true, state: 'scheduled', next_run_at: '2026-10-12T06:40:00+09:00', last_run_at: '2026-10-11T15:26:11+09:00',
        last_status: 'ok', deliver: 'all', skill: 'daily-stand-up', prompt: 'Run the daily stand up.' },
      { id: 'cef40c377af1', name: 'cyberpunk-wearable-reminder', schedule: { kind: 'cron', expr: '17 21 */3 * *' },
        enabled: false, state: 'paused', last_status: 'ok' },
    ],
  }));
  writeFileSync(join(root, 'cron', 'output', STANDUP, '2026-10-11_15-26-10.md'), '# Stand-up\n\nShipped Ring and Wallets.');
  writeFileSync(join(root, 'cron', 'output', STANDUP, '2026-10-10_06-41-00.md'), '# Stand-up\n\nYesterday.');
  const ex = new DatabaseSync(join(root, 'cron', 'executions.db'));
  ex.exec(`CREATE TABLE executions (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, source TEXT NOT NULL, process_id TEXT NOT NULL,
             pid INTEGER NOT NULL, process_started_at INTEGER, status TEXT NOT NULL, claimed_at TEXT NOT NULL,
             started_at TEXT, finished_at TEXT, error TEXT)`);
  ex.prepare(`INSERT INTO executions VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run('ex1', STANDUP, 'direct', 'p', 1, 1, 'completed',
    '2026-10-11T15:21:51+09:00', '2026-10-11T15:21:51+09:00', '2026-10-11T15:26:11+09:00', null);
  ex.close();
  // A bot profile with its own Telegram chat.
  const prof = join(root, 'profiles', 'researcher');
  mkdirSync(prof, { recursive: true });
  stateDb(join(prof, 'state.db'), [{ id: '20261011_080000_bbbb', source: 'telegram' }]);
  mkdirSync(join(root, 'profiles', 'empty'), { recursive: true }); // no state.db, no cron: skipped
  return root;
}

const timers = async () => ({ available: true, timers: [{ unit: 'ring-ingest.timer', activates: 'x', next: null, last: null }] });
const app = createApp({ timers });
let root: string;

beforeEach(async () => {
  await truncateAll();
  root = hermesHome();
});

describe('agents sync', () => {
  it('finds the main home and the profiles that have data', () => {
    expect(findHomes(root).map((h) => h.profile)).toEqual(['main', 'researcher']);
  });

  it('reads output file names as Hermes local time', () => {
    expect(outputRunAt('2026-10-11_07-17-37.md', 'Asia/Tokyo')!.toISOString()).toBe('2026-10-10T22:17:37.000Z');
    expect(outputRunAt('notes.md', 'Asia/Tokyo')).toBeNull();
  });

  it('copies chats, jobs, runs and outputs, and a second run changes nothing', async () => {
    const first = await syncAgents(root, 'droplet');
    expect(first.errors).toEqual([]);
    expect(first).toMatchObject({ homes: 2, sessions: 3, messages: 6, jobs: 2, runs: 1, outputs: 2, usage: 3 });
    const second = await syncAgents(root, 'droplet');
    expect(second).toMatchObject({ sessions: 0, messages: 0, jobs: 0, runs: 0, outputs: 0 });
    const runsLogged = await query<{ n: number }>(`SELECT count(*)::int AS n FROM agents_sync_runs`);
    expect(runsLogged.rows[0]!.n).toBe(2);
  });

  it('keeps a job that disappears from jobs.json, marked removed', async () => {
    await syncAgents(root, 'droplet');
    writeFileSync(join(root, 'cron', 'jobs.json'), JSON.stringify({ jobs: [] }));
    await syncAgents(root, 'droplet');
    const r = await query<{ n: number }>(`SELECT count(*)::int AS n FROM cron_jobs WHERE removed_at IS NOT NULL`);
    expect(r.rows[0]!.n).toBe(2);
  });
});

describe('/api/agents', () => {
  beforeEach(async () => {
    await syncAgents(root, 'droplet');
  });

  it('lists Telegram chats from every profile with platform, profile and timezone', async () => {
    const res = await request(app).get('/api/agents/chats?platform=telegram');
    expect(res.status).toBe(200);
    expect(res.body.sessions.map((s: { profile: string }) => s.profile).sort()).toEqual(['main', 'researcher']);
    expect(res.body.sessions[0]).toMatchObject({ platform: 'telegram', chat_type: 'dm', timezone: 'Asia/Tokyo' });
    expect(res.body.last_sync.host).toBe('droplet');
    const cron = await request(app).get('/api/agents/chats?platform=cron');
    expect(cron.body.sessions).toHaveLength(1);
  });

  it('returns a chat with its messages in order', async () => {
    const list = await request(app).get('/api/agents/chats?platform=telegram&profile=main');
    const res = await request(app).get(`/api/agents/chats/${list.body.sessions[0].id}`);
    expect(res.body.messages.map((m: { role: string; content: string }) => [m.role, m.content])).toEqual([
      ['user', 'hello 20261011_070000_aaaa'],
      ['assistant', 'reply 20261011_070000_aaaa'],
    ]);
    expect((await request(app).get('/api/agents/chats/999999')).status).toBe(404);
  });

  it('lists cron jobs, scheduled first, with run and output counts', async () => {
    const res = await request(app).get('/api/agents/cron/jobs');
    expect(res.body.jobs.map((j: { name: string }) => j.name)).toEqual(['daily-stand-up', 'cyberpunk-wearable-reminder']);
    expect(res.body.jobs[0]).toMatchObject({ state: 'scheduled', schedule: '40 6 * * *', runs: 1, outputs: 2 });
    expect(res.body.jobs[1]).toMatchObject({ state: 'paused', enabled: false });
  });

  it('shows every past stand-up: runs, outputs newest first, transcripts, and one output in full', async () => {
    const res = await request(app).get(`/api/agents/cron/jobs/main/${STANDUP}`);
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.outputs.map((o: { file_name: string }) => o.file_name)).toEqual(['2026-10-11_15-26-10.md', '2026-10-10_06-41-00.md']);
    expect(res.body.sessions.map((s: { external_id: string }) => s.external_id)).toEqual([`cron_${STANDUP}_20261011_152154`]);
    const out = await request(app).get(`/api/agents/cron/jobs/main/${STANDUP}/outputs/2026-10-11_15-26-10.md`);
    expect(out.body.content).toContain('Shipped Ring and Wallets');
    expect((await request(app).get(`/api/agents/cron/jobs/main/nope`)).status).toBe(404);
  });

  it('passes systemd timers through', async () => {
    const res = await request(app).get('/api/agents/cron/timers');
    expect(res.body).toMatchObject({ available: true, timers: [{ unit: 'ring-ingest.timer' }] });
  });

  it('needs a session on the server', async () => {
    const server = createApp({
      deployment: 'server',
      auth: { passwordHash: 'x', totpSecret: 'JBSWY3DPEHPK3PXP', publicOrigin: 'https://example.test' },
      timers,
    });
    expect((await request(server).get('/api/agents/chats')).status).toBe(401);
    expect((await request(server).get('/api/agents/cron/jobs')).status).toBe(401);
  });
});
