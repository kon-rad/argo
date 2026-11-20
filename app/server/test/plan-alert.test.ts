import { beforeEach, describe, expect, it, vi } from 'vitest';
import { query } from '../src/db.js';
import { checkPlanAlerts, fmtTokens, pendingAlerts, reached, renderPlanAlert, type Burner } from '../src/usage/planAlert.js';
import { truncateAll } from './helpers.js';

// Seeded rows only: plan readings and calls are inserted here, nothing comes from production.
const NOW = new Date('2026-10-22T12:00:00Z');
const FIVE_RESET = new Date('2026-10-22T14:00:00Z'); // window started 09:00
const SEVEN_RESET = new Date('2026-10-26T00:00:00Z');

async function reading(window: 'five_hour' | 'seven_day', pct: number, resetsAt: Date, observedAt = new Date(NOW.getTime() - 60_000), host = 'mac') {
  await query(
    `INSERT INTO plan_usage_snapshots (host, origin, "window", used_pct, resets_at, observed_at) VALUES ($1, 'statusline', $2, $3, $4, $5)`,
    [host, window, pct, resetsAt.toISOString(), observedAt.toISOString()],
  );
}

async function calls(sid: string, n: number, cacheRead: number, at: Date, host = 'mac', model = 'claude-opus-5-5') {
  for (let i = 0; i < n; i++) {
    await query(
      `INSERT INTO usage_calls (source, host, call_id, session_external_id, ts, model, cache_read_tokens, entrypoint)
       VALUES ('claude-code', $1, $2, $3, $4, $5, $6, 'cli')`,
      [host, `${sid}-${i}-${at.getTime()}`, sid, new Date(at.getTime() + i * 1000).toISOString(), model, cacheRead],
    );
  }
}

const notifier = () => {
  const sent: string[] = [];
  return { sent, notify: vi.fn(async (t: string) => { sent.push(t); }) };
};

describe('helpers', () => {
  it('counts thresholds reached and formats token counts', () => {
    expect(reached(59.9)).toEqual([]);
    expect(reached(60)).toEqual([60]);
    expect(reached(85)).toEqual([60, 80]);
    expect(reached(100)).toEqual([60, 80, 90]);
    expect([fmtTokens(950), fmtTokens(12_400), fmtTokens(412_000_000), fmtTokens(3_100_000_000)]).toEqual(['950', '12k', '412M', '3.1B']);
  });

  it('renders the crossing, the top three with their share, and one clear-this-one line', () => {
    const b: Burner[] = [
      { host: 'mac', sid: '3f2a9c1d-aaaa', surface: 'mac', model: 'claude-opus-5-5', agent: null, task: null, burn: 400_000_000, calls: 310 },
      { host: 'droplet', sid: '9b8c7d6e-bbbb', surface: 'bot', model: 'claude-sonnet-5-5', agent: 'rune', task: 't_1', burn: 100_000_000, calls: 80 },
    ];
    const text = renderPlanAlert({ window: 'five_hour', usedPct: 83.4, resetsAt: FIVE_RESET, observedAt: NOW }, 80, b, 1_000_000_000);
    expect(text).toContain('five-hour window is at 83% (crossed 80%)');
    expect(text).toContain('resets 2026-10-22 14:00 UTC');
    expect(text).toContain('1. 3f2a9c1d: 400M (40%) over 310 calls; mac, claude-opus-5-5');
    expect(text).toContain('2. 9b8c7d6e: 100M (10%) over 80 calls; droplet, bot rune, t_1, claude-sonnet-5-5');
    expect(text).toMatch(/Clear this one: 3f2a9c1d on mac\. Write its Resume block, then \/clear\./);
    expect(text).not.toContain('—');
  });

  it('for an unattended run, says to shorten or split the card instead of /clear', () => {
    const b: Burner[] = [{ host: 'droplet', sid: 'abcdef0123', surface: 'bot', model: null, agent: 'atlas', task: 't_9', burn: 5, calls: 1 }];
    expect(renderPlanAlert({ window: 'seven_day', usedPct: 61, resetsAt: SEVEN_RESET, observedAt: NOW }, 60, b, 5)).toMatch(/unattended run .* split it/);
  });

  it('still alerts when no sessions are recorded', () => {
    const text = renderPlanAlert({ window: 'five_hour', usedPct: 61, resetsAt: FIVE_RESET, observedAt: NOW }, 60, [], 0);
    expect(text).toContain('No session usage is recorded');
  });
});

