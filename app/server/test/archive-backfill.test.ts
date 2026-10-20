import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { query } from '../src/db.js';
import { backfillSteps, redactExisting } from '../src/archive/backfill.js';
import { resetRedactor } from '../src/archive/redact.js';
import { truncateAll } from './helpers.js';

const log = () => {};
const fakeGithub = 'ghp_' + 'Z'.repeat(36);

async function seed(): Promise<number> {
  const s = await query<{ id: number }>(`INSERT INTO archive_sessions (source, host, external_id, title, meta)
    VALUES ('claude-code','mac','s1','uses backfill-secret-value-7','{"note":"backfill-secret-value-7"}') RETURNING id`);
  const id = s.rows[0]!.id;
  const rows: Array<[number, string, string, unknown]> = [
    [1, 'user', 'fix it', { type: 'user', message: { content: 'fix it' } }],
    [2, 'assistant', '[tool_use Bash] {}', { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: `export T=${fakeGithub}` } }] } }],
    [3, 'user', 'key backfill-secret-value-7', { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'key backfill-secret-value-7' }] } }],
  ];
  for (const [seq, role, text, raw] of rows) {
    await query(`INSERT INTO archive_messages (session_id, seq, external_id, role, kind, content_text, raw, raw_sha)
      VALUES ($1,$2,$3,$4,$4,$5,$6::jsonb,'x')`, [id, seq, `m${seq}`, role, text, JSON.stringify(raw)]);
  }
  return id;
}

describe('archive backfill', () => {
  beforeEach(async () => { await truncateAll(); process.env.BACKFILL_TEST_TOKEN = 'backfill-secret-value-7'; resetRedactor(); });
  afterEach(() => { delete process.env.BACKFILL_TEST_TOKEN; resetRedactor(); });

  it('fills the step columns of legacy rows, in batches, and is a no-op the second time', async () => {
    await seed();
    expect(await backfillSteps({ batch: 2, log })).toEqual({ rows: 3 });
    const { rows } = await query(`SELECT seq, step, tool_names, tool_call_id, is_error FROM archive_messages ORDER BY seq`);
    expect(rows).toEqual([
      { seq: 1, step: 'prompt', tool_names: null, tool_call_id: null, is_error: null },
      { seq: 2, step: 'tool_call', tool_names: ['Bash'], tool_call_id: 't1', is_error: null },
      { seq: 3, step: 'tool_result', tool_names: null, tool_call_id: 't1', is_error: true },
    ]);
    expect(await backfillSteps({ batch: 2, log })).toEqual({ rows: 0 });
  });

  it('dry run counts the rows holding keys and writes nothing', async () => {
    await seed();
    const r = await redactExisting({ batch: 1, dryRun: true, log });
    expect(r).toMatchObject({ changed: 2, sessions: 1 });
    const { rows } = await query(`SELECT count(*)::int n FROM archive_messages WHERE raw::text LIKE '%backfill-secret-value-7%' OR raw::text LIKE '%ghp_%'`);
    expect(rows[0]!.n).toBe(2);
  });

  it('rewrites only the rows holding a key, in text, raw, title and meta', async () => {
    await seed();
    const r = await redactExisting({ batch: 1, dryRun: false, log });
    expect(r).toMatchObject({ changed: 2, sessions: 1 });
    const { rows } = await query<{ seq: number; content_text: string; raw: unknown }>(`SELECT seq, content_text, raw FROM archive_messages ORDER BY seq`);
    expect(rows[0]!.content_text).toBe('fix it');
    expect(JSON.stringify(rows[1]!.raw)).toContain('[redacted:github]');
    expect(rows[2]!.content_text).toBe('key [redacted:BACKFILL_TEST_TOKEN]');
    expect(JSON.stringify(rows[2]!.raw)).not.toContain('backfill-secret-value-7');
    const s = (await query(`SELECT title, meta FROM archive_sessions`)).rows[0]!;
    expect(s).toEqual({ title: 'uses [redacted:BACKFILL_TEST_TOKEN]', meta: { note: '[redacted:BACKFILL_TEST_TOKEN]' } });
    expect(await redactExisting({ batch: 1, dryRun: false, log })).toMatchObject({ changed: 0, sessions: 0 });
  });
});
