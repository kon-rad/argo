import { query, type TxClient } from '../db.js';
import type { Host } from '../archive/types.js';
import type { HermesCounters, PlanSnapshot, RunRecord, UsageCall } from './types.js';

export interface Cursor { fingerprint: string; offsetBytes: number; lines: number; sizeBytes: number }

const BATCH = 200;

/** First file wins for session and timing; a later pass that sees more output for the same response raises it. */
export async function upsertCalls(tx: TxClient, calls: UsageCall[]): Promise<number> {
  const dedup = new Map<string, UsageCall>();
  for (const c of calls) {
    const key = `${c.source}|${c.host}|${c.callId}`;
    const existing = dedup.get(key);
    if (!existing) {
      dedup.set(key, c);
    } else if (c.outputTokens > existing.outputTokens) {
      // Keep the entry with larger outputTokens, but preserve first entry's sessionExternalId and ts
      dedup.set(key, {
        ...c,
        sessionExternalId: existing.sessionExternalId,
        ts: existing.ts < c.ts ? existing.ts : c.ts,
      });
    }
    // If c.outputTokens <= existing.outputTokens, keep existing
  }
  const unique = [...dedup.values()];
  let changed = 0;
  for (let i = 0; i < unique.length; i += BATCH) {
    const batch = unique.slice(i, i + BATCH);
    const params: unknown[] = [];
    const values = batch.map((c, j) => {
      const b = j * 19;
      params.push(c.source, c.host, c.callId, c.requestId, c.sessionExternalId, c.messageExternalId, c.ts, c.model,
        c.entrypoint, c.cwd, c.isSidechain, c.inputTokens, c.cacheWriteTokens, c.cacheReadTokens, c.outputTokens,
        c.thinkingTokens, c.webSearchRequests, c.tool ?? null, c.action ?? null);
      return `(${Array.from({ length: 19 }, (_, k) => `$${b + k + 1}`).join(',')})`;
    });
    const r = await tx.query(
      `INSERT INTO usage_calls AS u (source, host, call_id, request_id, session_external_id, message_external_id, ts,
         model, entrypoint, cwd, is_sidechain, input_tokens, cache_write_tokens, cache_read_tokens, output_tokens,
         thinking_tokens, web_search_requests, tool, action)
       VALUES ${values.join(',')}
       ON CONFLICT (source, host, call_id) DO UPDATE SET output_tokens = EXCLUDED.output_tokens,
         thinking_tokens = EXCLUDED.thinking_tokens,
         tool = COALESCE(u.tool, EXCLUDED.tool), action = COALESCE(u.action, EXCLUDED.action),
         message_external_id = CASE WHEN u.session_external_id = EXCLUDED.session_external_id
                                    THEN EXCLUDED.message_external_id ELSE u.message_external_id END
       WHERE EXCLUDED.output_tokens > u.output_tokens`, params);
    changed += r.rowCount ?? 0;
  }
  return changed;
}

export async function upsertRuns(tx: TxClient, runs: RunRecord[]): Promise<number> {
  let changed = 0;
  for (const r of runs) {
    const v = r.verify;
    const res = await tx.query(
      `INSERT INTO usage_runs AS u (host, run_id, session_id, task_id, board, lane, model, started_at, ended_at, duration_ms,
         duration_api_ms, num_turns, subtype, is_error, total_cost_usd, usage, model_usage, verify_name, verify_passed,
         verify_exit, verify_metric, verify_output, verify_at, log_path, agent_name, team_slug, work_type, reasons, wakeup_ids, resumed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28::jsonb,$29::bigint[],$30)
       ON CONFLICT (host, run_id) DO UPDATE SET session_id=EXCLUDED.session_id, task_id=EXCLUDED.task_id, board=EXCLUDED.board,
         lane=EXCLUDED.lane, model=EXCLUDED.model, started_at=EXCLUDED.started_at, ended_at=EXCLUDED.ended_at,
         duration_ms=EXCLUDED.duration_ms, duration_api_ms=EXCLUDED.duration_api_ms, num_turns=EXCLUDED.num_turns,
         subtype=EXCLUDED.subtype, is_error=EXCLUDED.is_error, total_cost_usd=EXCLUDED.total_cost_usd,
         usage=EXCLUDED.usage, model_usage=EXCLUDED.model_usage, verify_name=EXCLUDED.verify_name,
         verify_passed=EXCLUDED.verify_passed, verify_exit=EXCLUDED.verify_exit, verify_metric=EXCLUDED.verify_metric,
         verify_output=EXCLUDED.verify_output, verify_at=EXCLUDED.verify_at, log_path=EXCLUDED.log_path,
         agent_name=EXCLUDED.agent_name, team_slug=EXCLUDED.team_slug, work_type=EXCLUDED.work_type,
         reasons=EXCLUDED.reasons, wakeup_ids=EXCLUDED.wakeup_ids, resumed=EXCLUDED.resumed
       WHERE (u.verify_at, u.ended_at, u.lane, u.session_id, u.agent_name, u.task_id, u.work_type, u.reasons::text)
             IS DISTINCT FROM (EXCLUDED.verify_at, EXCLUDED.ended_at, EXCLUDED.lane, EXCLUDED.session_id, EXCLUDED.agent_name, EXCLUDED.task_id, EXCLUDED.work_type, EXCLUDED.reasons::text)`,
      [r.host, r.runId, r.sessionId, r.taskId, r.board, r.lane, r.model, r.startedAt, r.endedAt, r.durationMs, r.durationApiMs,
        r.numTurns, r.subtype, r.isError, r.totalCostUsd, JSON.stringify(r.usage ?? null),
        JSON.stringify(r.modelUsage ?? null), v?.name ?? null, v?.passed ?? null, v?.exitCode ?? null,
        v?.metric ?? null, v?.output ?? null, v?.at ?? null, r.logPath, r.agentName, r.teamSlug, r.workType,
        JSON.stringify(r.reasons ?? []), r.wakeupIds ?? [], r.resumed]);
    changed += res.rowCount ?? 0;
  }
  return changed;
}

