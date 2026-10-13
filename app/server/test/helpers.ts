import { query } from '../src/db.js';

/** Truncates every data table between tests. Migrations stay applied. */
export async function truncateAll(): Promise<void> {
  await query(`TRUNCATE vault_files, vault_links, vault_tags, vault_chunks,
               discord_reactions, discord_embeds, discord_attachments,
               discord_message_versions, discord_messages, discord_authors,
               discord_channels, discord_guilds, archive_messages, archive_sessions,
               archive_log_lines, archive_memory_versions, archive_files, ingest_runs,
               auth_sessions, auth_totp_state,
               ring_raw, ring_daily, ring_samples, ring_sleep_stages, wallets,
               cron_jobs, cron_runs, cron_outputs, agents_sync_runs
               RESTART IDENTITY CASCADE`);
}

export async function vaultSourceId(): Promise<number> {
  const { rows } = await query<{ id: number }>(`SELECT id FROM sources WHERE kind='vault' LIMIT 1`);
  if (!rows[0]) throw new Error('vault source not seeded');
  return rows[0].id;
}
