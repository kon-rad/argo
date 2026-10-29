import { query } from './db.js';

/**
 * Model routing for agent runs (design: Areas/argo/second-brain/agent-company/org-config-and-model-routing-design.md).
 * A bot keeps its persona, permissions and memory; the model is chosen per run, inside the bot's tier envelope.
 * `decide` is pure: rules in, decision out. Hard floors beat cost, a permission block never escalates, and a run
 * is never silently given a weaker model than its floor.
 */

export const TIERS = ['t0', 't1', 't2', 't3'] as const;
export type Tier = (typeof TIERS)[number];
const rank = (t: Tier): number => TIERS.indexOf(t);

export interface RoutedModel {
  id: string;
  aliases?: string[];
  provider: string;
  tier: Tier;
  can_code: boolean;
  local: boolean;
  price_in?: number | null;
  price_out?: number | null;
}

/** What `compile.py routing` writes to .agents/org/routing.json. */
export interface RoutingConfig {
  tiers: Record<Tier, { turns: number; tokens?: number | null }>;
  floors: { coding_single_file_named_path: Tier; coding_default: Tier; high_risk: Tier; merge: Tier; deploy: Tier };
  escalation: { turn_cap_no_commit: number; tests_failed_twice: number; review_changes_twice: number };
  risk_keywords: string[];
  models: RoutedModel[];
}

export type Role = 'work' | 'review' | 'merge' | 'deploy';
export type Failure = 'turn_cap_no_commit' | 'tests_failed' | 'review_changes' | 'blocked';

export interface RouteInput {
  work: string; // research, coding, design, media, writing, sales, education, ops
  role?: Role;
  text?: string; // card title and body, scanned for risk keywords
  files?: number; // files the card names or the diff touched; 0 when unknown
  namedPath?: boolean; // the card names a verified path
  specClarity?: 'low' | 'ok';
  risk?: 'normal' | 'high'; // project and repo risk class
  envelope: Tier[]; // the bot's allowed tiers
  authorTier?: Tier; // for a review: the author's tier
  failures?: Failure[]; // earlier attempts on this card, oldest first
  unhealthyProviders?: string[];
}

export type Decision =
  | { action: 'run'; model: string; tier: Tier; floor: Tier; turns: number; tokens: number | null; reason: string; signals: Signals }
  | { action: 'ask-spec' | 'park' | 'wait' | 'blocked'; reason: string; floor: Tier | null; signals: Signals };

export interface Signals {
  work: string;
  role: Role;
  scope: number;
  specClarity: 'low' | 'ok';
  risk: 'normal' | 'high';
  riskWords: string[];
  retries: number;
  escalations: number;
}

export function riskWords(text: string | undefined, keywords: string[]): string[] {
  const t = (text ?? '').toLowerCase();
  return keywords.filter((k) => new RegExp(`\\b${k.toLowerCase()}`).test(t));
}

/** Tiers to climb for the failures so far: one per turn-cap miss, one per two test failures, one per two rejected reviews. */
export function escalations(failures: Failure[], cfg: RoutingConfig): number {
  const n = (f: Failure): number => failures.filter((x) => x === f).length;
  return (
    n('turn_cap_no_commit') * cfg.escalation.turn_cap_no_commit +
    Math.floor(n('tests_failed') / 2) * cfg.escalation.tests_failed_twice +
    Math.floor(n('review_changes') / 2) * cfg.escalation.review_changes_twice
  );
}

export function decide(input: RouteInput, cfg: RoutingConfig): Decision {
  const role = input.role ?? 'work';
  const failures = input.failures ?? [];
  const words = riskWords(input.text, cfg.risk_keywords);
  const risk = input.risk === 'high' || words.length > 0 || role === 'merge' || role === 'deploy' ? 'high' : 'normal';
  const scope = input.files ?? 0;
  const clarity = input.specClarity ?? 'ok';
  const esc = escalations(failures, cfg);
  const signals: Signals = { work: input.work, role, scope, specClarity: clarity, risk, riskWords: words, retries: failures.length, escalations: esc };

  // A permission block is reported, never escalated: a stronger model will not fix a sandbox refusal.
  if (failures.includes('blocked')) return { action: 'blocked', floor: null, signals, reason: 'earlier attempt hit a permission block; report BLOCKED, do not escalate' };

  if (input.work === 'coding' && clarity === 'low' && scope > 1) {
    return { action: 'ask-spec', floor: null, signals, reason: `low spec clarity on a ${scope}-file coding card: ask for a spec instead of running` };
  }

  // Hard floor: the highest tier any rule demands.
  let floor: Tier = 't0';
  const why: string[] = [];
  const raise = (t: Tier, r: string): void => {
    if (rank(t) > rank(floor)) floor = t;
    why.push(`${r} -> ${t}`);
  };
  if (input.work === 'coding') raise(scope === 1 && input.namedPath ? cfg.floors.coding_single_file_named_path : cfg.floors.coding_default, 'coding');
  if (role === 'merge') raise(cfg.floors.merge, 'merge');
  if (role === 'deploy') raise(cfg.floors.deploy, 'deploy');
  if (risk === 'high') raise(cfg.floors.high_risk, words.length ? `risk words (${words.join(', ')})` : 'high risk');
  if (role === 'review' && input.authorTier) raise(input.authorTier, 'reviewer at least the author tier');

  const envelope = [...input.envelope].sort((a, b) => rank(a) - rank(b));
  const top = envelope[envelope.length - 1];
  if (!top) return { action: 'park', floor, signals, reason: 'the bot has no tiers in its envelope' };
  if (rank(floor) > rank(top)) {
    return { action: 'park', floor, signals, reason: `floor ${floor} (${why.join('; ')}) is above the bot's envelope (${envelope.join(', ')}); needs konrad, never run lower` };
  }

  // Start at the cheapest envelope tier that meets the floor, then climb on evidence.
  const startable = envelope.filter((t) => rank(t) >= rank(floor));
  const start = Math.min(esc, startable.length - 1);
  if (esc > startable.length - 1) {
    return { action: 'park', floor, signals, reason: `already at the top of the envelope after ${esc} escalation(s); needs konrad` };
  }
  const candidateTiers = startable.slice(start);
  const unhealthy = new Set(input.unhealthyProviders ?? []);
  const usable = (m: RoutedModel): boolean =>
    candidateTiers.includes(m.tier) &&
    !unhealthy.has(m.provider) &&
    (input.work !== 'coding' || m.can_code) &&
    (risk !== 'high' || !m.local);
  const price = (m: RoutedModel): number => (m.price_in ?? Number.POSITIVE_INFINITY) + (m.price_out ?? Number.POSITIVE_INFINITY);
  const ordered = [...cfg.models.filter(usable)].sort((a, b) => rank(a.tier) - rank(b.tier) || price(a) - price(b));
  const pick = ordered[0];
  if (!pick) {
    return { action: 'wait', floor, signals, reason: `no healthy ${input.work === 'coding' ? 'can_code ' : ''}${risk === 'high' ? 'hosted ' : ''}model in ${candidateTiers.join('/')}; wait or ask konrad, never fall below ${floor}` };
  }
  const budget = cfg.tiers[pick.tier];
  return {
    action: 'run',
    model: pick.id,
    tier: pick.tier,
    floor,
    turns: budget.turns,
    tokens: budget.tokens ?? null,
    signals,
    reason: [why.length ? `floor ${floor}: ${why.join('; ')}` : 'no floor', esc ? `${esc} escalation(s)` : null, `cheapest healthy: ${pick.id}`].filter(Boolean).join('; '),
  };
}

