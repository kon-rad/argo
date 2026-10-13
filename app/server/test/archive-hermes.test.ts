import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readHermes } from '../src/archive/hermes.js';

let dbPath: string;

function build(withCost: boolean): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, model TEXT, parent_session_id TEXT,
    started_at REAL NOT NULL, ended_at REAL, message_count INTEGER, input_tokens INTEGER, output_tokens INTEGER,
    cwd TEXT, title TEXT, system_prompt TEXT ${withCost ? ', estimated_cost_usd REAL' : ''});
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
    content TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL, reasoning TEXT);`);
  db.prepare(`INSERT INTO sessions (id, source, model, started_at, ended_at, message_count, input_tokens, output_tokens, cwd, title, system_prompt${withCost ? ', estimated_cost_usd' : ''})
    VALUES ('h1','telegram','deepseek-v4-flash', 1790000000, 1790000100, 2, 10, 20, '/home/agent', 'Stand-up', 'big prompt'${withCost ? ', 0.5' : ''})`).run();
  db.prepare(`INSERT INTO messages (session_id, role, content, timestamp) VALUES ('h1','user','run my stand-up', 1790000001)`).run();
  db.prepare(`INSERT INTO messages (session_id, role, content, tool_calls, timestamp, reasoning)
    VALUES ('h1','assistant','done', '[{"name":"terminal"}]', 1790000002, 'think')`).run();
  db.close();
}

describe('readHermes', () => {
  beforeEach(() => { dbPath = join(mkdtempSync(join(tmpdir(), 'hermes-')), 'state.db'); });

  it('maps sessions and messages', () => {
    build(true);
    const { sessions, messages } = readHermes(dbPath, 'droplet');
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s).toMatchObject({ source: 'hermes', host: 'droplet', externalId: 'h1', title: 'Stand-up', model: 'deepseek-v4-flash',
      project: '/home/agent', messageCount: 2, inputTokens: 10, outputTokens: 20, costUsd: 0.5 });
    expect(s.startedAt?.toISOString()).toBe(new Date(1790000000 * 1000).toISOString());
    expect(s.meta.source).toBe('telegram');
    expect(messages.map((m) => [m.seq, m.externalId, m.role, m.sessionExternalId])).toEqual([
      [1, 'msg:1', 'user', 'h1'], [2, 'msg:2', 'assistant', 'h1'],
    ]);
    expect(messages[1]!.contentText).toContain('done');
    expect(messages[1]!.contentText).toContain('[reasoning] think');
    expect(messages[1]!.contentText).toContain('terminal');
  });

  it('tolerates missing optional columns', () => {
    build(false);
    expect(readHermes(dbPath, 'mac').sessions[0]!.costUsd).toBeNull();
  });
});