/**
 * A call belongs to the run of its session that was going on when it happened
 * (two minutes of slack either side: a bot's wakes are at least a cooldown apart).
 * Calls and run logs sync separately, so this runs after both and only fills blanks.
 */
export async function attachCallsToRuns(tx: TxClient, host: Host): Promise<number> {
  const r = await tx.query(
    `UPDATE usage_calls c SET run_id = r.run_id
       FROM usage_runs r
      WHERE c.host = $1 AND c.run_id IS NULL AND r.host = c.host AND r.session_id = c.session_external_id
        AND r.started_at IS NOT NULL
        AND c.ts >= r.started_at - interval '2 minutes'
        AND c.ts <= COALESCE(r.ended_at, now()) + interval '2 minutes'`, [host]);
  return r.rowCount ?? 0;
}

export async function insertPlanSnapshots(tx: TxClient, snaps: PlanSnapshot[]): Promise<number> {
  let n = 0;
  for (const p of snaps) {
    const r = await tx.query(
      `INSERT INTO plan_usage_snapshots (host, origin, "window", used_pct, resets_at, observed_at)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [p.host, p.origin, p.window, p.usedPct, p.resetsAt, p.observedAt]);
    n += r.rowCount ?? 0;
  }
  return n;
}

/**
 * A row only when a session's totals changed since its last row. The first row of a
 * session that already ended is timed at its end, so a first sync of old history
 * lands on the right day instead of piling into "now".
 */
export async function recordHermesCounters(tx: TxClient, rows: HermesCounters[], now: Date): Promise<number> {
  let n = 0;
  for (const h of rows) {
    const r = await tx.query(
      `INSERT INTO hermes_usage_snapshots (host, profile, session_id, observed_at, model, billing_provider,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, api_calls, cost_usd)
       SELECT $1::text, $2::text, $3::text,
              CASE WHEN last.session_id IS NULL AND $14::timestamptz IS NOT NULL THEN LEAST($14::timestamptz, $4::timestamptz)
                   ELSE $4::timestamptz END,
              $5::text, $6::text, $7::bigint, $8::bigint, $9::bigint, $10::bigint, $11::bigint, $12::int, $13::double precision
       FROM (SELECT 1) one
       LEFT JOIN LATERAL (SELECT session_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                                 reasoning_tokens, api_calls
                          FROM hermes_usage_snapshots WHERE host=$1 AND profile=$2 AND session_id=$3
                          ORDER BY observed_at DESC LIMIT 1) last ON true
       WHERE last.session_id IS NULL
          OR (last.input_tokens, last.output_tokens, last.cache_read_tokens, last.cache_write_tokens,
              last.reasoning_tokens, last.api_calls) IS DISTINCT FROM ($7::bigint,$8::bigint,$9::bigint,$10::bigint,$11::bigint,$12::int)
       ON CONFLICT DO NOTHING`,
      [h.host, h.profile, h.sessionId, now, h.model, h.billingProvider, h.inputTokens, h.outputTokens,
        h.cacheReadTokens, h.cacheWriteTokens, h.reasoningTokens, h.apiCalls, h.costUsd, h.endedAt]);
    n += r.rowCount ?? 0;
  }
  return n;
}

export async function getCursor(host: Host, path: string): Promise<Cursor | null> {
  const { rows } = await query<{ fingerprint: string; offset_bytes: number; lines: number; size_bytes: number }>(
    `SELECT fingerprint, offset_bytes, lines, size_bytes FROM usage_files WHERE host=$1 AND path=$2`, [host, path]);
  const r = rows[0];
  return r ? { fingerprint: r.fingerprint, offsetBytes: r.offset_bytes, lines: r.lines, sizeBytes: r.size_bytes } : null;
}

export async function saveCursor(tx: TxClient, host: Host, path: string, c: Cursor): Promise<void> {
  await tx.query(
    `INSERT INTO usage_files (host, path, fingerprint, offset_bytes, lines, size_bytes) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (host, path) DO UPDATE SET fingerprint=EXCLUDED.fingerprint, offset_bytes=EXCLUDED.offset_bytes,
       lines=EXCLUDED.lines, size_bytes=EXCLUDED.size_bytes, updated_at=now()`,
    [host, path, c.fingerprint, c.offsetBytes, c.lines, c.sizeBytes]);
}
