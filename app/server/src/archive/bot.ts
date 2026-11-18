import { query, type TxClient } from '../db.js';

/**
 * Which roster bot a session a person started talked as (archive_sessions.bot), read from what the harness
 * recorded, at import time:
 *
 *   claude-code  the transcript's `agent-setting` record (`claude --agent <name>`)
 *   codex        the first prompt the person sent (not Codex's own AGENTS.md or environment message),
 *   hermes       the first user message,
 *                both only when the message opens with the compiled persona, "You are **<name>**" (Agent Dock, the
 *                Codex dispatcher's preamble); a Hermes cron session never counts
 *   zen-agent    the trace's `persona`
 *
 * A subagent (or a Hermes compression continuation) takes its parent's bot. A name that is not a bot in
 * `org_agents` is never stored (the column's foreign key enforces it too); a session with none of these stays
 * unattributed. Never guessed from a folder name or a title. A session that already has a bot is not read again.
 */

/**
 * The persona line opening the message: the compiled persona (org-compile.ts) is a `# <name>, <role>` heading,
 * then "You are **<name>**". Anywhere later in the text (a quoted persona, a pasted note) does not count.
 * Postgres ARE; group 1 is the name.
 */
export const PERSONA_LINE_RE = String.raw`^\s*(?:#[^\n]*\n\s*)?You are \*\*([a-z0-9][a-z0-9-]{0,31})\*\*`;
/** Messages Codex writes into the conversation as the user before the person's first prompt. */
export const INJECTED_PROMPT_RE = String.raw`^\s*(<environment_context>|<user_instructions>|<permissions instructions>|# AGENTS\.md instructions)`;

const CANDIDATES = `
  WITH s AS (
    SELECT a.id, a.source, a.host, a.harness, a.parent_external_id, a.meta
      FROM archive_sessions a
     WHERE a.id = ANY ($1::bigint[]) AND a.bot IS NULL),
  cand AS (
    SELECT s.id,
      (SELECT p.bot FROM archive_sessions p
        WHERE s.parent_external_id IS NOT NULL AND p.host = s.host AND p.source = s.source
          AND p.external_id = s.parent_external_id AND p.bot IS NOT NULL LIMIT 1) AS parent_bot,
      CASE
        WHEN s.harness = 'zen-agent' THEN nullif(s.meta ->> 'persona', '')
        WHEN s.harness = 'claude-code' THEN
          (SELECT m.raw ->> 'agentSetting' FROM archive_messages m
            WHERE m.session_id = s.id AND m.kind = 'agent-setting' AND m.raw ->> 'agentSetting' IS NOT NULL
            ORDER BY m.seq LIMIT 1)
        WHEN s.harness = 'codex' OR (s.harness = 'hermes' AND coalesce(s.meta ->> 'source', '') <> 'cron') THEN
          (SELECT substring(m.content_text FROM $2) FROM archive_messages m
            WHERE m.session_id = s.id AND m.role = 'user' AND m.content_text <> '' AND m.content_text !~ $3
            ORDER BY m.seq LIMIT 1)
      END AS own
    FROM s)
  UPDATE archive_sessions a SET bot = o.name
    FROM cand JOIN org_agents o ON o.name = coalesce(cand.parent_bot, cand.own) AND o.runtime <> 'human'
   WHERE a.id = cand.id AND a.bot IS NULL
  RETURNING a.id`;

/**
 * Sets the bot on each of these sessions that has none and says who it is. Returns how many were labelled.
 * Two passes, so a subagent stored in the same batch as its parent gets the parent's bot.
 */
export async function attributeBots(tx: TxClient | null, sessionIds: number[]): Promise<number> {
  const ids = [...new Set(sessionIds)];
  if (!ids.length) return 0;
  const run = tx ? tx.query.bind(tx) : query;
  let labelled = 0;
  for (let pass = 0; pass < 2; pass++) {
    const r = await run(CANDIDATES, [ids, PERSONA_LINE_RE, INJECTED_PROMPT_RE]);
    labelled += r.rowCount ?? 0;
    if (!r.rowCount) break;
  }
  return labelled;
}

export interface BotBackfill { scanned: number; labelled: number; zenRuns: number }

/**
 * For sessions imported before the bot was read (`secondbrain usage-backfill --bots`, on the server): every
 * session without a bot, in id order, through the same rule as the import. Also takes the agent off zen-agent
 * runs that no dispatcher started (stored before chats and wakes were told apart): the session's bot labels
 * those now, as an owner chat. Runs with dispatcher labels are not touched. Safe to run again.
 */
export async function backfillBots(batch = 500): Promise<BotBackfill> {
  const zen = await query(
    `UPDATE usage_runs r SET agent_name = NULL
       FROM archive_sessions s
      WHERE r.runtime = 'zen-agent' AND r.agent_name IS NOT NULL
        AND s.source = 'zen-agent' AND s.host = r.host AND s.external_id = r.session_id
        AND coalesce(s.meta -> 'dispatch', '{}'::jsonb) = '{}'::jsonb`);
  const out: BotBackfill = { scanned: 0, labelled: 0, zenRuns: zen.rowCount ?? 0 };
  let last = 0;
  for (;;) {
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM archive_sessions WHERE bot IS NULL AND id > $1 ORDER BY id LIMIT $2`, [last, batch]);
    if (!rows.length) break;
    const ids = rows.map((r) => Number(r.id));
    out.scanned += ids.length;
    out.labelled += await attributeBots(null, ids);
    last = ids[ids.length - 1]!;
  }
  return out;
}
