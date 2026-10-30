import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pool, query } from '../src/db.js';
import { main } from '../src/cli-org.js';
import { decide, recordDecision, recordOutcome, routeReport, routeReportMarkdown, routeSpend, routeWeekly, type RoutingConfig } from '../src/org-router.js';

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

describe('budgets from the log', () => {
  const B: RoutingConfig = {
    ...CFG,
    models: [...CFG.models, { id: 'ollama/qwen', provider: 'ollama', tier: 't1', can_code: false, local: true }],
    budgets: { card_ceiling_usd: 1, provider_daily_usd: { anthropic: 5 } },
  };

  it("sums the card's cost and today's cost per provider, local models at zero, usage_runs when the outcome has no cost", async () => {
    const run = decide({ work: 'coding', files: 2, envelope: ['t2'] }, B);
    const local = decide({ work: 'writing', envelope: ['t1'] }, B);
    await recordOutcome({ decisionId: await recordDecision({ cardId: 't_aaa111', agent: 'rune', d: run }), result: 'failed', costUsd: 0.6 });
    await recordOutcome({ decisionId: await recordDecision({ cardId: 't_bbb222', agent: 'rune', d: run }), result: 'done', costUsd: 2 });
    await recordOutcome({ decisionId: await recordDecision({ cardId: 't_aaa111', agent: 'rune', d: local }), result: 'done', costUsd: 9 });
    const old = await recordDecision({ cardId: 't_aaa111', agent: 'rune', runId: 'rune-old', d: run });
    await query(`UPDATE route_decisions SET created_at = now() - interval '3 days' WHERE id = $1`, [old]);
    await query(`DELETE FROM usage_runs WHERE run_id = 'rune-old'`);
    await query(`INSERT INTO usage_runs (host, session_id, log_path, run_id, total_cost_usd) VALUES ('droplet', 's-old', 'x.jsonl', 'rune-old', 0.5)`);
    const spend = await routeSpend('t_aaa111', B);
    expect(spend.cardUsd).toBeCloseTo(1.1);
    expect(spend.providerTodayUsd).toEqual({ anthropic: 2.6 });
    expect(decide({ work: 'coding', files: 2, envelope: ['t2'], spend }, B)).toMatchObject({ action: 'park', reason: expect.stringMatching(/card cost 1\.10 USD/) });
    expect(await routeSpend('t_aaa111', CFG)).toEqual({});
    await query(`DELETE FROM usage_runs WHERE run_id = 'rune-old'`);
  });
});

