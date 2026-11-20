import { describe, it, expect, beforeAll } from 'vitest';
import { query } from '../src/db.js';
import { truncateAll } from './helpers.js';

describe('archive schema', () => {
  beforeAll(truncateAll);

  it('creates the archive tables with their intended relation types', async () => {
    const { rows } = await query<{ table_name: string; table_type: string }>(
      `SELECT table_name, table_type FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'archive_%'`,
    );
    expect(rows.sort((a, b) => a.table_name < b.table_name ? -1 : a.table_name > b.table_name ? 1 : 0)).toEqual([
      'archive_files', 'archive_log_lines', 'archive_memory_versions', 'archive_messages', 'archive_session_tasks', 'archive_sessions',
    ].sort().map(table_name => ({ table_name, table_type: 'BASE TABLE' })));
  });

  it('builds a search vector from content_text', async () => {
    const s = await query<{ id: number }>(
      `INSERT INTO archive_sessions (source, host, external_id) VALUES ('claude-code','mac','s1') RETURNING id`,
    );
    await query(
      `INSERT INTO archive_messages (session_id, seq, external_id, role, kind, content_text, raw, raw_sha)
       VALUES ($1, 1, 'u1', 'user', 'user', 'backblaze encrypted archive', '{}', 'x')`,
      [s.rows[0]!.id],
    );
    const { rows } = await query(`SELECT 1 FROM archive_messages WHERE tsv @@ plainto_tsquery('simple','backblaze')`);
    expect(rows).toHaveLength(1);
  });
});
