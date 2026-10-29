import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool, query } from '../src/db.js';
import { main } from '../src/cli-org.js';
import { decide, recordDecision, recordOutcome, routeReport, type RoutingConfig } from '../src/org-router.js';

/** route_decisions and route_outcomes: a decision is logged, its outcome joins it, the report gives cost per merged PR by tier. */

const CFG: RoutingConfig = {
  tiers: { t0: { turns: 8 }, t1: { turns: 20 }, t2: { turns: 30 }, t3: { turns: 40 } },
  floors: { coding_single_file_named_path: 't1', coding_default: 't2', high_risk: 't3', merge: 't3', deploy: 't3' },
  escalation: { turn_cap_no_commit: 1, tests_failed_twice: 1, review_changes_twice: 1 },
  risk_keywords: [],
  models: [{ id: 'sonnet', provider: 'anthropic', tier: 't2', can_code: true, local: false }],
};

beforeEach(async () => {
  await query('TRUNCATE route_decisions CASCADE');
});
afterAll(async () => {
  await pool.end();
});

describe('route log', () => {
  it('logs a decision and its outcome, and reports cost per merged PR by tier', async () => {
    const d = decide({ work: 'coding', files: 2, envelope: ['t2'] }, CFG);
    const id = await recordDecision({ cardId: 't_abc123', agent: 'rune', d });
    await recordOutcome({ decisionId: id, result: 'merged', turns: 12, tokens: 5000, costUsd: 0.4, verified: true });
    await recordDecision({ cardId: 't_abc124', agent: 'rune', d });
    const rows = await routeReport(7);
    expect(rows).toEqual([{ tier: 't2', decisions: 2, escalated: 0, merged: 1, cost_usd: 0.4, cost_per_merged_usd: 0.4 }]);
  });

  it('logs a non-run decision without a model', async () => {
    const d = decide({ work: 'coding', files: 3, specClarity: 'low', envelope: ['t2'] }, CFG);
    await recordDecision({ agent: 'rune', d });
    const { rows } = await query<{ action: string; model: string | null }>('SELECT action, model FROM route_decisions');
    expect(rows).toEqual([{ action: 'ask-spec', model: null }]);
  });

  it('cli-org route outcome rejects a bad result', async () => {
    await expect(main(['route', 'outcome', '1', 'nonsense'], () => undefined)).rejects.toThrow(/route outcome/);
  });
});