/** Fixed bots (leads, the merger, the deployer) keep their model; the floors still check it, and a violation is reported, not hidden. */
export function checkFixed(model: string, input: RouteInput, cfg: RoutingConfig): { ok: boolean; reason: string } {
  const m = cfg.models.find((x) => x.id === model || x.aliases?.includes(model));
  if (!m) return { ok: false, reason: `${model} is not in the model catalog` };
  const d = decide({ ...input, envelope: [...TIERS] }, cfg);
  if (d.action !== 'run') return { ok: false, reason: d.reason };
  if (rank(m.tier) < rank(d.floor)) return { ok: false, reason: `${m.id} is ${m.tier}, floor is ${d.floor}` };
  if (input.work === 'coding' && !m.can_code) return { ok: false, reason: `${m.id} is can_code: false` };
  if (d.signals.risk === 'high' && m.local) return { ok: false, reason: `${m.id} is local; high-risk work needs a hosted model` };
  return { ok: true, reason: 'fixed model meets the floor' };
}

export type Result = 'merged' | 'rejected' | 'parked' | 'blocked' | 'done' | 'failed';

/** Log one decision (route_decisions); returns its id so the outcome can be tied to it later. */
export async function recordDecision(args: { runId?: string | null; cardId?: string | null; agent: string; d: Decision }): Promise<number> {
  const { d } = args;
  const run = d.action === 'run';
  const { rows } = await query<{ id: string }>(
    `INSERT INTO route_decisions (run_id, card_id, agent, action, signals, tier, model, reason, budget)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::jsonb) RETURNING id`,
    [args.runId ?? null, args.cardId ?? null, args.agent, d.action, JSON.stringify(d.signals), run ? d.tier : null, run ? d.model : null, d.reason, run ? JSON.stringify({ turns: d.turns, tokens: d.tokens }) : null],
  );
  return Number(rows[0]!.id);
}

export async function recordOutcome(args: { decisionId: number; result: Result; turns?: number; tokens?: number; costUsd?: number; escalatedFrom?: Tier; verified?: boolean }): Promise<void> {
  await query(
    `INSERT INTO route_outcomes (decision_id, result, turns, tokens, cost_usd, escalated_from, verified)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (decision_id) DO UPDATE SET result = EXCLUDED.result, turns = EXCLUDED.turns, tokens = EXCLUDED.tokens,
       cost_usd = EXCLUDED.cost_usd, escalated_from = EXCLUDED.escalated_from, verified = EXCLUDED.verified`,
    [args.decisionId, args.result, args.turns ?? null, args.tokens ?? null, args.costUsd ?? null, args.escalatedFrom ?? null, args.verified ?? false],
  );
}

export interface RouteReportRow { tier: string; decisions: number; escalated: number; merged: number; cost_usd: number | null; cost_per_merged_usd: number | null }

/** The weekly numbers: escalation rate and cost per merged PR by tier, from the last `days` days. */
export async function routeReport(days = 7): Promise<RouteReportRow[]> {
  const { rows } = await query<RouteReportRow>(
    `SELECT d.tier, count(*)::int AS decisions,
            count(*) FILTER (WHERE o.escalated_from IS NOT NULL)::int AS escalated,
            count(*) FILTER (WHERE o.result = 'merged')::int AS merged,
            sum(o.cost_usd)::float8 AS cost_usd,
            (sum(o.cost_usd) / NULLIF(count(*) FILTER (WHERE o.result = 'merged'), 0))::float8 AS cost_per_merged_usd
       FROM route_decisions d LEFT JOIN route_outcomes o ON o.decision_id = d.id
      WHERE d.action = 'run' AND d.created_at > now() - make_interval(days => $1)
      GROUP BY d.tier ORDER BY d.tier`,
    [days],
  );
  return rows;
}
