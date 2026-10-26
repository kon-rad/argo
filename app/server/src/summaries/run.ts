import { pool, query } from '../db.js';
import { ChainExhausted, type ChainDeps, type Attempt } from './chain.js';
import { generate } from './generate.js';
import { summaryConfig, type SummaryConfig } from './config.js';
import { deriveTouched, loadMetrics } from './derive.js';
import { compact, loadParts, type SessionRow } from './input.js';
import { PROMPT_VERSION, type ModelSummary } from './schema.js';

export interface RunOptions {
  /** Look back this many hours for sessions that ended (default 48). */
  sinceHours?: number;
  limit?: number;
  /** One archive session id, ignoring the quiet period. */
  sessionId?: number;
  /** Re-summarize even when the stored summary is current. */
  force?: boolean;
  dryRun?: boolean;
  cfg?: SummaryConfig;
  deps?: ChainDeps;
  log?: (m: string) => void;
}

export interface RunResult {
  considered: number;
  written: number;
  skipped: number;
  unchanged: number;
  failed: number;
  tokens: { input: number; output: number };
}

const SESSION_COLS = `a.id, a.source, a.harness, a.host, a.profile, a.external_id, a.project, a.title, a.started_at, a.ended_at, a.updated_at`;

/** Finished sessions with no current summary. Claude Code subagents are skipped: their work shows in the parent's tool calls. */
export async function selectSessions(opts: RunOptions, cfg: SummaryConfig): Promise<SessionRow[]> {
  if (opts.sessionId) {
    const { rows } = await query<SessionRow>(`SELECT ${SESSION_COLS} FROM archive_sessions a WHERE a.id = $1`, [opts.sessionId]);
    return rows;
  }
  const { rows } = await query<SessionRow>(
    `SELECT ${SESSION_COLS}
       FROM archive_sessions a
       LEFT JOIN agent_summaries s ON s.session_id = a.id AND s.prompt_version = $1
      WHERE coalesce(a.ended_at, a.updated_at) < now() - make_interval(mins => $2)
        AND coalesce(a.ended_at, a.started_at, a.updated_at) >= now() - make_interval(hours => $3)
        AND NOT (a.harness = 'claude-code' AND a.parent_external_id IS NOT NULL)
        AND ($4::boolean OR s.id IS NULL OR a.updated_at > s.updated_at)
      ORDER BY coalesce(a.ended_at, a.updated_at) DESC
      LIMIT $5`,
    [PROMPT_VERSION, cfg.quietMinutes, opts.sinceHours ?? 48, Boolean(opts.force), opts.limit ?? 50],
  );
  return rows;
}

interface Written { status: 'written' | 'skipped' | 'unchanged' | 'failed'; input?: number; output?: number }

export async function summarizeSession(session: SessionRow, cfg: SummaryConfig, opts: RunOptions = {}): Promise<Written> {
  const log = opts.log ?? (() => {});
  const parts = await loadParts(session.id);
  const input = compact(parts, cfg.maxInputChars);
  const touched = deriveTouched(parts);
  const metrics = await loadMetrics(session, parts);

  const existing = await query<{ source_sha: string; status: string }>(
    `SELECT source_sha, status FROM agent_summaries WHERE session_id = $1 AND prompt_version = $2`, [session.id, PROMPT_VERSION]);
  if (!opts.force && existing.rows[0]?.source_sha === input.sha) {
    if (!opts.dryRun) await query(`UPDATE agent_summaries SET updated_at = now() WHERE session_id = $1 AND prompt_version = $2`, [session.id, PROMPT_VERSION]);
    return { status: 'unchanged' };
  }

  const base = [session.id, PROMPT_VERSION, input.sha, session.harness, session.host, session.profile, session.project, session.started_at, session.ended_at, touched, metrics];
  if (input.conversational < cfg.minSteps) {
    if (!opts.dryRun) {
      await query(
        `INSERT INTO agent_summaries (session_id, prompt_version, source_sha, status, harness, host, profile, project, started_at, ended_at, touched, metrics)
         VALUES ($1,$2,$3,'skipped',$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (session_id, prompt_version) DO UPDATE SET source_sha = EXCLUDED.source_sha, status = 'skipped',
           touched = EXCLUDED.touched, metrics = EXCLUDED.metrics, updated_at = now()`, base);
    }
    return { status: 'skipped' };
  }

  try {
    const g = await generate(input.text, session, cfg, opts.deps);
    log(`session ${session.id}: ${g.provider}/${g.model} ${g.inputTokens ?? '?'} in, ${g.outputTokens ?? '?'} out`);
    if (opts.dryRun) {
      log(JSON.stringify({ session: session.id, ...g.summary }, null, 2));
    } else {
      await store(session, base, g.summary, g.provider, g.model, g.attempts, g.inputTokens, g.outputTokens);
    }
    return { status: 'written', input: g.inputTokens ?? 0, output: g.outputTokens ?? 0 };
  } catch (err) {
    if (err instanceof ChainExhausted) log(`session ${session.id}: ${err.message}`);
    else log(`session ${session.id}: ${(err as Error).message}`);
    return { status: 'failed' };
  }
}

