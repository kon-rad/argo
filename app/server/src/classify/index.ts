import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { config } from '../config.js';
import { query } from '../db.js';
import { settings, type ClassifySettings } from '../settings.js';
import { askJev, type ClassifyProvider, type WireAnswer } from './jev.js';
import { defaultSchemasDir, loadSchema, type LoadedSchema } from './schema.js';
import type { Action, ClassifyInput, ClassifyResult } from './types.js';

export * from './types.js';
export { ClassifyError, defaultSchemasDir, loadSchema, parseSchema } from './schema.js';
export { BASE_URLS, modelIdFor, wireQuestion } from './jev.js';

/**
 * Asks the classifier one decision about one state. Falls through (action `fallthrough`) whenever it
 * cannot answer: no provider configured, the source is not on the privacy allow list, the daily token
 * cap is spent, or the provider fails. Callers treat fallthrough as "do what you did before". Every
 * outcome but a cache hit is one classify_decisions row, so the page can show how often the step ran,
 * skipped, refused or fell through, and a person can label the answers later.
 */
export interface ClassifyDeps {
  fetch?: typeof fetch;
  now?: () => Date;
  settings?: ClassifySettings;
  provider?: 'none' | ClassifyProvider;
  apiKey?: string | null;
  dailyTokens?: number;
  /** Schema folders, first wins; default: the vault's classify.schemasDir, then the engine's. */
  schemaDirs?: string[];
  timeoutMs?: number;
  baseUrl?: string;
}

/** sha256 of the state with sorted keys at every level, so two callers hashing the same facts hit the same row. */
export function stateHash(state: Record<string, unknown>): string {
  return createHash('sha256').update(canonical(state)).digest('hex');
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/**
 * The allow list names channel slugs and vault folders. A folder entry ends in `/` (or the source
 * continues with one), so `Research/` allows `Research/ai/note.md` and never `Research-private`.
 */
export function sourceAllowed(source: string | null | undefined, allow: string[]): boolean {
  if (!source) return false;
  return allow.some((a) => a === source || source.startsWith(a.endsWith('/') ? a : `${a}/`));
}

export interface Verdict {
  action: Action;
  answer: string;
  probabilities: Record<string, number> | null;
  confidence: number;
  review: boolean;
}

/**
 * Thresholds, per primitive:
 *   choice with skipOptions  P(skip options) >= act: skip. Else the rest >= escalate: act. Else escalate.
 *   choice                   confidence >= act: act. Else escalate (review when under escalate).
 *   bool                     P(true) >= act: act (yes). P(true) < escalate: skip (no). Else escalate.
 *   score                    confidence >= act: act. Else escalate (review when under escalate).
 * `escalate` on a result means "the old path runs"; `review` marks the ones a person should look at.
 */
export function decide(s: LoadedSchema, a: WireAnswer): Verdict {
  if (a.type === 'noul') {
    const p = a.noul;
    const action: Action = p >= s.act ? 'act' : p < s.escalate ? 'skip' : 'escalate';
    return { action, answer: p >= 0.5 ? 'yes' : 'no', probabilities: { true: p, false: 1 - p }, confidence: Math.max(p, 1 - p), review: false };
  }
  if (a.type === 'score') {
    return { action: a.confidence >= s.act ? 'act' : 'escalate', answer: String(a.score), probabilities: null, confidence: a.confidence, review: a.confidence < s.escalate };
  }
  if (s.skipOptions?.length) {
    const pSkip = s.skipOptions.reduce((t, o) => t + (a.probabilities[o] ?? 0), 0);
    const action: Action = pSkip >= s.act ? 'skip' : 1 - pSkip >= s.escalate ? 'act' : 'escalate';
    return { action, answer: a.choice, probabilities: a.probabilities, confidence: a.confidence, review: false };
  }
  return { action: a.confidence >= s.act ? 'act' : 'escalate', answer: a.choice, probabilities: a.probabilities, confidence: a.confidence, review: a.confidence < s.escalate };
}

interface Row {
  decision: string; schemaVersion: string; inputHash: string; inputLevel: string | null; model: string | null;
  answer: string | null; probabilities: Record<string, number> | null; confidence: number | null; action: Action;
  latencyMs: number | null; inputTokens: number | null; costUsd: number | null; error: string | null;
  runId: string | null; agentName: string | null; ref: string | null; createdAt: Date;
}

async function writeRow(r: Row): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO classify_decisions (decision, schema_version, input_hash, input_level, model, answer, probabilities, confidence,
       action, latency_ms, input_tokens, cost_usd, error, run_id, agent_name, ref, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
    [r.decision, r.schemaVersion, r.inputHash, r.inputLevel, r.model, r.answer, r.probabilities ? JSON.stringify(r.probabilities) : null,
      r.confidence, r.action, r.latencyMs, r.inputTokens, r.costUsd, r.error, r.runId, r.agentName, r.ref, r.createdAt]);
  return rows[0]!.id;
}

function schemaDirs(deps: ClassifyDeps, s: ClassifySettings): string[] {
  return deps.schemaDirs ?? [resolve(config.vaultRoot, s.schemasDir), defaultSchemasDir()];
}

