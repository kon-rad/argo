import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { config } from './config.js';
import { query } from './db.js';
import { settings } from './settings.js';
import { completeWithFallback, type Attempt, type ChainDeps } from './summaries/chain.js';
import { summaryConfig, type ChainEntry } from './summaries/config.js';

/**
 * The capture loop (docs/memory.md): one model pass over a bot's finished wakes that turns the durable lessons into
 * that bot's own facts (`memory_facts.agent`). It is the writer the phase-6 persona retirement left without a
 * producer: the episode log (`org_agent_episodes`, written mechanically by `wake-done`) is the raw material, the
 * configured prompt is the question, and every part of the decision is a knob under `memory.capture` in
 * `secondbrain.json` (see `settings.ts`) so a vault can tune it and later build a self-improvement cycle on top:
 * the prompt is a vault file, and a fact it writes can already become a proposal card (`secondbrain memory propose`).
 *
 * Runs on the app's own connection (the table owner), never the `sb_org` role: `memory_facts`' write policy checks
 * `author = org_me()`, so a capture under an agent identity would be refused.
 */

export type CaptureConfig = ReturnType<typeof settings>['memory']['capture'];

const FactsOut = z.object({
  facts: z
    .array(
      z.object({
        subject: z.string().trim().min(1).max(200),
        claim: z.string().trim().min(1).max(1000),
        source: z.string().trim().max(500).default(''),
      }),
    )
    .max(20)
    .catch([]),
});
export type CapturedFact = z.infer<typeof FactsOut>['facts'][number];

/** Pulls the JSON object out of an answer that may be fenced or carry thinking text. Null when it does not parse. */
export function parseFacts(raw: string): CapturedFact[] | null {
  const cleaned = raw.replace(/ thinking[\s\S]*?<\/think>/g, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = FactsOut.safeParse(JSON.parse(cleaned.slice(start, end + 1)));
    return parsed.success ? parsed.data.facts : null;
  } catch {
    return null;
  }
}

const DEFAULT_PROMPT_FILE = join(config.appRoot, 'config', 'memory-capture-prompt.md');

/** The prompt the loop asks with: an inline override, else the vault's file, else the engine's own default. */
export function capturePrompt(cfg: CaptureConfig): string {
  if (cfg.systemPrompt) return cfg.systemPrompt;
  const file = cfg.promptFile ? join(config.vaultRoot, cfg.promptFile) : DEFAULT_PROMPT_FILE;
  if (!existsSync(file)) throw new Error(`memory capture: prompt file not found: ${file}`);
  return readFileSync(file, 'utf8');
}

export interface EpisodeRow {
  id: number;
  agent_name: string;
  run_id: string;
  task_id: string | null;
  reason: string;
  outcome: string;
  corrected: boolean;
  turn_count: number | null;
  cost_usd: string | null;
  duration_s: number | null;
  summary: string;
  log_path: string | null;
  created_at: Date;
}

const EPISODE_COLS = `id, agent_name, run_id, task_id, reason, outcome, corrected, turn_count, cost_usd, duration_s, summary, log_path, created_at`;

/** The model call: the prompt and the wake in, the facts and the model id out. Injectable for tests. */
export type Answer = (system: string, e: EpisodeRow) => Promise<{ facts: CapturedFact[]; model: string }>;

export interface CaptureOptions {
  /** Ask the model and report, but write nothing and stamp nothing. */
  dryRun?: boolean;
  /** Only this agent's wakes. */
  agent?: string;
  /** Ignore the age window (a deliberate backfill). */
  all?: boolean;
  /** Ignore the `everyMinutes` cadence gate (a manual run). */
  force?: boolean;
  /** Cap on wakes read this run. */
  limit?: number;
  deps?: ChainDeps;
  log?: (m: string) => void;
  /** Overrides for the settings (tests). */
  cfg?: CaptureConfig;
  /** Overrides the provider chain (tests). */
  chain?: ChainEntry[];
  /** Overrides the model call itself (tests), so no provider is contacted. */
  answer?: Answer;
}

export interface CaptureResult {
  /** Eligible wakes this run saw. */
  considered: number;
  /** Wakes the model answered for. */
  processed: number;
  /** Facts written (or, in a dry run, that would be). */
  facts: number;
  /** Claims skipped as already known. */
  skipped: number;
  /** Wakes whose model call failed (the chain did not answer, or the answer did not parse). */
  failed: number;
  /** Agents whose wakes were read. */
  agents: string[];
}

export function captureConfig(): CaptureConfig {
  return settings().memory.capture;
}

/** The un-reflected wakes the policy admits: ended how it wants, long enough, recent enough, for the agent asked. */
export async function selectWakes(cfg: CaptureConfig, o: CaptureOptions = {}): Promise<EpisodeRow[]> {
  const { rows } = await query<EpisodeRow>(
    `SELECT ${EPISODE_COLS} FROM org_agent_episodes
      WHERE reflected_at IS NULL
        AND outcome = ANY($1::text[])
        AND coalesce(turn_count, 0) >= $2
        AND ($3::boolean OR created_at > now() - make_interval(hours => $4))
        AND ($5::text IS NULL OR agent_name = $5)
      ORDER BY created_at ASC
      LIMIT $6`,
    [cfg.outcomes, cfg.minTurns, Boolean(o.all), cfg.maxAgeHours, o.agent ?? null, Math.min(o.limit ?? cfg.maxWakesPerRun, 50)],
  );
  return rows;
}

