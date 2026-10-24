import { query } from '../src/db.js';
import { MODULE_NAMES } from '../src/config.js';

/** Truncates every data table between tests. Migrations stay applied. */
export async function truncateAll(): Promise<void> {
  await query(`TRUNCATE vault_files, vault_links, vault_tags, vault_chunks,
               discord_reactions, discord_embeds, discord_attachments,
               discord_message_versions, discord_messages, discord_authors,
               discord_channels, discord_guilds, archive_messages, archive_sessions,
               archive_log_lines, archive_memory_versions, archive_files, ingest_runs,
               auth_sessions, auth_totp_state,
               ring_raw, ring_daily, ring_samples, ring_sleep_stages, wallets,
               cron_jobs, cron_runs, cron_outputs, agents_sync_runs,
               livestream_sessions, livestream_viewer_samples, livestream_x_broadcasts, livestream_notices,
               memory_facts, org_approvals, board_tokens, card_runs, card_events, card_comments, card_deps, cards, boards, org_wakeups, org_reads, org_messages, org_channel_members, org_channels, org_agents,
               verifications, stage_changes, features, projects, teams, divisions,
               ingest_batches, ingest_devices, llm_exchanges, llm_blobs,
               usage_calls, usage_runs, plan_usage_snapshots, hermes_usage_snapshots, usage_files, provider_credit_snapshots,
               metric_samples, map_edges, map_nodes, map_layouts,
               social_post_media, social_posts, social_accounts,
               chat_messages, chat_conversations, chat_settings, classify_decisions
               RESTART IDENTITY CASCADE`);
}

export async function vaultSourceId(): Promise<number> {
  const { rows } = await query<{ id: number }>(`SELECT id FROM sources WHERE kind='vault' LIMIT 1`);
  if (!rows[0]) throw new Error('vault source not seeded');
  return rows[0].id;
}

/** Every optional module on: feature tests exercise routes a default install doesn't mount. */
export const ALL_MODULES = new Set(MODULE_NAMES);
