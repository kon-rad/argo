import { query } from './db.js';
import { OrgError, type Agent } from './org.js';

/**
 * Agent episodes: one row per finished wake, written mechanically by `cli-org wake-done` (or `cli-org reflect`'s
 * replacement, the same path without a wakeup to close). What happened, how it ended, what it cost, and where the
 * full log is. Append-only.
 *
 * This was the episodic tier of the per-bot persona memory (docs/agent-memory.md). Engine core v2 phase 6 retired
 * the semantic store (`org_agent_memory`, the generated `core.md` and the reflect model step): a bot's durable
 * knowledge is the shared store now, `memory_facts` with its `agent` column, written with `secondbrain memory
 * remember` and read with `secondbrain memory recall` (see docs/memory.md). The episode log stays: it is the
 * mechanical record of a wake that nothing else keeps, and the metric `secondbrain memory stats` reads.
 */

// ---------------------------------------------------------------------------
// Episodes
// ---------------------------------------------------------------------------

export const EPISODE_REASONS = ['task', 'dm', 'handoff', 'mention', 'routine', 'owner', 'chat'] as const;
export const OUTCOMES = ['done', 'blocked', 'request_changes', 'no_report', 'error'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export interface Episode {
  id: number;
  agent_name: string;
  run_id: string;
  wakeup_ids: number[];
  task_id: string | null;
  reason: string;
  outcome: Outcome;
  corrected: boolean;
  turn_count: number | null;
  cost_usd: string | null;
  duration_s: number | null;
  summary: string;
  log_path: string | null;
  reflected_at: Date | null;
  reflect_model: string | null;
  created_at: Date;
}

// bigint[] columns are cast to int[] so pg returns numbers, not strings (ids fit).
const EPISODE_COLS = 'id, agent_name, run_id, wakeup_ids::int[] AS wakeup_ids, task_id, reason, outcome, corrected, turn_count, cost_usd, duration_s, summary, log_path, reflected_at, reflect_model, created_at';

export interface EpisodeInput {
  run: string;
  wakeupIds?: number[];
  task?: string;
  reason?: string;
  outcome?: Outcome;
  exit?: number;
  result?: string;
  turns?: number;
  cost?: number;
  duration?: number;
  log?: string;
  /** The run left no status post of its own (wake-done posted the fallback). */
  noReport?: boolean;
}

/** The outcome when the caller names none: the exit code, then what the result text says, then the fallback post. */
export function deriveOutcome(e: Pick<EpisodeInput, 'exit' | 'result' | 'noReport' | 'outcome'>): Outcome {
  if (e.outcome) return e.outcome;
  if (e.exit !== undefined && e.exit !== 0) return 'error';
  const r = (e.result ?? '').trim();
  if (/^blocked\b/i.test(r)) return 'blocked';
  if (/changes requested|request[_ ]changes/i.test(r)) return 'request_changes';
  if (e.noReport) return 'no_report';
  return 'done';
}

/** The mechanical first-person summary: what was worked, how it ended, one line of the result. No model call. */
export function episodeSummary(e: { task?: string; reason?: string; outcome: Outcome; result?: string }): string {
  const what = e.task ? `card ${e.task}` : e.reason === 'chat' ? 'a chat' : e.reason === 'routine' ? 'my routine' : `a ${e.reason ?? 'wake'}`;
  const ended = { done: 'Finished.', blocked: 'Blocked.', request_changes: 'Sent back with changes requested.', no_report: 'Ended without a report.', error: 'Ended in an error.' }[e.outcome];
  const line = (e.result ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return `Worked ${what}. ${ended}${line ? ` ${line.slice(0, 300)}` : ''}`.slice(0, 2000);
}

/** One row per finished wake. Idempotent on (agent, run): a wake-done run twice returns the first row. */
export async function recordEpisode(agent: Agent, e: EpisodeInput): Promise<{ episode: Episode; created: boolean }> {
  if (!e.run.trim()) throw new OrgError('an episode needs its run id');
  const reason = e.reason ?? (e.task ? 'task' : 'owner');
  if (!(EPISODE_REASONS as readonly string[]).includes(reason)) throw new OrgError(`episode reason is one of ${EPISODE_REASONS.join(', ')}, not "${reason}"`);
  const outcome = deriveOutcome(e);
  const { rows } = await query<Episode>(
    `INSERT INTO org_agent_episodes (agent_name, run_id, wakeup_ids, task_id, reason, outcome, turn_count, cost_usd, duration_s, summary, log_path)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (agent_name, run_id) DO NOTHING RETURNING ${EPISODE_COLS}`,
    [agent.name, e.run.trim(), e.wakeupIds ?? [], e.task ?? null, reason, outcome, e.turns ?? null, e.cost ?? null, e.duration ?? null, episodeSummary({ ...e, reason, outcome }), e.log ?? null],
  );
  if (rows[0]) return { episode: rows[0], created: true };
  const { rows: old } = await query<Episode>(`SELECT ${EPISODE_COLS} FROM org_agent_episodes WHERE agent_name = $1 AND run_id = $2`, [agent.name, e.run.trim()]);
  return { episode: old[0]!, created: false };
}

export async function listEpisodes(agent: string, limit = 20): Promise<Episode[]> {
  const { rows } = await query<Episode>(`SELECT ${EPISODE_COLS} FROM org_agent_episodes WHERE agent_name = $1 ORDER BY id DESC LIMIT $2`, [agent, Math.min(Math.max(limit, 1), 500)]);
  return rows;
}

/** A reviewer sent the card back: the builder's latest episode on it counts as corrected (the metric the ledger reads). */
export async function markCorrected(agent: string, taskId: string): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE org_agent_episodes SET corrected = true WHERE id = (SELECT id FROM org_agent_episodes WHERE agent_name = $1 AND task_id = $2 ORDER BY id DESC LIMIT 1)`,
    [agent, taskId],
  );
  return (rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Metrics: the per-agent numbers the ledger reads, from the episodes
// ---------------------------------------------------------------------------

export interface MemoryStats {
  agent: string;
  days: number;
  episodes: number;
  done: number;
  corrected: number;
  /** corrections per completed card: the ratchet metric. Null when nothing was completed. */
  corrections_per_done: number | null;
  cost_per_done: number | null;
  avg_turns: number | null;
  reflected: number;
}

export async function memoryStats(agent: string, days = 14): Promise<MemoryStats> {
  const d = Math.min(Math.max(days, 1), 365);
  const { rows } = await query<{ episodes: number; done: number; corrected: number; cost: string | null; turns: string | null; reflected: number }>(
    `SELECT count(*)::int AS episodes,
            count(*) FILTER (WHERE outcome = 'done')::int AS done,
            count(*) FILTER (WHERE outcome = 'done' AND corrected)::int AS corrected,
            sum(cost_usd) FILTER (WHERE outcome = 'done') AS cost,
            avg(turn_count) AS turns,
            count(*) FILTER (WHERE reflected_at IS NOT NULL)::int AS reflected
       FROM org_agent_episodes WHERE agent_name = $1 AND created_at > now() - make_interval(days => $2)`,
    [agent, d],
  );
  const e = rows[0]!;
  return {
    agent,
    days: d,
    episodes: e.episodes,
    done: e.done,
    corrected: e.corrected,
    corrections_per_done: e.done ? Number((e.corrected / e.done).toFixed(3)) : null,
    cost_per_done: e.done && e.cost !== null ? Number((Number(e.cost) / e.done).toFixed(4)) : null,
    avg_turns: e.turns !== null ? Number(Number(e.turns).toFixed(1)) : null,
    reflected: e.reflected,
  };
}