/** The one wake, as the model sees it. */
export function wakeText(e: EpisodeRow): string {
  return [
    `Wake ${e.id} of ${e.agent_name} (run ${e.run_id}), reason ${e.reason}, outcome ${e.outcome}${e.corrected ? ' (sent back with changes)' : ''}.`,
    `Turns: ${e.turn_count ?? 'unknown'}. Cost: ${e.cost_usd ? `$${e.cost_usd}` : 'unknown'}. Duration: ${e.duration_s ?? 'unknown'}s.`,
    e.task_id ? `Card: ${e.task_id}.` : '',
    e.log_path ? `Log: ${e.log_path}.` : '',
    `Episode summary: ${e.summary}`,
    '',
    'Write the durable claims this wake taught, as JSON.',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

async function modelFacts(
  system: string,
  e: EpisodeRow,
  chain: ChainEntry[],
  deps: ChainDeps,
): Promise<{ facts: CapturedFact[]; provider: string; model: string; attempts: Attempt[] }> {
  const r = await completeWithFallback(
    chain,
    { system, messages: [{ role: 'user', content: wakeText(e) }], maxTokens: 900, temperature: 0.2 },
    { ...deps, accept: (t) => parseFacts(t) !== null },
  );
  return { facts: parseFacts(r.text)!, provider: r.provider, model: r.model, attempts: r.attempts };
}

/** True when the (agent, claim) pair is already a current fact: exact match, or near-duplicate with `dedupe: similar`. */
async function alreadyKnown(agent: string | null, claim: string, cfg: CaptureConfig): Promise<boolean> {
  const { rowCount } =
    cfg.dedupe === 'similar'
      ? await query(`SELECT 1 FROM memory_facts WHERE valid_to IS NULL AND agent IS NOT DISTINCT FROM $1 AND similarity(claim, $2) >= $3 LIMIT 1`, [agent, claim, cfg.dedupeSimilarity])
      : await query(`SELECT 1 FROM memory_facts WHERE valid_to IS NULL AND agent IS NOT DISTINCT FROM $1 AND lower(btrim(claim)) = lower(btrim($2)) LIMIT 1`, [agent, claim]);
  return (rowCount ?? 0) > 0;
}

/** One fact, or a no-op when the bot already holds it. The source is the model's, else the episode it came from. */
async function writeFact(agent: string | null, e: EpisodeRow, f: CapturedFact, cfg: CaptureConfig): Promise<boolean> {
  if (await alreadyKnown(agent, f.claim, cfg)) return false;
  await query(
    `INSERT INTO memory_facts (subject, claim, source, author, via, agent, confidence)
     VALUES ($1,$2,$3,$4,'memory-capture',$5,'inferred')`,
    [f.subject.slice(0, 200), f.claim.slice(0, 1000), (f.source || `episode:${e.id}`).slice(0, 500), e.agent_name, agent],
  );
  return true;
}

/** Drain the eligible wakes: read each, write the facts the model returns, stamp the episode so it is not re-read. */
export async function runCapture(o: CaptureOptions = {}): Promise<CaptureResult> {
  const log = o.log ?? (() => {});
  const cfg = o.cfg ?? settings().memory.capture;
  const out: CaptureResult = { considered: 0, processed: 0, facts: 0, skipped: 0, failed: 0, agents: [] };
  if (!cfg.enabled || cfg.trigger === 'off') {
    log(`memory capture: off (enabled=${cfg.enabled}, trigger=${cfg.trigger})`);
    return out;
  }
  // Cadence: the timer ticks on a fixed interval, but the loop only acts every `everyMinutes` (settings), so how
  // often it runs is a vault knob, not a deploy-time one. `--force` / `--all` run regardless.
  if (!o.force && !o.all) {
    const { rows } = await query<{ t: Date | null }>(`SELECT max(reflected_at) AS t FROM org_agent_episodes`);
    const last = rows[0]?.t ? new Date(rows[0].t).getTime() : null;
    if (last !== null && Date.now() - last < cfg.everyMinutes * 60_000) {
      log(`memory capture: not due (last capture ${Math.round((Date.now() - last) / 60_000)}m ago, every ${cfg.everyMinutes}m)`);
      return out;
    }
  }
  const chain = o.chain ?? cfg.chain ?? summaryConfig().chain;
  const system = capturePrompt(cfg);
  const answer: Answer = o.answer ?? (async (_s, e) => {
    const r = await modelFacts(system, e, chain, o.deps ?? {});
    return { facts: r.facts, model: `${r.provider}/${r.model}` };
  });
  const wakes = await selectWakes(cfg, o);
  out.considered = wakes.length;
  const seen = new Set<string>();
  for (const e of wakes) {
    const agent = cfg.scope === 'agent' ? e.agent_name : null;
    seen.add(e.agent_name);
    try {
      const r = await answer(system, e);
      const capped = r.facts.slice(0, cfg.maxFactsPerWake);
      let wrote = 0;
      if (o.dryRun) {
        wrote = capped.length;
      } else {
        for (const f of capped) if (await writeFact(agent, e, f, cfg)) wrote += 1;
        await query(`UPDATE org_agent_episodes SET reflected_at = now(), reflect_model = $2 WHERE id = $1`, [e.id, r.model]);
      }
      out.facts += wrote;
      out.skipped += capped.length - wrote;
      out.processed += 1;
      log(`memory capture: wake ${e.id} (${e.agent_name}) -> ${wrote} fact(s) via ${r.model}`);
    } catch (err) {
      out.failed += 1;
      log(`memory capture: wake ${e.id} failed: ${(err as Error).message}`);
    }
  }
  out.agents = [...seen];
  return out;
}
