import { query, withTransaction } from '../../db.js';

/**
 * The dispatcher's reads and the two writes org.ts does not already offer. Plain queries on the owner's
 * connection, like the other dispatcher commands in cli-org (wake-claim, wake-done): the dispatcher is
 * not an agent, so no RLS identity applies.
 */

/** `model` is the effective one (override ?? roster); only the wake query fills it. */
export interface ZenAgentRow { name: string; team_slug: string | null; role: string; routines: Routine[]; model?: string | null; runtime?: string }
export interface Routine { name: string; at: string; days?: number[]; task_file: string }
export interface MessageRow {
  id: number; channel_slug: string; thread_id: number | null; author: string; kind: string; body: string;
  created_at: Date; author_human: boolean;
}

/**
 * A run that failed before zen-agent wrote a trace leaves nothing for usage-sync to parse, so /usage never
 * counted it. Insert the failed row here; a later trace sync for the same (host, run_id) overwrites it, and
 * an existing row is left alone.
 */
export async function recordFailedRun(r: {
  runId: string; agent: string; taskId: string | null; wakeupIds: number[]; reasons: unknown; team: string | null;
  startedAt: Date; endedAt: Date; error: string;
}): Promise<boolean> {
  const { rowCount } = await query(
    `INSERT INTO usage_runs (host, run_id, session_id, log_path, task_id, agent_name, team_slug, started_at, ended_at,
       duration_ms, subtype, is_error, reasons, wakeup_ids, runtime, outcome)
     VALUES (COALESCE((SELECT slug FROM usage_hosts WHERE kind = 'server' ORDER BY slug LIMIT 1), 'droplet'),
       $1, $1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10::jsonb, $11::bigint[], 'zen-agent', 'failed')
     ON CONFLICT (host, run_id) DO NOTHING`,
    [r.runId, `dispatch:${r.runId}`, r.taskId, r.agent, r.team, r.startedAt, r.endedAt,
      Math.max(0, r.endedAt.getTime() - r.startedAt.getTime()), r.error.slice(0, 300), JSON.stringify(r.reasons), r.wakeupIds]);
  return (rowCount ?? 0) > 0;
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
      WHERE source IN ('claude-code', 'zen-agent', 'codex') AND run_id IS NOT NULL
        AND ts >= (date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1)`, [tz]);
  return Number(rows[0]?.tokens ?? 0);
}

/**
 * The bots this dispatcher runs: roster runtime zen-agent, with something waiting. Bots on claude-code or
 * hermes stay with whatever dispatcher the install already has, so the two never claim the same wakeups.
 */
export async function zenAgentsWithOpenWakeups(): Promise<ZenAgentRow[]> {
  const { rows } = await query<ZenAgentRow>(
    `SELECT a.name, a.team_slug, a.role, a.routines, e.model, e.runtime
       FROM org_agents a JOIN org_agents_effective e ON e.name = a.name
      WHERE e.runtime IN ('zen-agent', 'codex') AND a.retired_at IS NULL AND NOT e.paused
        AND EXISTS (SELECT 1 FROM org_wakeups w WHERE w.agent_name = a.name AND w.done_at IS NULL AND w.claimed_at IS NULL)
      ORDER BY a.name`);
  return rows;
}

/**
 * Cards that wait on dependencies which have all closed, yet were never promoted: the trigger only fires when a
 * dependency finishes, so a card moved to `todo` (or dependency-blocked) after that, or one whose open dependency was
 * unlinked, waits for ever. Only cards with at least one dependency: a `todo` card with none is someone's backlog.
 */
export async function waitingCardsWithClosedDeps(): Promise<string[]> {
  const { rows } = await query<{ id: string }>(
    `SELECT c.id FROM cards c
      WHERE (c.status = 'todo' OR (c.status = 'blocked' AND c.block_kind = 'dependency'))
        AND (c.scheduled_for IS NULL OR c.scheduled_for <= now())
        AND EXISTS (SELECT 1 FROM card_deps d WHERE d.card_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM card_deps d JOIN cards p ON p.id = d.depends_on
                         WHERE d.card_id = c.id AND p.status NOT IN ('done', 'archived'))
      ORDER BY c.priority, c.created_at`);
  return rows.map((r) => r.id);
}

/** board_promote moves the card to ready and wakes its bot; false when the board's own checks say not yet. */
export async function promoteCard(card: string): Promise<boolean> {
  const { rows } = await query<{ ok: boolean }>(`SELECT board_promote($1) AS ok`, [card]);
  return rows[0]?.ok === true;
}

/**
 * Ready cards whose bot has nothing to wake it: assigned to a live, unpaused bot (any lane: cc-dispatcher reads the
 * same wakeups through `cli-org wake-claim`), no open task wakeup, no unfinished run. A card's wake is consumed when
 * its run ends, so one that ends with the card still ready (a budget stop, a crash, a routed park) is owed another.
 * At most `retries` wakes per ready stint (since it was created, moved, assigned, reclaimed, released by a dependency,
 * re-queued on host-up or reconciled after a finished run): past that the card
 * waits for a person, as addWakeup's hold says, and a person moving it starts a new stint.
 */
export async function readyCardsOwedAWake(retries: number): Promise<{ card: string; agent: string }[]> {
  const { rows } = await query<{ card: string; agent: string }>(
    `SELECT c.id AS card, c.assignee AS agent FROM cards c JOIN org_agents_effective a ON a.name = c.assignee
      WHERE c.status = 'ready' AND a.retired_at IS NULL AND NOT a.paused AND a.runtime NOT IN ('human', 'session')
        AND board_dispatch_enabled(c.board_slug)
        AND NOT EXISTS (SELECT 1 FROM org_wakeups w WHERE w.agent_name = c.assignee AND w.reason = 'task' AND w.ref = c.id AND w.done_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM card_runs r WHERE r.card_id = c.id AND r.finished_at IS NULL)
        AND (SELECT count(*) FROM org_wakeups w WHERE w.agent_name = c.assignee AND w.reason = 'task' AND w.ref = c.id
               AND w.created_at >= coalesce((SELECT max(e.at) FROM card_events e WHERE e.card_id = c.id
                                              AND e.kind IN ('created', 'moved', 'assigned', 'reclaimed', 'released', 'host-retry', 'reconciled')), c.created_at)) <= $1
      ORDER BY c.priority, c.created_at`, [retries]);
  return rows;
}

/**
 * Open, unclaimed task wakeups whose card is done or archived: nothing will ever run them, yet each one keeps its bot
 * selected every tick. Closed with result `card closed`. A claimed one belongs to a run in flight and is left to it
 * (releaseStale reopens it if that run died, and the next pass closes it). Idempotent: a closed wakeup is not open.
 */
export async function closeWakeupsOnClosedCards(): Promise<{ id: number; agent: string; card: string }[]> {
  const { rows } = await query<{ id: number; agent: string; card: string }>(
    `UPDATE org_wakeups w SET done_at = now(), result = 'card closed'
       FROM cards c
      WHERE c.id = w.ref AND w.reason = 'task' AND w.done_at IS NULL AND w.claimed_at IS NULL
        AND c.status IN ('done', 'archived')
      RETURNING w.id, w.agent_name AS agent, c.id AS card`);
  return rows;
}

/** The card is still running under an unfinished card_runs row: the only state a dispatcher may heartbeat or move. */
export async function cardHasLiveRun(card: string): Promise<boolean> {
  const { rowCount } = await query(
    `SELECT 1 FROM cards c JOIN card_runs r ON r.card_id = c.id AND r.finished_at IS NULL WHERE c.id = $1 AND c.status = 'running' LIMIT 1`, [card]);
  return (rowCount ?? 0) > 0;
}

/** The status of each card id that exists; a missing id is absent from the map. */
export async function cardStatuses(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const { rows } = await query<{ id: string; status: string }>(`SELECT id, status FROM cards WHERE id = ANY ($1)`, [ids]);
  return new Map(rows.map((r) => [r.id, r.status]));
}

export async function lastCodexSession(agent: string, card: string): Promise<string | null> {
  const { rows } = await query<{ session_id: string }>(
    `SELECT session_id FROM usage_runs WHERE runtime = 'codex' AND agent_name = $1 AND task_id = $2
      AND session_id ~ '^[0-9a-f-]{36}$' ORDER BY started_at DESC NULLS LAST LIMIT 1`, [agent, card]);
  return rows[0]?.session_id ?? null;
}

export async function pendingTaskCards(agent: string): Promise<{ wakeupId: number; card: string }[]> {
  const { rows } = await query<{ wakeup_id: number; card: string }>(
    `SELECT w.id AS wakeup_id, c.id AS card FROM org_wakeups w JOIN cards c ON c.id = w.ref
      WHERE w.agent_name = $1 AND w.reason = 'task' AND w.done_at IS NULL AND w.claimed_at IS NULL
        AND c.status = 'ready' AND c.assignee = $1 AND board_dispatch_enabled(c.board_slug)`, [agent]);
  return rows.map((r) => ({ wakeupId: r.wakeup_id, card: r.card }));
}

/** Subscription tokens are recorded without assigning an API dollar price. */
export async function recordCodexRun(r: { runId: string; sessionId: string | null; agent: string; model: string; card: string | null;
  startedAt: Date; endedAt: Date; state: string; text: string; inputTokens: number; outputTokens: number; wakeupIds: number[];
  codexHost?: string | null }): Promise<void> {
  const session = r.sessionId ?? `dispatch:${r.runId}`;
  await withTransaction(async (tx) => {
    const host = await codexUsageHost(tx, r.codexHost);
    await tx.query(`INSERT INTO usage_runs
      (host, run_id, session_id, log_path, task_id, agent_name, model, started_at, ended_at, duration_ms, runtime, outcome, subtype, is_error, wakeup_ids, usage)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'codex',$11,$12,$13,$14,$15::jsonb)
      ON CONFLICT (host, run_id) DO NOTHING`, [host, r.runId, session, `dispatch:${r.runId}`, r.card, r.agent, r.model,
        r.startedAt, r.endedAt, Math.max(0, r.endedAt.getTime() - r.startedAt.getTime()), r.state === 'done' ? 'did-work' : 'failed',
        `${r.state}: ${r.text}`.slice(0, 300), r.state !== 'done', r.wakeupIds,
        JSON.stringify({ input_tokens: r.inputTokens, output_tokens: r.outputTokens })]);
    if (r.inputTokens || r.outputTokens) await tx.query(`INSERT INTO usage_calls
      (source,host,call_id,session_external_id,ts,model,entrypoint,input_tokens,output_tokens,run_id)
      VALUES ('codex',$1,$2,$3,$4,$5,'sdk-cli',$6,$7,$8) ON CONFLICT DO NOTHING`,
      [host, r.runId, session, r.endedAt, r.model, r.inputTokens, r.outputTokens, r.runId]);
  });
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

export async function taskLink(taskId: string): Promise<{ title: string; work_type: string | null; area_slug: string | null } | null> {
  const { rows } = await query<{ title: string; work_type: string | null; area_slug: string | null }>(
    `SELECT title, work_type, area_slug FROM task_links WHERE task_id = $1`, [taskId]);
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

/** What went wrong on earlier routed runs of a card, oldest first: a budget stop is a turn-cap miss, a block stays a block. */
export async function cardFailures(card: string): Promise<('turn_cap_no_commit' | 'blocked')[]> {
  const { rows } = await query<{ result: string }>(
    `SELECT o.result FROM route_decisions d JOIN route_outcomes o ON o.decision_id = d.id
      WHERE d.card_id = $1 AND d.action = 'run' AND o.result IN ('failed', 'blocked') ORDER BY d.id`, [card]);
  return rows.map((r) => (r.result === 'blocked' ? 'blocked' : 'turn_cap_no_commit'));
}

/** Shared strict host selection for both prelaunch and final accounting. */
export async function codexUsageHost(tx: import('../../db.js').TxClient, codexHost?: string | null): Promise<string> {
  const selected = await tx.query<{ slug: string }>(
    `SELECT slug FROM usage_hosts
    WHERE slug = COALESCE($1, (SELECT slug FROM usage_hosts WHERE kind = 'server' ORDER BY slug LIMIT 1))`,
    [codexHost ?? null]);
  const host = selected.rows[0]?.slug;
  if (!host) {
    if (codexHost) throw new Error(`ORG_CODEX_HOST "${codexHost}" is not registered in usage_hosts`);
    throw new Error('Codex usage host unavailable: usage_hosts has no server row');
  }
  return host;
}
