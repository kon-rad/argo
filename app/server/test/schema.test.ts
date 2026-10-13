import { describe, it, expect, beforeAll } from 'vitest';
import { query } from '../src/db.js';
import { truncateAll } from './helpers.js';

describe('schema', () => {
  beforeAll(truncateAll);

  it('creates every table and the search view', async () => {
    const { rows } = await query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public'`,
    );
    const names = rows.map((r) => r.table_name);
    for (const t of [
      'sources', 'ingest_runs', 'vault_files', 'vault_links', 'vault_tags',
      'discord_guilds', 'discord_channels', 'discord_authors', 'discord_messages',
      'discord_message_versions', 'discord_attachments', 'discord_embeds',
      'discord_reactions', 'search_documents',
    ]) {
      expect(names, `missing ${t}`).toContain(t);
    }
  });

  it('stores snowflake ids as text, never bigint', async () => {
    const { rows } = await query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name IN ('discord_messages','discord_channels','discord_authors','discord_guilds')
         AND column_name IN ('id','channel_id','author_id','guild_id','reply_to_id','thread_id')`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.data_type, r.column_name).toBe('text');
  });

  it('seeds exactly one vault source with a skip list', async () => {
    const { rows } = await query<{ config: { skip_dirs: string[] } }>(
      `SELECT config FROM sources WHERE kind='vault'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.config.skip_dirs).toContain('node_modules');
  });

  it('generates a searchable tsv on vault_files', async () => {
    await query(
      `INSERT INTO vault_files (path,parent_path,name,title,ext,is_markdown,size_bytes,mtime,content_hash,body)
       VALUES ('a.md','','a.md','Alpha','.md',true,1,now(),'h','the quick brown fox')`,
    );
    const { rows } = await query<{ ok: boolean }>(
      `SELECT tsv @@ websearch_to_tsquery('english','quick fox') AS ok FROM vault_files WHERE path='a.md'`,
    );
    expect(rows[0]!.ok).toBe(true);
  });

  it('weights the title above the body', async () => {
    const { rows } = await query<{ tsv: string }>(`SELECT tsv::text FROM vault_files WHERE path='a.md'`);
    expect(rows[0]!.tsv).toContain("'alpha':1A");
  });
});
