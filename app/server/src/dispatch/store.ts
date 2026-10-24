import { query } from '../db.js';

/**
 * The dispatcher's reads and the two writes org.ts does not already offer. Plain queries on the owner's
 * connection, like the other dispatcher commands in cli-org (wake-claim, wake-done): the dispatcher is
 * not an agent, so no RLS identity applies.
 */

export interface ZenAgentRow { name: string; team_slug: string | null; role: string; routines: Routine[] }
export interface Routine { name: string; at: string; days?: number[]; task_file: string }
export interface MessageRow {
  id: number; channel_slug: string; thread_id: number | null; author: string; kind: string; body: string;
  created_at: Date; author_human: boolean;
}

/** Claims whose run never reported back (the process died): open them again for the next tick. */
export async function releaseStale(olderThanMinutes: number): Promise<number> {
  const { rowCount } = await query(
    `UPDATE org_wakeups SET claimed_at = NULL, claimed_by = NULL
      WHERE done_at IS NULL AND claimed_at IS NOT NULL AND claimed_at < now() - ($1 * interval '1 minute')`,
    [olderThanMinutes]);
  return rowCount ?? 0;
}

/** Un-claims specific wakeups this tick decided not to run (a second card: one card, one run). */
export async function unclaim(ids: number[]): Promise<void> {
  if (!ids.length) return;
  await query(`UPDATE org_wakeups SET claimed_at = NULL, claimed_by = NULL WHERE id = ANY ($1) AND done_at IS NULL`, [ids]);
}

/** Tokens every bot run spent since local midnight in `tz`: the daily cap's measure. */
export async function tokensToday(tz: string): Promise<number> {
  const { rows } = await query<{ tokens: string }>(
    `SELECT coalesce(sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0)::text AS tokens
       FROM usage_calls
      WHERE source IN ('claude-code', 'zen-agent') AND run_id IS NOT NULL
        AND ts >= (date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1)`, [tz]);
  return Number(rows[0]?.tokens ?? 0);
}

/**
 * The bots this dispatcher runs: roster runtime zen-agent, with something waiting. Bots on claude-code or
 * hermes stay with whatever dispatcher the install already has, so the two never claim the same wakeups.
 */
export async function zenAgentsWithOpenWakeups(): Promise<ZenAgentRow[]> {
  const { rows } = await query<ZenAgentRow>(
    `SELECT a.name, a.team_slug, a.role, a.routines
       FROM org_agents a
      WHERE a.runtime = 'zen-agent' AND a.retired_at IS NULL
        AND EXISTS (SELECT 1 FROM org_wakeups w WHERE w.agent_name = a.name AND w.done_at IS NULL AND w.claimed_at IS NULL)
      ORDER BY a.name`);
  return rows;
}

/** Every bot with routines on the roster, whichever runtime runs it. */
export async function botsWithRoutines(): Promise<ZenAgentRow[]> {
  const { rows } = await query<ZenAgentRow>(
    `SELECT name, team_slug, role, routines FROM org_agents
      WHERE runtime <> 'human' AND retired_at IS NULL AND jsonb_array_length(routines) > 0 ORDER BY name`);
  return rows;
}

export async function agentRow(name: string): Promise<ZenAgentRow | null> {
  const { rows } = await query<ZenAgentRow>(`SELECT name, team_slug, role, routines FROM org_agents WHERE name = $1`, [name]);
  return rows[0] ?? null;
}

export async function isLead(name: string): Promise<boolean> {
  const { rowCount } = await query(`SELECT 1 FROM teams WHERE lead = $1`, [name]);
  return (rowCount ?? 0) > 0;
}

export async function messageById(id: number): Promise<MessageRow | null> {
  const { rows } = await query<MessageRow>(
    `SELECT m.id, m.channel_slug, m.thread_id, m.author, m.kind, m.body, m.created_at,
            coalesce((SELECT a.runtime = 'human' FROM org_agents a WHERE a.name = m.author), false) AS author_human
       FROM org_messages m WHERE m.id = $1`, [id]);
  return rows[0] ?? null;
}

/** The last `n` messages before `m` in its thread (or, outside a thread, in its channel): the gate's context. */
export async function messagesBefore(m: MessageRow, n = 3): Promise<MessageRow[]> {
  const root = m.thread_id;
  const { rows } = await query<MessageRow>(
    root === null
      ? `SELECT id, channel_slug, thread_id, author, kind, body, created_at, false AS author_human
           FROM org_messages WHERE channel_slug = $1 AND id < $2 ORDER BY id DESC LIMIT $3`
      : `SELECT id, channel_slug, thread_id, author, kind, body, created_at, false AS author_human
           FROM org_messages WHERE channel_slug = $1 AND id < $2 AND (id = $4 OR thread_id = $4) ORDER BY id DESC LIMIT $3`,
    root === null ? [m.channel_slug, m.id, n] : [m.channel_slug, m.id, n, root]);
  return rows.reverse();
}

export async function taskLink(taskId: string): Promise<{ title: string; work_type: string | null; project_slug: string | null } | null> {
  const { rows } = await query<{ title: string; work_type: string | null; project_slug: string | null }>(
    `SELECT title, work_type, project_slug FROM task_links WHERE task_id = $1`, [taskId]);
  return rows[0] ?? null;
}

export interface LastRun { run_id: string; task_id: string | null; ended_at: Date | null; subtype: string | null; num_turns: number | null; total_cost_usd: number | null }

/** The agent's most recent zen-agent run, for the handoff part; with `taskId`, its last run on that card. */
export async function lastRun(agent: string, taskId?: string): Promise<LastRun | null> {
  const { rows } = await query<LastRun>(
    `SELECT run_id, task_id, ended_at, subtype, num_turns, total_cost_usd FROM usage_runs
      WHERE agent_name = $1 AND runtime = 'zen-agent' ${taskId ? 'AND task_id = $2' : ''}
      ORDER BY started_at DESC NULLS LAST LIMIT 1`, taskId ? [agent, taskId] : [agent]);
  return rows[0] ?? null;
}

/** The agent's last `held:` status in the past day, so the next run knows what the board parked. */
export async function lastHeld(agent: string): Promise<string | null> {
  const { rows } = await query<{ body: string }>(
    `SELECT body FROM org_messages WHERE author = $1 AND kind = 'status' AND body LIKE 'held:%'
       AND created_at > now() - interval '24 hours' ORDER BY id DESC LIMIT 1`, [agent]);
  return rows[0]?.body ?? null;
}