describe('checkPlanAlerts', () => {
  beforeEach(truncateAll);

  it('sends nothing below 60 percent', async () => {
    await reading('five_hour', 59, FIVE_RESET);
    const n = notifier();
    const r = await checkPlanAlerts(n.notify, NOW);
    expect(r.sent).toEqual([]);
    expect(n.sent).toEqual([]);
  });

  it('sends once at 60, again at 80, once at 90, and never twice for the same crossing', async () => {
    const n = notifier();
    await reading('five_hour', 62, FIVE_RESET);
    await checkPlanAlerts(n.notify, NOW);
    await checkPlanAlerts(n.notify, NOW);
    expect(n.sent).toHaveLength(1);
    expect(n.sent[0]).toContain('(crossed 60%)');

    await reading('five_hour', 64, FIVE_RESET, new Date(NOW.getTime() - 30_000));
    await checkPlanAlerts(n.notify, NOW);
    expect(n.sent).toHaveLength(1);

    await reading('five_hour', 81, FIVE_RESET, new Date(NOW.getTime() - 20_000));
    await checkPlanAlerts(n.notify, NOW);
    expect(n.sent).toHaveLength(2);
    expect(n.sent[1]).toContain('(crossed 80%)');

    await reading('five_hour', 95, FIVE_RESET, new Date(NOW.getTime() - 10_000));
    await checkPlanAlerts(n.notify, NOW);
    await checkPlanAlerts(n.notify, NOW);
    expect(n.sent).toHaveLength(3);
    expect(n.sent[2]).toContain('(crossed 90%)');

    // A dip and a re-crossing inside the same window is the same crossing.
    await reading('five_hour', 70, FIVE_RESET, new Date(NOW.getTime() - 5_000));
    await reading('five_hour', 91, FIVE_RESET, new Date(NOW.getTime() - 1_000));
    await checkPlanAlerts(n.notify, NOW);
    expect(n.sent).toHaveLength(3);
  });

  it('a jump past several thresholds sends one message for the highest and records the lower ones', async () => {
    await reading('seven_day', 92, SEVEN_RESET);
    const n = notifier();
    const r = await checkPlanAlerts(n.notify, NOW);
    expect(n.sent).toHaveLength(1);
    expect(n.sent[0]).toContain('seven-day window is at 92% (crossed 90%)');
    expect(r.sent[0]!.crossed).toEqual([60, 80, 90]);
    const { rows } = await query(`SELECT threshold::int FROM plan_alerts ORDER BY threshold`);
    expect(rows).toEqual([{ threshold: 60 }, { threshold: 80 }, { threshold: 90 }]);
    await checkPlanAlerts(n.notify, NOW);
    expect(n.sent).toHaveLength(1);
  });

  it('alerts again in the next window instance (resets_at moved)', async () => {
    const n = notifier();
    await reading('five_hour', 85, FIVE_RESET);
    await checkPlanAlerts(n.notify, NOW);
    const later = new Date(NOW.getTime() + 6 * 3_600_000);
    await reading('five_hour', 65, new Date(FIVE_RESET.getTime() + 5 * 3_600_000), new Date(later.getTime() - 60_000));
    await checkPlanAlerts(n.notify, later);
    expect(n.sent).toHaveLength(2);
    expect(n.sent[1]).toContain('(crossed 60%)');
  });

  it('handles the two windows independently and ignores a window that already reset or has no reset time', async () => {
    await reading('five_hour', 65, FIVE_RESET);
    await reading('seven_day', 82, SEVEN_RESET);
    await query(`INSERT INTO plan_usage_snapshots (host, origin, "window", used_pct, resets_at, observed_at) VALUES ('mac','statusline','seven_day', 99, NULL, $1)`, [new Date(NOW.getTime() - 5000).toISOString()]);
    const n = notifier();
    await checkPlanAlerts(n.notify, NOW);
    expect(n.sent).toHaveLength(2);
    expect(n.sent.some((t) => t.includes('five-hour window is at 65%'))).toBe(true);
    expect(n.sent.some((t) => t.includes('seven-day window is at 82%'))).toBe(true);

    // The five-hour window rolled over before the next check: its old reading is no longer current.
    const n2 = notifier();
    await checkPlanAlerts(n2.notify, new Date(FIVE_RESET.getTime() + 60_000));
    expect(n2.sent).toEqual([]);
  });

  it('takes the newest reading across hosts', async () => {
    await reading('five_hour', 95, FIVE_RESET, new Date(NOW.getTime() - 600_000), 'droplet');
    await reading('five_hour', 30, FIVE_RESET, new Date(NOW.getTime() - 60_000), 'mac');
    const n = notifier();
    await checkPlanAlerts(n.notify, NOW);
    expect(n.sent).toEqual([]);
  });

  it('names the top three sessions by cache reads inside the window only', async () => {
    await reading('five_hour', 85, FIVE_RESET);
    await calls('aaaaaaaa-long', 10, 40_000_000, new Date('2026-10-22T10:00:00Z'));
    await calls('bbbbbbbb-mid', 10, 10_000_000, new Date('2026-10-22T10:30:00Z'), 'droplet');
    await calls('cccccccc-small', 5, 1_000_000, new Date('2026-10-22T11:00:00Z'));
    await calls('dddddddd-tiny', 1, 1_000, new Date('2026-10-22T11:30:00Z'));
    // Before the window opened (09:00): must not count even though it is the biggest.
    await calls('eeeeeeee-old', 50, 90_000_000, new Date('2026-10-22T07:00:00Z'));
    const [alert] = await pendingAlerts(NOW);
    expect(alert!.burners.map((b) => b.sid)).toEqual(['aaaaaaaa-long', 'bbbbbbbb-mid', 'cccccccc-small']);
    expect(alert!.burners[0]).toMatchObject({ burn: 400_000_000, calls: 10, host: 'mac' });
    expect(alert!.totalBurn).toBe(400_000_000 + 100_000_000 + 5_000_000 + 1_000);
    expect(alert!.text).toContain('1. aaaaaaaa: 400M (79%) over 10 calls');
    expect(alert!.text).not.toContain('eeeeeeee');
  });

  it('gives the claim back when the send fails, so the next run retries; no secrets in the message', async () => {
    await reading('five_hour', 85, FIVE_RESET);
    const bad = vi.fn(async () => { throw new Error('Telegram HTTP 502'); });
    const r = await checkPlanAlerts(bad, NOW);
    expect(r.failed).toEqual([{ window: 'five_hour', error: 'Telegram HTTP 502' }]);
    expect((await query(`SELECT count(*)::int AS n FROM plan_alerts`)).rows[0]!.n).toBe(0);
    const n = notifier();
    await checkPlanAlerts(n.notify, NOW);
    expect(n.sent).toHaveLength(1);
    expect(n.sent[0]).not.toMatch(/token|bot\d|api\.telegram/i);
  });

  it('a dry run (pendingAlerts) claims nothing', async () => {
    await reading('five_hour', 85, FIVE_RESET);
    expect(await pendingAlerts(NOW)).toHaveLength(1);
    expect(await pendingAlerts(NOW)).toHaveLength(1);
    expect((await query(`SELECT count(*)::int AS n FROM plan_alerts`)).rows[0]!.n).toBe(0);
  });
});
