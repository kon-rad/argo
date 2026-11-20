import { query } from '../db.js';
import type { Notify } from '../livestream-x.js';

/**
 * Telegram alert when the Claude plan fills up. Reads the plan percentage the
 * statusline already stored in plan_usage_snapshots (used_pct, never computed
 * here: we do not know how Anthropic weights each token type), and tells the
 * owner once per window per threshold crossing, with the three sessions that
 * read the most cache in that window and a line saying which one to clear.
 *
 * Sessions re-read their whole history on every call, so the long ones burn
 * the plan. See the plan-burn ideas note (idea 4).
 */

export const PLAN_ALERT_THRESHOLDS = [60, 80, 90] as const;
export type PlanWindow = 'five_hour' | 'seven_day';
export const PLAN_WINDOWS: readonly PlanWindow[] = ['five_hour', 'seven_day'];
const WINDOW_MS: Record<PlanWindow, number> = { five_hour: 5 * 3_600_000, seven_day: 7 * 86_400_000 };
const WINDOW_LABEL: Record<PlanWindow, string> = { five_hour: 'five-hour', seven_day: 'seven-day' };

export interface Reading { window: PlanWindow; usedPct: number; resetsAt: Date; observedAt: Date }

export interface Burner {
  host: string;
  sid: string;
  surface: string | null;
  model: string | null;
  agent: string | null;
  task: string | null;
  burn: number;
  calls: number;
}

export interface WindowAlert {
  window: PlanWindow;
  reading: Reading;
  /** Thresholds newly crossed in this check (never sent before for this window instance). */
  crossed: number[];
  burners: Burner[];
  totalBurn: number;
  text: string;
}

export interface AlertResult { sent: WindowAlert[]; failed: { window: PlanWindow; error: string }[] }

