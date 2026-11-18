import { pauseLane } from './board.js';
import { latestCredits } from './credits.js';
import { query } from './db.js';

/**
 * The credit breaker (cutover plan 5a, item 3). It pauses a whole lane at the claim, through board_pause_lane, so
 * every dispatcher obeys it with no code of its own and no card is lost: a paused lane's cards stay `ready`.
 *
 *   zen-agent lane    paused when the OpenRouter balance (credits-sync) is under `openrouterMinBalance`.
 *   claude-code lane  paused after `claudeRateLimitStreak` rate-limit or usage-limit blocks in a row.
 *
 * It only pauses. Nothing resumes by itself: an unattended resume is how a runaway comes back while nobody is
 * watching (the same rule as board_pause). The owner resumes with `cli-org resume all` or a lane.
 *
 * It fails open on missing data: no reading, an errored reading or one older than `openrouterMaxAgeMinutes` is
 * not "zero credits". A broken credits-sync must not stop the company.
 */

export interface BreakerLimits {
  openrouterMinBalance: number;
  openrouterMaxAgeMinutes: number;
  claudeRateLimitStreak: number;
}

/** Proposed in the PR; overridable by env (ORG_BREAKER_OPENROUTER_MIN, ORG_BREAKER_CLAUDE_STREAK, ORG_BREAKER_MAX_AGE_MIN). */
export function breakerLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): BreakerLimits {
  const n = (v: string | undefined, d: number): number => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    openrouterMinBalance: n(env.ORG_BREAKER_OPENROUTER_MIN, 5),
    openrouterMaxAgeMinutes: n(env.ORG_BREAKER_MAX_AGE_MIN, 180),
    claudeRateLimitStreak: n(env.ORG_BREAKER_CLAUDE_STREAK, 2),
  };
}

export interface BreakerInputs {
  openrouterBalance: number | null;
  openrouterAgeMinutes: number | null;
  claudeStreak: number;
}

export interface BreakerDecision {
  runtime: string;
  reason: string;
}

export function breakerDecisions(i: BreakerInputs, l: BreakerLimits): BreakerDecision[] {
  const out: BreakerDecision[] = [];
  const fresh = i.openrouterAgeMinutes !== null && i.openrouterAgeMinutes <= l.openrouterMaxAgeMinutes;
  if (i.openrouterBalance !== null && fresh && i.openrouterBalance < l.openrouterMinBalance) {
    out.push({ runtime: 'zen-agent', reason: `credit breaker: openrouter balance $${i.openrouterBalance.toFixed(2)} is under $${l.openrouterMinBalance.toFixed(2)}` });
  }
  if (i.claudeStreak >= l.claudeRateLimitStreak) {
    out.push({ runtime: 'claude-code', reason: `credit breaker: ${i.claudeStreak} rate-limit errors in a row on the Claude lane` });
  }
  return out;
}

const RATE_LIMIT = '(rate.?limit|usage.?limit|weekly limit|\\m429\\M|overloaded)';

/**
 * How many of the latest `window` finished claude-code runs, counting back from the newest, ended blocked with a
 * rate-limit or usage-limit message. The newest run that did anything else ends the count.
 */
export async function claudeRateLimitStreak(window: number): Promise<number> {
  const { rows } = await query<{ limited: boolean }>(
    `SELECT (r.outcome = 'blocked' AND EXISTS (
              SELECT 1 FROM card_events e
               WHERE e.card_id = r.card_id AND e.kind = 'blocked' AND e."at" >= r.claimed_at
                 AND coalesce(e.payload->>'result', '') ~* $2)) AS limited
       FROM card_runs r
      WHERE r.runtime = 'claude-code' AND r.finished_at IS NOT NULL AND r.outcome IN ('done', 'blocked', 'partial', 'budget')
      ORDER BY r.finished_at DESC, r.id DESC LIMIT $1`, [window, RATE_LIMIT]);
  let n = 0;
  for (const r of rows) {
    if (!r.limited) break;
    n++;
  }
  return n;
}

async function openrouterReading(): Promise<{ balance: number | null; ageMinutes: number | null }> {
  const o = (await latestCredits()).find((c) => c.provider === 'openrouter');
  const ok = o?.latest?.status === 'ok' ? o.latest : null;
  if (!ok || ok.balance === null) return { balance: null, ageMinutes: null };
  return { balance: ok.balance, ageMinutes: (Date.now() - new Date(ok.observed_at).getTime()) / 60_000 };
}

export interface BreakerAction {
  runtime: string;
  reason: string;
  /** Bots newly paused; 0 when the lane was already paused (the breaker is idempotent). */
  paused: number;
}

/** Look, decide, and (unless dryRun) pause. `by` must be the owner or a dispatch bot, like any pause. */
export async function runBreaker(by: string, limits: BreakerLimits, o: { dryRun: boolean }): Promise<BreakerAction[]> {
  const or = await openrouterReading();
  const decisions = breakerDecisions(
    { openrouterBalance: or.balance, openrouterAgeMinutes: or.ageMinutes, claudeStreak: await claudeRateLimitStreak(limits.claudeRateLimitStreak) },
    limits,
  );
  const out: BreakerAction[] = [];
  for (const d of decisions) out.push({ ...d, paused: o.dryRun ? 0 : await pauseLane(by, d.runtime, true, d.reason) });
  return out;
}