describe('weekly report', () => {
  it('builds the four tables, and says no data yet for an empty one', async () => {
    const work = decide({ work: 'coding', files: 2, envelope: ['t2'] }, CFG);
    const escalated = decide({ work: 'coding', files: 2, envelope: ['t2', 't3'], failures: ['turn_cap_no_commit'] }, { ...CFG, models: [...CFG.models, { id: 'opus', provider: 'anthropic', tier: 't3', can_code: true, local: false }] });
    await recordOutcome({ decisionId: await recordDecision({ cardId: 't_c1', agent: 'rune', d: work }), result: 'merged', costUsd: 1 });
    await recordOutcome({ decisionId: await recordDecision({ cardId: 't_c2', agent: 'rune', d: work }), result: 'rejected', costUsd: 0.5 });
    await recordOutcome({ decisionId: await recordDecision({ cardId: 't_c3', agent: 'rune', d: escalated }), result: 'blocked' });
    await recordDecision({ cardId: 't_c4', agent: 'rune', d: decide({ work: 'coding', files: 3, specClarity: 'low', envelope: ['t2'] }, CFG) });
    await recordDecision({ cardId: 't_c4', agent: 'rune', d: decide({ work: 'coding', files: 3, specClarity: 'low', envelope: ['t2'] }, CFG) });
    await recordDecision({ cardId: 't_c5', agent: 'rune', d: decide({ work: 'ops', role: 'deploy', envelope: ['t2'] }, CFG) });

    const r = await routeWeekly(7);
    expect(r.escalation).toEqual([{ work: 'coding', tier: 't2', runs: 2, escalated: 0 }, { work: 'coding', tier: 't3', runs: 1, escalated: 1 }]);
    expect(r.stops).toEqual([
      { cause: 'low spec clarity', decisions: 2, cards: 1 },
      { cause: 'floor above the envelope', decisions: 1, cards: 1 },
      { cause: 'run blocked', decisions: 1, cards: 1 },
    ]);
    expect(r.rejection).toEqual([{ author_tier: 't2', reviewed: 2, rejected: 1 }]);

    const md = routeReportMarkdown(r, new Date('2026-10-30T06:00:00Z'));
    expect(md).toMatch(/^# Model routing report\n/);
    expect(md).toContain('Generated at 2026-10-30 06:00 UTC');
    expect(md).toContain('| coding | t3 | 1 | 1 | 100% |');
    expect(md).toContain('| t2 | 2 | 1 | 1.50 | 1.50 |');
    expect(md).toContain('| low spec clarity | 2 | 1 |');
    expect(md).toContain('| t2 | 2 | 1 | 50% |');
    expect(md).not.toMatch(/\u2014/);

    const empty = routeReportMarkdown({ days: 7, escalation: [], cost: [], stops: [], rejection: [] });
    expect(empty.match(/No data yet\./g)).toHaveLength(4);
  });

  it('cli-org route report --since 7d --markdown prints the page, and rejects a bad --since', async () => {
    const lines: string[] = [];
    await main(['route', 'report', '--since', '7d', '--markdown'], (l: string) => lines.push(l));
    expect(lines.join('\n')).toMatch(/^# Model routing report/);
    await expect(main(['route', 'report', '--since', 'week'], () => undefined)).rejects.toThrow(/--since/);
  });

  it('cli-org route report --write puts the page in a file (the weekly timer)', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'route-report-')), 'org', 'routing-report.md');
    const lines: string[] = [];
    await main(['route', 'report', '--since', '7d', '--write', file], (l: string) => lines.push(l));
    expect(lines).toEqual([`wrote ${file}`]);
    expect(readFileSync(file, 'utf8')).toMatch(/^# Model routing report/);
  });
});

describe('cli-org route classify', () => {
  it("prints the card's signals", async () => {
    await query(`INSERT INTO org_agents (name, runtime, role, org_version) VALUES ('atlas', 'claude-code', 'Head', 'v') ON CONFLICT DO NOTHING`);
    await query(`INSERT INTO boards (slug, name) VALUES ('exo', 'Exo') ON CONFLICT DO NOTHING`);
    await query(`DELETE FROM cards WHERE id = 't_c1a551f'`);
    await query(`INSERT INTO cards (id, board_slug, title, body, created_by, work_type, repo) VALUES ('t_c1a551f', 'exo', 'Add a migration', 'Edit db/migrations/0002_x.sql; check: \`npm test\`', 'atlas', 'coding', 'app')`);
    const lines: string[] = [];
    await main(['route', 'classify', '--card', 't_c1a551f', '--json'], (l: string) => lines.push(l));
    expect(JSON.parse(lines.join('\n'))).toMatchObject({ work: 'coding', scope: 1, namedPath: true, repos: 1, specClarity: 'ok', risk: 'high', riskFlags: ['migration'], source: 'rules' });
    await expect(main(['route', 'classify', '--card', 't_ffffff0'], () => undefined)).rejects.toThrow(/no card/);
  });

  it('route decide --card classifies the card when no signal flag is given; a flag wins', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'route-')), 'routing.json');
    writeFileSync(file, JSON.stringify({ ...CFG, models: [...CFG.models, { id: 'opus', provider: 'anthropic', tier: 't3', can_code: true, local: false }] }));
    const lines: string[] = [];
    await main(['route', 'decide', '--work', 'coding', '--tiers', 't2,t3', '--card', 't_c1a551f', '--config', file, '--json'], (l: string) => lines.push(l));
    const d = JSON.parse(lines.join('\n'));
    expect(d).toMatchObject({ action: 'run', model: 'opus', tier: 't3' });
    expect(d.signals.classified.riskFlags).toEqual(['migration']);
    lines.length = 0;
    await main(['route', 'decide', '--work', 'coding', '--tiers', 't2,t3', '--card', 't_c1a551f', '--risk', 'normal', '--config', file, '--json'], (l: string) => lines.push(l));
    expect(JSON.parse(lines.join('\n'))).toMatchObject({ model: 'sonnet' });
  });
});