/** "412M", "3.1B", "980k". */
export function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${Math.round(n / 1e6)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

/** The newest reading per window whose window has not rolled over yet. A window with no resets_at can't be told apart from the last one, so it is skipped. */
export async function currentReadings(now: Date): Promise<Reading[]> {
  const { rows } = await query<{ window: PlanWindow; used_pct: number; resets_at: Date; observed_at: Date }>(
    `SELECT DISTINCT ON ("window") "window", used_pct, resets_at, observed_at
       FROM plan_usage_snapshots
      WHERE resets_at IS NOT NULL AND resets_at > $1::timestamptz AND observed_at <= $1::timestamptz
      ORDER BY "window", observed_at DESC`,
    [now.toISOString()],
  );
  return rows.map((r) => ({ window: r.window, usedPct: Number(r.used_pct), resetsAt: new Date(r.resets_at), observedAt: new Date(r.observed_at) }));
}

/** The sessions that read the most cache since `from`, and the total they sit in. */
export async function topBurners(from: Date, to: Date, limit = 3): Promise<{ burners: Burner[]; total: number }> {
  const { rows } = await query<{ host: string; sid: string; surface: string | null; model: string | null; agent: string | null; task: string | null; burn: string; calls: string }>(
    `SELECT host, sid, max(surface) AS surface, max(model) AS model, max(agent_name) AS agent, max(task_id) AS task,
            sum(cache_read)::text AS burn, count(*)::text AS calls
       FROM usage_facts
      WHERE ts >= $1 AND ts < $2 AND sid IS NOT NULL
      GROUP BY host, sid
      ORDER BY sum(cache_read) DESC NULLS LAST
      LIMIT $3`,
    [from.toISOString(), to.toISOString(), limit],
  );
  const t = await query<{ total: string | null }>(`SELECT sum(cache_read)::text AS total FROM usage_facts WHERE ts >= $1 AND ts < $2`, [from.toISOString(), to.toISOString()]);
  return {
    burners: rows.map((r) => ({ host: r.host, sid: r.sid, surface: r.surface, model: r.model, agent: r.agent, task: r.task, burn: Number(r.burn), calls: Number(r.calls) })),
    total: Number(t.rows[0]?.total ?? 0),
  };
}

const short = (sid: string): string => sid.slice(0, 8);
const describe = (b: Burner): string =>
  [b.host, b.agent ? `bot ${b.agent}` : b.surface && b.surface !== b.host ? b.surface : null, b.task, b.model].filter(Boolean).join(', ');

/** The message: what crossed, the top three, and one line on what to clear. Plain text, no secrets. */
export function renderPlanAlert(reading: Reading, crossed: number, burners: Burner[], totalBurn: number): string {
  const label = WINDOW_LABEL[reading.window];
  const lines = [
    `Claude plan: the ${label} window is at ${Math.round(reading.usedPct)}% (crossed ${crossed}%). It resets ${reading.resetsAt.toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
  ];
  if (!burners.length) {
    lines.push('No session usage is recorded in this window yet.');
    return lines.join('\n');
  }
  lines.push('', 'Top sessions by cache reads in this window:');
  burners.forEach((b, i) => {
    const share = totalBurn > 0 ? ` (${Math.round((b.burn / totalBurn) * 100)}%)` : '';
    lines.push(`${i + 1}. ${short(b.sid)}: ${fmtTokens(b.burn)}${share} over ${b.calls} calls; ${describe(b)}`);
  });
  const top = burners[0]!;
  const headless = top.surface === 'bot' || top.surface === 'cc-lane' || top.surface === 'droplet' || /headless$/.test(top.surface ?? '');
  lines.push(
    '',
    headless
      ? `Clear this one: ${short(top.sid)} is an unattended run (${describe(top)}); give its card a shorter context or split it.`
      : `Clear this one: ${short(top.sid)} on ${top.host}. Write its Resume block, then /clear.`,
  );
  return lines.join('\n');
}

/** Thresholds a reading has reached. */
export const reached = (usedPct: number): number[] => PLAN_ALERT_THRESHOLDS.filter((t) => usedPct >= t);

/**
 * What would be sent now, without claiming or sending anything (the dry run).
 * A jump past several thresholds at once yields one alert for the highest.
 */
export async function pendingAlerts(now: Date): Promise<WindowAlert[]> {
  const out: WindowAlert[] = [];
  for (const reading of await currentReadings(now)) {
    const have = await query<{ threshold: number }>(`SELECT threshold FROM plan_alerts WHERE "window" = $1 AND resets_at = $2`, [reading.window, reading.resetsAt.toISOString()]);
    const done = new Set(have.rows.map((r) => Number(r.threshold)));
    const crossed = reached(reading.usedPct).filter((t) => !done.has(t));
    if (!crossed.length) continue;
    const from = new Date(reading.resetsAt.getTime() - WINDOW_MS[reading.window]);
    const { burners, total } = await topBurners(from, now);
    out.push({ window: reading.window, reading, crossed, burners, totalBurn: total, text: renderPlanAlert(reading, Math.max(...crossed), burners, total) });
  }
  return out;
}

/**
 * Claims each newly crossed threshold by inserting its plan_alerts row (the
 * primary key makes a crossing claimable once), sends one message per window
 * for the highest, and gives the claim back if the send fails so the next run
 * tries again.
 */
export async function checkPlanAlerts(notify: Notify, now = new Date()): Promise<AlertResult> {
  const result: AlertResult = { sent: [], failed: [] };
  for (const alert of await pendingAlerts(now)) {
    const claimed: number[] = [];
    for (const t of alert.crossed) {
      const r = await query(
        `INSERT INTO plan_alerts ("window", threshold, resets_at, used_pct) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [alert.window, t, alert.reading.resetsAt.toISOString(), alert.reading.usedPct],
      );
      if (r.rowCount) claimed.push(t);
    }
    // Another run claimed them between our read and our insert.
    if (!claimed.length) continue;
    try {
      await notify(alert.text);
      result.sent.push({ ...alert, crossed: claimed });
    } catch (err) {
      await query(`DELETE FROM plan_alerts WHERE "window" = $1 AND resets_at = $2 AND threshold = ANY($3::smallint[])`, [alert.window, alert.reading.resetsAt.toISOString(), claimed]);
      result.failed.push({ window: alert.window, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