async function store(
  session: SessionRow, base: unknown[], s: ModelSummary, provider: string, model: string,
  attempts: Attempt[], inTok: number | null, outTok: number | null,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO agent_summaries (session_id, prompt_version, source_sha, status, harness, host, profile, project, started_at, ended_at,
         touched, metrics, request, done, learned, open_items, outcome, writer_provider, writer_model, attempts, writer_input_tokens, writer_output_tokens)
       VALUES ($1,$2,$3,'ok',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       ON CONFLICT (session_id, prompt_version) DO UPDATE SET source_sha = EXCLUDED.source_sha, status = 'ok',
         harness = EXCLUDED.harness, ended_at = EXCLUDED.ended_at, touched = EXCLUDED.touched, metrics = EXCLUDED.metrics,
         request = EXCLUDED.request, done = EXCLUDED.done, learned = EXCLUDED.learned, open_items = EXCLUDED.open_items,
         outcome = EXCLUDED.outcome, writer_provider = EXCLUDED.writer_provider, writer_model = EXCLUDED.writer_model,
         attempts = EXCLUDED.attempts, writer_input_tokens = EXCLUDED.writer_input_tokens,
         writer_output_tokens = EXCLUDED.writer_output_tokens, updated_at = now()
       RETURNING id`,
      [...base, s.request, s.done, s.learned, s.open_items, s.outcome, provider, model, JSON.stringify(attempts), inTok, outTok]);
    const id = rows[0]!.id;
    // Candidates the owner has not decided on are replaced; promoted and rejected ones stay as history.
    await client.query(`DELETE FROM agent_summary_facts WHERE summary_id = $1 AND status = 'proposed'`, [id]);
    for (const f of s.facts) {
      const dup = await client.query(`SELECT 1 FROM agent_summary_facts WHERE summary_id = $1 AND claim = $2`, [id, f.claim]);
      if (dup.rowCount) continue;
      await client.query(`INSERT INTO agent_summary_facts (summary_id, subject, claim) VALUES ($1,$2,$3)`, [id, f.subject.slice(0, 200), f.claim.slice(0, 1000)]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function runSummaries(opts: RunOptions = {}): Promise<RunResult> {
  const cfg = opts.cfg ?? summaryConfig();
  const sessions = await selectSessions(opts, cfg);
  const result: RunResult = { considered: sessions.length, written: 0, skipped: 0, unchanged: 0, failed: 0, tokens: { input: 0, output: 0 } };
  for (const s of sessions) {
    const r = await summarizeSession(s, cfg, opts);
    if (r.status === 'written') result.written++;
    else result[r.status]++;
    result.tokens.input += r.input ?? 0;
    result.tokens.output += r.output ?? 0;
  }
  return result;
}