export async function classify(input: ClassifyInput, deps: ClassifyDeps = {}): Promise<ClassifyResult> {
  const cs = deps.settings ?? settings().classify;
  const now = deps.now ?? (() => new Date());
  const schema = loadSchema(input.decision, schemaDirs(deps, cs));
  const modelSpec = schema.model ?? cs.model;
  const hash = stateHash(input.state);
  const base: Omit<Row, 'action' | 'error' | 'inputLevel'> = {
    decision: schema.decision, schemaVersion: schema.version, inputHash: hash, model: modelSpec, answer: null, probabilities: null,
    confidence: null, latencyMs: null, inputTokens: null, costUsd: null, runId: input.runId ?? null, agentName: input.agentName ?? null,
    ref: input.ref ?? null, createdAt: now(),
  };
  const result = (row: Row, id: number | null, cached = false, review?: boolean): ClassifyResult => ({
    decision: row.decision, schemaVersion: row.schemaVersion, action: row.action, answer: row.answer, probabilities: row.probabilities,
    confidence: row.confidence, model: row.model, latencyMs: row.latencyMs, inputTokens: row.inputTokens, costUsd: row.costUsd,
    error: row.error, cached, id, ...(review === undefined ? {} : { review }),
  });
  const fallthrough = async (error: string, level: string | null): Promise<ClassifyResult> => {
    const row: Row = { ...base, action: 'fallthrough', error, inputLevel: level };
    return result(row, await writeRow(row));
  };

  // 1. Privacy: nothing leaves the machine unless the owner named where it may come from.
  if (!sourceAllowed(input.source, cs.allow)) return fallthrough('privacy', 'refused');
  const level = schema.privacy;

  // 2. Cache: the same question about the same facts, answered this week.
  const hit = await query<{ id: number; answer: string; probabilities: Record<string, number> | null; confidence: number | null; model: string; action: Action }>(
    `SELECT id, answer, probabilities, confidence, model, action FROM classify_decisions
      WHERE decision = $1 AND schema_version = $2 AND input_hash = $3 AND action <> 'fallthrough' AND created_at > $4::timestamptz - interval '7 days'
      ORDER BY created_at DESC LIMIT 1`, [schema.decision, schema.version, hash, now()]);
  if (hit.rows[0]) {
    const h = hit.rows[0];
    return result({ ...base, action: h.action, answer: h.answer, probabilities: h.probabilities, confidence: h.confidence, model: h.model,
      error: null, inputLevel: level, latencyMs: 0, inputTokens: 0, costUsd: 0 }, h.id, true);
  }

  // 3. A provider with a key, under today's cap.
  const provider = deps.provider ?? config.classifyProvider;
  const apiKey = deps.apiKey !== undefined ? deps.apiKey : provider === 'openrouter' ? config.openrouterApiKey : provider === 'typesafe' ? config.typesafeApiKey : null;
  if (provider === 'none' || !apiKey) return fallthrough('no-key', level);
  const cap = deps.dailyTokens ?? config.classifyDailyTokens;
  if (cap > 0) {
    const { rows } = await query<{ used: string }>(
      `SELECT coalesce(sum(input_tokens), 0)::text AS used FROM classify_decisions WHERE created_at >= date_trunc('day', $1::timestamptz)`, [now()]);
    if (Number(rows[0]!.used) >= cap) return fallthrough('budget', level);
  }

  // 4. Ask.
  try {
    const reply = await askJev(schema, input.state, modelSpec, { provider, apiKey, fetch: deps.fetch, timeoutMs: deps.timeoutMs, baseUrl: deps.baseUrl });
    const v = decide(schema, reply.answer);
    const row: Row = { ...base, action: v.action, answer: v.answer, probabilities: v.probabilities, confidence: v.confidence, error: null,
      inputLevel: level, latencyMs: reply.latencyMs, inputTokens: reply.inputTokens,
      costUsd: reply.inputTokens === null ? null : (reply.inputTokens * schema.priceUsdPerMInput) / 1_000_000 };
    return result(row, await writeRow(row), false, v.review);
  } catch (err) {
    return fallthrough(`provider: ${(err as Error).message}`.slice(0, 300), level);
  }
}

export interface DecisionRow {
  id: number; created_at: Date; decision: string; schema_version: string; action: Action; answer: string | null; confidence: number | null;
  model: string | null; input_tokens: number | null; cost_usd: number | null; error: string | null; run_id: string | null;
  agent_name: string | null; ref: string | null; label: string | null; labelled_by: string | null;
}

/** The latest decisions, newest first: the owner's review list. */
export async function recentDecisions(opts: { decision?: string; limit?: number } = {}): Promise<DecisionRow[]> {
  const { rows } = await query<DecisionRow>(
    `SELECT id, created_at, decision, schema_version, action, answer, confidence, model, input_tokens, cost_usd, error, run_id, agent_name, ref, label, labelled_by
       FROM classify_decisions WHERE ($1::text IS NULL OR decision = $1) ORDER BY id DESC LIMIT $2`,
    [opts.decision ?? null, Math.min(Math.max(opts.limit ?? 40, 1), 500)]);
  return rows;
}

/** A person's verdict on one decision; the labelled set is what sets the thresholds after the pilot. */
export async function labelDecision(id: number, label: 'right' | 'wrong', by: string): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE classify_decisions SET label = $2, labelled_by = $3, labelled_at = now() WHERE id = $1`, [id, label, by]);
  return (rowCount ?? 0) > 0;
}
