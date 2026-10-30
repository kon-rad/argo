import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, normalize, sep } from 'node:path';
import { z } from 'zod';
import { config } from './config.js';
import { query, withTransaction } from './db.js';
import { buildChatProvider, pickProvider, providerCatalog } from './llm/registry.js';
import { complete, type ChatProvider } from './llm/types.js';
import { log } from './logger.js';
import { createTask, getAgent, OrgError, type Agent } from './org.js';

/**
 * Agent persona memory (docs/agent-memory.md). Three tiers per bot, next to the shared facts in org-powers.ts:
 *
 *   episodic   org_agent_episodes: one row per finished wake, mechanical (recordEpisode)
 *   semantic   org_agent_memory: first-person lessons distilled from episodes by the reflect step (reflect, applyAudn)
 *   core       .agents/org/memory/<name>/core.md: the active rows rendered under a token budget (renderCore)
 *
 * and the one way a bot may change itself: a row that recurs past its repeat threshold becomes a self-improvement
 * card addressed to a human (proposeImprovement). The validator that bounds what such a card may propose is
 * hard-coded here, not configuration: prose only, its own prompt or its own skill files, a patch not a rewrite.
 *
 * Config comes from the vault's compiled `.agents/org/org-agents.json` (`agents.<name>.memory`, written by the
 * vault's compile.py from org.yaml) with defaults that work when the file says nothing.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** No bot's core block may dominate its context, whatever org.yaml says. */
export const CORE_BUDGET_CEILING = 4000;
export const EPISODE_REASONS = ['task', 'dm', 'handoff', 'mention', 'routine', 'owner', 'chat'] as const;
export const OUTCOMES = ['done', 'blocked', 'request_changes', 'no_report', 'error'] as const;
export const MEMORY_KINDS = ['lesson', 'anti_pattern', 'preference', 'friction'] as const;
export type Outcome = (typeof OUTCOMES)[number];
export type MemoryKind = (typeof MEMORY_KINDS)[number];

const MemoryConfigSchema = z.object({
  tiers: z.array(z.enum(['core', 'episodic', 'semantic'])).default(['core', 'episodic', 'semantic']),
  core_budget_tokens: z.number().int().positive().max(CORE_BUDGET_CEILING, `core_budget_tokens is at most ${CORE_BUDGET_CEILING}`).default(1500),
  reflect: z
    .object({
      enabled: z.boolean().default(true),
      trigger: z.array(z.enum(['wake_done', 'chat_end'])).default(['wake_done', 'chat_end']),
      /** `cheap` (the local model first, a small hosted one after), `off`, or `<provider>/<model>`. */
      model: z.string().min(1).default('cheap'),
      min_turns: z.number().int().min(0).default(2),
    })
    .prefault({}),
  self_improvement: z
    .object({
      enabled: z.boolean().default(true),
      max_proposals_per_week: z.number().int().min(0).default(1),
      repeat_threshold: z.number().int().min(2).default(2),
      targets: z.array(z.enum(['own_prompt', 'own_skills'])).default(['own_prompt', 'own_skills']),
      /** Not an agent-settable override: anything but true is refused at parse time. */
      requires_ship_gate: z.literal(true, { error: 'requires_ship_gate is always true' }).default(true),
    })
    .prefault({}),
});
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;

export interface AgentMemorySettings {
  memory: MemoryConfig;
  /** The agent's knowledge paths from the compiled org file (vault-relative); own_skills targets live under them. */
  knowledge: string[];
}

export function parseMemoryConfig(raw: unknown): MemoryConfig {
  const r = MemoryConfigSchema.safeParse(raw ?? {});
  if (!r.success) throw new OrgError(`memory config: ${r.error.issues.map((i) => `${i.path.join('.') || 'memory'}: ${i.message}`).join('; ')}`);
  return r.data;
}

/** The agent's memory settings from the vault's compiled org file; defaults when the file or the block is missing. */
export function memorySettingsFor(vaultRoot: string, agent: string): AgentMemorySettings {
  let doc: { defaults?: { memory?: unknown }; agents?: Record<string, { memory?: unknown; knowledge?: unknown }> } = {};
  try {
    doc = JSON.parse(readFileSync(join(vaultRoot, '.agents', 'org', 'org-agents.json'), 'utf8')) as typeof doc;
  } catch {
    /* no compiled file: defaults */
  }
  const a = doc.agents?.[agent];
  const merged = deepMerge(asRecord(doc.defaults?.memory), asRecord(a?.memory));
  const knowledge = Array.isArray(a?.knowledge) ? a.knowledge.filter((k): k is string => typeof k === 'string') : [];
  return { memory: parseMemoryConfig(merged), knowledge };
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = b && typeof b === 'object' && !Array.isArray(b) && v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(asRecord(b), asRecord(v)) : v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Episodes
// ---------------------------------------------------------------------------

export interface Episode {
  id: number;
  agent_name: string;
  run_id: string;
  wakeup_ids: number[];
  task_id: string | null;
  reason: string;
  outcome: Outcome;
  corrected: boolean;
  turn_count: number | null;
  cost_usd: string | null;
  duration_s: number | null;
  summary: string;
  log_path: string | null;
  reflected_at: Date | null;
  reflect_model: string | null;
  created_at: Date;
}

// bigint[] columns are cast to int[] so pg returns numbers, not strings (ids fit).
const EPISODE_COLS = 'id, agent_name, run_id, wakeup_ids::int[] AS wakeup_ids, task_id, reason, outcome, corrected, turn_count, cost_usd, duration_s, summary, log_path, reflected_at, reflect_model, created_at';

export interface EpisodeInput {
  run: string;
  wakeupIds?: number[];
  task?: string;
  reason?: string;
  outcome?: Outcome;
  exit?: number;
  result?: string;
  turns?: number;
  cost?: number;
  duration?: number;
  log?: string;
  /** The run left no status post of its own (wake-done posted the fallback). */
  noReport?: boolean;
}

/** The outcome when the caller names none: the exit code, then what the result text says, then the fallback post. */
export function deriveOutcome(e: Pick<EpisodeInput, 'exit' | 'result' | 'noReport' | 'outcome'>): Outcome {
  if (e.outcome) return e.outcome;
  if (e.exit !== undefined && e.exit !== 0) return 'error';
  const r = (e.result ?? '').trim();
  if (/^blocked\b/i.test(r)) return 'blocked';
  if (/changes requested|request[_ ]changes/i.test(r)) return 'request_changes';
  if (e.noReport) return 'no_report';
  return 'done';
}

/** The mechanical first-person summary: what was worked, how it ended, one line of the result. No model call. */
export function episodeSummary(e: { task?: string; reason?: string; outcome: Outcome; result?: string }): string {
  const what = e.task ? `card ${e.task}` : e.reason === 'chat' ? 'a chat' : e.reason === 'routine' ? 'my routine' : `a ${e.reason ?? 'wake'}`;
  const ended = { done: 'Finished.', blocked: 'Blocked.', request_changes: 'Sent back with changes requested.', no_report: 'Ended without a report.', error: 'Ended in an error.' }[e.outcome];
  const line = (e.result ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return `Worked ${what}. ${ended}${line ? ` ${line.slice(0, 300)}` : ''}`.slice(0, 2000);
}

/** One row per finished wake. Idempotent on (agent, run): a wake-done run twice returns the first row. */
export async function recordEpisode(agent: Agent, e: EpisodeInput): Promise<{ episode: Episode; created: boolean }> {
  if (!e.run.trim()) throw new OrgError('an episode needs its run id');
  const reason = e.reason ?? (e.task ? 'task' : 'owner');
  if (!(EPISODE_REASONS as readonly string[]).includes(reason)) throw new OrgError(`episode reason is one of ${EPISODE_REASONS.join(', ')}, not "${reason}"`);
  const outcome = deriveOutcome(e);
  const { rows } = await query<Episode>(
    `INSERT INTO org_agent_episodes (agent_name, run_id, wakeup_ids, task_id, reason, outcome, turn_count, cost_usd, duration_s, summary, log_path)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (agent_name, run_id) DO NOTHING RETURNING ${EPISODE_COLS}`,
    [agent.name, e.run.trim(), e.wakeupIds ?? [], e.task ?? null, reason, outcome, e.turns ?? null, e.cost ?? null, e.duration ?? null, episodeSummary({ ...e, reason, outcome }), e.log ?? null],
  );
  if (rows[0]) return { episode: rows[0], created: true };
  const { rows: old } = await query<Episode>(`SELECT ${EPISODE_COLS} FROM org_agent_episodes WHERE agent_name = $1 AND run_id = $2`, [agent.name, e.run.trim()]);
  return { episode: old[0]!, created: false };
}

export async function listEpisodes(agent: string, limit = 20): Promise<Episode[]> {
  const { rows } = await query<Episode>(`SELECT ${EPISODE_COLS} FROM org_agent_episodes WHERE agent_name = $1 ORDER BY id DESC LIMIT $2`, [agent, Math.min(Math.max(limit, 1), 500)]);
  return rows;
}

/** A reviewer sent the card back: the builder's latest episode on it counts as corrected (the metric the ledger reads). */
export async function markCorrected(agent: string, taskId: string): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE org_agent_episodes SET corrected = true WHERE id = (SELECT id FROM org_agent_episodes WHERE agent_name = $1 AND task_id = $2 ORDER BY id DESC LIMIT 1)`,
    [agent, taskId],
  );
  return (rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Semantic memory: rows, the AUDN apply step, the core block
// ---------------------------------------------------------------------------

export interface MemoryRow {
  id: number;
  agent_name: string;
  kind: MemoryKind;
  content: string;
  evidence_episode_ids: number[];
  occurrences: number;
  active: boolean;
  retired_why: string | null;
  supersedes: number | null;
  promoted_to_proposal: boolean;
  proposal_task_id: string | null;
  proposed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const MEMORY_COLS = 'id, agent_name, kind, content, evidence_episode_ids::int[] AS evidence_episode_ids, occurrences, active, retired_why, supersedes, promoted_to_proposal, proposal_task_id, proposed_at, created_at, updated_at';

export async function listMemory(agent: string, opts: { all?: boolean; limit?: number } = {}): Promise<MemoryRow[]> {
  const { rows } = await query<MemoryRow>(
    `SELECT ${MEMORY_COLS} FROM org_agent_memory WHERE agent_name = $1 ${opts.all ? '' : 'AND active'} ORDER BY occurrences DESC, updated_at DESC, id DESC LIMIT $2`,
    [agent, Math.min(Math.max(opts.limit ?? 200, 1), 1000)],
  );
  return rows;
}

export type AudnOp =
  | { op: 'add'; kind: MemoryKind; content: string }
  | { op: 'update'; id: number; content?: string }
  | { op: 'delete'; id: number; reason: string }
  | { op: 'none' };

/** At most this many writes per reflection: a wake is one episode, not a rewrite of the bot's mind. */
export const MAX_OPS_PER_REFLECT = 6;

const AudnItem = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), kind: z.enum(MEMORY_KINDS), content: z.string().trim().min(1).max(500) }),
  z.object({ op: z.literal('update'), id: z.coerce.number().int().positive(), content: z.string().trim().min(1).max(500).optional() }),
  z.object({ op: z.literal('delete'), id: z.coerce.number().int().positive(), reason: z.string().trim().min(1).max(300) }),
  z.object({ op: z.literal('none') }),
]);

/**
 * The model's answer as AUDN ops. Tolerant of prose around the JSON and of `<think>` blocks; anything that is not
 * a valid op is dropped rather than failing the whole reflection (a bad line must never cost a wake its episode).
 */
export function parseAudn(text: string): AudnOp[] {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?/gi, '');
  const start = Math.min(...['[', '{'].map((c) => cleaned.indexOf(c)).filter((i) => i >= 0));
  if (!Number.isFinite(start)) return [];
  const end = Math.max(cleaned.lastIndexOf(']'), cleaned.lastIndexOf('}'));
  if (end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return [];
  }
  const items = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { ops?: unknown })?.ops) ? (parsed as { ops: unknown[] }).ops : [parsed];
  const ops: AudnOp[] = [];
  for (const it of items) {
    const r = AudnItem.safeParse(it);
    if (r.success) ops.push(r.data as AudnOp);
  }
  return ops.slice(0, MAX_OPS_PER_REFLECT);
}

const HANDOFF_WORDS = /\b(hand(?:s|ed)? ?off|handoff|handover|ask(?:s|ed)?|dm|route[sd]?|escalate[sd]?|delegate[sd]?|review(?:s|ed)? (?:by|from)|wait(?:s|ed)? for|pair(?:s|ed)? with)\b/i;

/**
 * A memory is written from its owner's point of view: it may name another agent only to describe a handoff ("I should
 * hand off X to vera sooner"), never to summarize that agent's work. Returns the offending name, or null.
 */
export function namesAnotherAgent(content: string, self: string, roster: string[]): string | null {
  const lower = ` ${content.toLowerCase()} `;
  for (const n of roster) {
    if (n === self) continue;
    if (new RegExp(`[^a-z0-9-]${n.replace(/[-]/g, '\\-')}(?:'s)?[^a-z0-9-]`).test(lower) && !HANDOFF_WORDS.test(content)) return n;
  }
  return null;
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

export interface ApplyResult {
  added: MemoryRow[];
  bumped: MemoryRow[];
  superseded: MemoryRow[];
  retired: number[];
  dropped: string[];
}

/**
 * Applies AUDN ops for one episode, in one transaction:
 *   add     a new row (occurrences 1); an add whose text matches an active row is a bump of that row instead
 *   update  occurrences + 1 and the episode appended as evidence; with new text, a new row supersedes the old one
 *   delete  active = false with the reason; never a hard delete
 *   none    nothing (the common case)
 * Ops that name a row of another agent, or content that is about another agent, are dropped and reported.
 */
export async function applyAudn(agent: Agent, episodeId: number, ops: AudnOp[], roster: string[]): Promise<ApplyResult> {
  const out: ApplyResult = { added: [], bumped: [], superseded: [], retired: [], dropped: [] };
  const active = await listMemory(agent.name, { limit: 1000 });
  const byId = new Map(active.map((r) => [r.id, r]));
  const byText = new Map(active.map((r) => [norm(r.content), r]));
  await withTransaction(async (tx) => {
    const bump = async (row: MemoryRow): Promise<MemoryRow> => {
      const { rows } = await tx.query<MemoryRow>(
        `UPDATE org_agent_memory SET occurrences = occurrences + 1,
                evidence_episode_ids = CASE WHEN $2 = ANY (evidence_episode_ids) THEN evidence_episode_ids ELSE evidence_episode_ids || $2::bigint END,
                updated_at = now()
          WHERE id = $1 AND active RETURNING ${MEMORY_COLS}`,
        [row.id, episodeId],
      );
      return rows[0]!;
    };
    for (const op of ops.slice(0, MAX_OPS_PER_REFLECT)) {
      if (op.op === 'none') continue;
      if (op.op === 'add') {
        const other = namesAnotherAgent(op.content, agent.name, roster);
        if (other) {
          out.dropped.push(`add: names ${other} (a memory is about my own work)`);
          continue;
        }
        const dup = byText.get(norm(op.content));
        if (dup) {
          const b = await bump(dup);
          byId.set(b.id, b);
          out.bumped.push(b);
          continue;
        }
        const { rows } = await tx.query<MemoryRow>(
          `INSERT INTO org_agent_memory (agent_name, kind, content, evidence_episode_ids) VALUES ($1,$2,$3,$4) RETURNING ${MEMORY_COLS}`,
          [agent.name, op.kind, op.content.replace(/\s+/g, ' ').trim(), [episodeId]],
        );
        out.added.push(rows[0]!);
        byText.set(norm(rows[0]!.content), rows[0]!);
        continue;
      }
      const row = byId.get(op.id);
      if (!row) {
        out.dropped.push(`${op.op} #${op.id}: not one of my active memories`);
        continue;
      }
      if (op.op === 'delete') {
        await tx.query(`UPDATE org_agent_memory SET active = false, retired_why = $2, updated_at = now() WHERE id = $1`, [row.id, op.reason.slice(0, 300)]);
        byId.delete(row.id);
        byText.delete(norm(row.content));
        out.retired.push(row.id);
        continue;
      }
      // update
      const text = op.content?.replace(/\s+/g, ' ').trim();
      if (text && norm(text) !== norm(row.content)) {
        const other = namesAnotherAgent(text, agent.name, roster);
        if (other) {
          out.dropped.push(`update #${row.id}: names ${other} (a memory is about my own work)`);
          continue;
        }
        const { rows } = await tx.query<MemoryRow>(
          `INSERT INTO org_agent_memory (agent_name, kind, content, evidence_episode_ids, occurrences, supersedes, promoted_to_proposal, proposal_task_id, proposed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${MEMORY_COLS}`,
          [agent.name, row.kind, text, [...new Set([...row.evidence_episode_ids, episodeId])], row.occurrences + 1, row.id, row.promoted_to_proposal, row.proposal_task_id, row.proposed_at],
        );
        await tx.query(`UPDATE org_agent_memory SET active = false, retired_why = $2, updated_at = now() WHERE id = $1`, [row.id, `superseded by #${rows[0]!.id}`]);
        byId.delete(row.id);
        byId.set(rows[0]!.id, rows[0]!);
        byText.delete(norm(row.content));
        byText.set(norm(text), rows[0]!);
        out.superseded.push(rows[0]!);
      } else {
        const b = await bump(row);
        byId.set(b.id, b);
        out.bumped.push(b);
      }
    }
  });
  return out;
}

/** The owner or a lead corrects a bot's memory: the old row is closed and the correction supersedes it. */
export async function editMemory(caller: Agent, id: number, content: string): Promise<MemoryRow> {
  const row = await ownedRow(caller, id);
  const text = content.replace(/\s+/g, ' ').trim();
  if (!text || text.length > 500) throw new OrgError('a memory is 1 to 500 characters, one first-person claim');
  return withTransaction(async (tx) => {
    const { rows } = await tx.query<MemoryRow>(
      `INSERT INTO org_agent_memory (agent_name, kind, content, evidence_episode_ids, occurrences, supersedes, promoted_to_proposal, proposal_task_id, proposed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${MEMORY_COLS}`,
      [row.agent_name, row.kind, text, row.evidence_episode_ids, row.occurrences, row.id, row.promoted_to_proposal, row.proposal_task_id, row.proposed_at],
    );
    await tx.query(`UPDATE org_agent_memory SET active = false, retired_why = $2, updated_at = now() WHERE id = $1`, [row.id, `edited by ${caller.name}: superseded by #${rows[0]!.id}`]);
    return rows[0]!;
  });
}

/** Closes a line; returns the agent whose core block now needs re-rendering. */
export async function retireMemory(caller: Agent, id: number, why: string): Promise<string> {
  const row = await ownedRow(caller, id);
  if (!why.trim()) throw new OrgError('memory retire <id> "<why>": say why it no longer holds');
  await query(`UPDATE org_agent_memory SET active = false, retired_why = $2, updated_at = now() WHERE id = $1`, [row.id, `${caller.name}: ${why.trim().slice(0, 280)}`]);
  return row.agent_name;
}

/** A human edits any bot's memory, a lead its team's; a bot's own memory is written only by its reflect step. */
async function ownedRow(caller: Agent, id: number): Promise<MemoryRow> {
  const { rows } = await query<MemoryRow>(`SELECT ${MEMORY_COLS} FROM org_agent_memory WHERE id = $1`, [id]);
  const row = rows[0];
  if (!row) throw new OrgError(`no memory #${id}`);
  if (!row.active) throw new OrgError(`memory #${id} is already closed (${row.retired_why ?? 'retired'})`);
  if (caller.runtime === 'human') return row;
  const { rowCount } = await query(`SELECT 1 FROM org_agents a JOIN teams t ON t.slug = a.team_slug WHERE a.name = $1 AND t.lead = $2`, [row.agent_name, caller.name]);
  if (!rowCount) throw new OrgError(`${caller.name} can't edit ${row.agent_name}'s memory: the owner or ${row.agent_name}'s lead does, and a bot's own memory is written by its reflect step`);
  return row;
}

/** Four characters a token: a budget, not a tokenizer. */
export const estimateTokens = (s: string): number => Math.ceil(s.length / 4);

const KIND_TITLES: Record<MemoryKind, string> = { lesson: 'Lessons', anti_pattern: 'Anti-patterns', preference: 'Preferences', friction: 'Friction' };

/**
 * The core block: the active rows under the token budget, chosen by occurrences desc then recency (a lesson seen
 * five times outranks one seen once), grouped by kind in the text. Returns the markdown and the ids it kept.
 */
export function renderCore(agent: string, rows: MemoryRow[], budgetTokens: number): { text: string; kept: number[]; dropped: number[] } {
  const head = `# ${agent}: core memory\n\nGenerated by \`cli-org reflect\` from my own episodes; the owner or my lead corrects a line with \`cli-org memory edit|retire\`, never by hand. Each line is one first-person claim: [id, times seen, last seen].\n`;
  const ranked = [...rows].filter((r) => r.active).sort((a, b) => b.occurrences - a.occurrences || new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime() || b.id - a.id);
  const kept: MemoryRow[] = [];
  const dropped: number[] = [];
  const render = (xs: MemoryRow[]): string => {
    const groups = MEMORY_KINDS.map((k) => ({ k, items: xs.filter((r) => r.kind === k) })).filter((g) => g.items.length);
    return `${head}${groups.map((g) => `\n## ${KIND_TITLES[g.k]}\n${g.items.map((r) => `- [m-${r.id} ×${r.occurrences} · ${new Date(r.updated_at).toISOString().slice(0, 10)}] ${r.content}`).join('\n')}\n`).join('')}`;
  };
  for (const r of ranked) {
    if (estimateTokens(render([...kept, r])) <= budgetTokens) kept.push(r);
    else dropped.push(r.id);
  }
  return { text: render(kept), kept: kept.map((r) => r.id), dropped };
}

export const corePath = (vaultRoot: string, agent: string): string => join(vaultRoot, '.agents', 'org', 'memory', agent, 'core.md');

/** Re-renders the generated core block from the active rows. Returns the path, or null when the vault isn't here. */
export async function writeCore(vaultRoot: string, agent: string, budgetTokens: number): Promise<{ path: string; kept: number[]; dropped: number[] } | null> {
  if (!existsSync(join(vaultRoot, '.agents', 'org'))) return null;
  const rows = await listMemory(agent, { limit: 1000 });
  const { text, kept, dropped } = renderCore(agent, rows, budgetTokens);
  const path = corePath(vaultRoot, agent);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  return { path, kept, dropped };
}

// ---------------------------------------------------------------------------
// The reflect step
// ---------------------------------------------------------------------------

export type Completer = (system: string, user: string) => Promise<string>;

/**
 * The cheap model for reflections: ORG_REFLECT_MODEL or the agent's `reflect.model`; `cheap` is the local provider
 * (Ollama, no key) first and the catalog's default keyed provider after it; `off` disables the model step. A
 * `<provider>/<model>` names one. Returns the candidates in order; the caller tries them until one answers.
 */
export function reflectProviders(spec: string, environment: NodeJS.ProcessEnv = process.env): ChatProvider[] {
  // The operator's ORG_REFLECT_MODEL says what `cheap` means here and can turn the step off; an agent's explicit
  // <provider>/<model> wins over the operator's `cheap` but never over `off`.
  const envSpec = (environment.ORG_REFLECT_MODEL ?? 'cheap').trim() || 'cheap';
  if (envSpec === 'off' || spec === 'off') return [];
  const want = spec && spec !== 'cheap' ? spec.trim() : envSpec;
  const catalog = providerCatalog(undefined, environment);
  const out: ChatProvider[] = [];
  const tryBuild = (id: string, model?: string): void => {
    const p = catalog.providers.find((x) => x.id === id && x.configured);
    if (!p) return;
    try {
      out.push(buildChatProvider(id, model ?? p.default, { environment }));
    } catch {
      /* not configured here */
    }
  };
  if (want !== 'cheap') {
    const slash = want.indexOf('/');
    if (slash <= 0) throw new OrgError(`reflect model "${want}" is cheap, off, or <provider>/<model>`);
    tryBuild(want.slice(0, slash), want.slice(slash + 1));
    return out;
  }
  tryBuild('ollama');
  const fallback = pickProvider(catalog, catalog.defaultProvider);
  if (fallback && fallback.id !== 'ollama') tryBuild(fallback.id);
  return out;
}

export function completerFor(providers: ChatProvider[], timeoutMs = 90_000): Completer | null {
  if (!providers.length) return null;
  return async (system, user) => {
    let last: Error | null = null;
    for (const p of providers) {
      try {
        const { text } = await complete(p, { system, messages: [{ role: 'user', content: user }], maxTokens: 800, temperature: 0, signal: AbortSignal.timeout(timeoutMs) });
        return text;
      } catch (err) {
        last = err as Error;
        log.warn(`reflect: ${p.id}/${p.model} failed (${(err as Error).message.slice(0, 200)})`);
      }
    }
    throw last ?? new Error('no reflect model answered');
  };
}

/**
 * Tool calls and their results from a run log, nothing else: a Claude Code JSONL (tool_use / tool_result blocks), or
 * for a plain text log the lines that look like commands. Capped: the reflect call reads an excerpt, not the run.
 */
export function logExcerpt(path: string | undefined, maxChars = 6000): string {
  if (!path) return '';
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return '';
  }
  const parts: string[] = [];
  const lines = raw.split('\n');
  let jsonl = false;
  for (const line of lines) {
    if (!line.trim().startsWith('{')) continue;
    let obj: { message?: { content?: unknown }; type?: string; content?: unknown };
    try {
      obj = JSON.parse(line) as typeof obj;
    } catch {
      continue;
    }
    jsonl = true;
    const content = obj.message?.content ?? obj.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as { type?: string; name?: string; input?: unknown; content?: unknown }[]) {
      if (b.type === 'tool_use') parts.push(`> ${b.name ?? 'tool'} ${JSON.stringify(b.input ?? {}).slice(0, 240)}`);
      else if (b.type === 'tool_result') {
        const c = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? (b.content as { text?: string }[]).map((x) => x.text ?? '').join(' ') : '';
        if (c.trim()) parts.push(`  ${c.replace(/\s+/g, ' ').trim().slice(0, 300)}`);
      }
    }
  }
  if (!jsonl) parts.push(...lines.filter((l) => /^(\$ |> |error|fail|blocked)/i.test(l.trim())).map((l) => l.trim().slice(0, 300)));
  const text = parts.join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars / 2)}\n…\n${text.slice(-maxChars / 2)}` : text;
}

export function reflectPrompt(agent: Agent, episode: Episode, excerpt: string, current: MemoryRow[]): { system: string; user: string } {
  const system = [
    `You are ${agent.name}, ${agent.role}. You just finished one run of your work. Write what you, personally, would want to remember before your next wake: a lesson about how you do your job, an anti-pattern to avoid, a preference about the work, or a friction you hit (a correction you received, a reason you were blocked, a tool you misused).`,
    'Write in the first person ("I ..."). Only about your own run: never summarize another agent\'s work; name another agent only to describe a handoff.',
    'Most runs produce nothing durable: answer [{"op":"none"}] unless something would change what you do next time.',
    `Answer with JSON only, a list of at most ${MAX_OPS_PER_REFLECT} operations against your current memory:`,
    '  {"op":"add","kind":"lesson|anti_pattern|preference|friction","content":"one claim, under 400 characters"}',
    '  {"op":"update","id":<existing id>}                       the same thing happened again',
    '  {"op":"update","id":<existing id>,"content":"..."}      the memory needs new wording',
    '  {"op":"delete","id":<existing id>,"reason":"..."}       it no longer holds',
    '  {"op":"none"}',
  ].join('\n');
  const mem = current.length ? current.map((r) => `#${r.id} [${r.kind}, seen ${r.occurrences}×] ${r.content}`).join('\n') : '(empty)';
  const user = [
    `Episode #${episode.id} (${episode.reason}, outcome ${episode.outcome}${episode.corrected ? ', corrected' : ''}${episode.turn_count !== null ? `, ${episode.turn_count} turns` : ''}):`,
    episode.summary,
    excerpt ? `\nTool calls and results from the run:\n${excerpt}` : '',
    `\nMy current memory:\n${mem}`,
    '\nOperations (JSON list):',
  ].join('\n');
  return { system, user };
}

export interface ReflectOpts extends EpisodeInput {
  vaultRoot?: string;
  settings?: AgentMemorySettings;
  /** The model call; null skips it (episode only). Tests pass a fake. */
  completer?: Completer | null;
  /** The run's transcript or log to excerpt for the model; defaults to `log`. */
  transcript?: string;
  /** Reflections already run today, for the daily cap. */
  maxPerDay?: number;
  dryRun?: boolean;
}

export interface ReflectResult {
  episode: Episode;
  created: boolean;
  reflected: boolean;
  skipped: string | null;
  ops: AudnOp[];
  applied: ApplyResult | null;
  core: { path: string; kept: number[]; dropped: number[] } | null;
  proposals: ProposalResult[];
}

/**
 * The write pipeline after a wake: the episode row (always, mechanical), then, when the agent's config says so and
 * the run was long enough, one cheap-model call proposing AUDN ops against the active memory, applied in one
 * transaction; the core block re-rendered; and any row that crossed the repeat threshold proposed as a
 * self-improvement card. A failed model call is logged and skipped: it never fails the wake it reflects on.
 */
export async function reflect(agent: Agent, opts: ReflectOpts): Promise<ReflectResult> {
  const vaultRoot = opts.vaultRoot ?? config.vaultRoot;
  const settings = opts.settings ?? memorySettingsFor(vaultRoot, agent.name);
  const cfg = settings.memory;
  const { episode, created } = await recordEpisode(agent, opts);
  const result: ReflectResult = { episode, created, reflected: false, skipped: null, ops: [], applied: null, core: null, proposals: [] };
  const trigger = opts.reason === 'chat' ? 'chat_end' : 'wake_done';
  if (!cfg.tiers.includes('semantic')) result.skipped = 'semantic tier is off for this agent';
  else if (!cfg.reflect.enabled) result.skipped = 'reflect is off for this agent';
  else if (!cfg.reflect.trigger.includes(trigger)) result.skipped = `reflect does not run on ${trigger} for this agent`;
  else if (!created && episode.reflected_at) result.skipped = `run ${episode.run_id} was already reflected on`;
  else if ((episode.turn_count ?? 0) < cfg.reflect.min_turns) result.skipped = `run too short (${episode.turn_count ?? 0} < ${cfg.reflect.min_turns} turns)`;
  else {
    const cap = opts.maxPerDay ?? config.orgReflectMaxPerDay;
    const { rows } = await query<{ n: number }>(`SELECT count(*)::int AS n FROM org_agent_episodes WHERE reflected_at > now() - interval '1 day'`);
    if (rows[0]!.n >= cap) result.skipped = `daily reflect cap reached (${cap})`;
  }
  const completer = opts.completer === undefined ? completerFor(reflectProviders(cfg.reflect.model)) : opts.completer;
  if (!result.skipped && !completer) result.skipped = 'no reflect model (ORG_REFLECT_MODEL=off, or no provider)';
  if (result.skipped) {
    if (created) result.core = await writeCore(vaultRoot, agent.name, cfg.core_budget_tokens);
    return result;
  }
  const roster = (await query<{ name: string }>(`SELECT name FROM org_agents WHERE retired_at IS NULL`)).rows.map((r) => r.name);
  const current = await listMemory(agent.name, { limit: 200 });
  const { system, user } = reflectPrompt(agent, episode, logExcerpt(opts.transcript ?? opts.log), current);
  let text: string;
  try {
    text = await completer!(system, user);
  } catch (err) {
    result.skipped = `reflect model failed: ${(err as Error).message.slice(0, 200)}`;
    log.warn(`reflect ${agent.name} run ${episode.run_id}: ${result.skipped}`);
    return result;
  }
  result.ops = parseAudn(text);
  if (opts.dryRun) return result;
  result.applied = await applyAudn(agent, episode.id, result.ops, roster);
  await query(`UPDATE org_agent_episodes SET reflected_at = now(), reflect_model = $2 WHERE id = $1`, [episode.id, 'reflect']);
  result.reflected = true;
  result.core = await writeCore(vaultRoot, agent.name, cfg.core_budget_tokens);
  if (cfg.self_improvement.enabled) {
    const due = [...result.applied.bumped, ...result.applied.superseded].filter((r) => r.occurrences >= cfg.self_improvement.repeat_threshold && !r.promoted_to_proposal && PROPOSAL_KINDS.includes(r.kind));
    for (const row of due) {
      try {
        result.proposals.push(await proposeImprovement(agent, row.id, { vaultRoot, settings, completer }));
      } catch (err) {
        result.proposals.push({ memory_id: row.id, card: null, refused: (err as Error).message, diff: null, target: null, rationale: null });
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Metrics: the per-agent numbers the ledger reads
// ---------------------------------------------------------------------------

export interface MemoryStats {
  agent: string;
  days: number;
  episodes: number;
  done: number;
  corrected: number;
  /** corrections per completed card: the ratchet metric. Null when nothing was completed. */
  corrections_per_done: number | null;
  cost_per_done: number | null;
  avg_turns: number | null;
  reflected: number;
  memory: { active: number; by_kind: Record<string, number> };
  proposals: number;
}

export async function memoryStats(agent: string, days = 14): Promise<MemoryStats> {
  const d = Math.min(Math.max(days, 1), 365);
  const { rows } = await query<{ episodes: number; done: number; corrected: number; cost: string | null; turns: string | null; reflected: number }>(
    `SELECT count(*)::int AS episodes,
            count(*) FILTER (WHERE outcome = 'done')::int AS done,
            count(*) FILTER (WHERE outcome = 'done' AND corrected)::int AS corrected,
            sum(cost_usd) FILTER (WHERE outcome = 'done') AS cost,
            avg(turn_count) AS turns,
            count(*) FILTER (WHERE reflected_at IS NOT NULL)::int AS reflected
       FROM org_agent_episodes WHERE agent_name = $1 AND created_at > now() - make_interval(days => $2)`,
    [agent, d],
  );
  const e = rows[0]!;
  const { rows: mem } = await query<{ kind: string; n: number }>(`SELECT kind, count(*)::int AS n FROM org_agent_memory WHERE agent_name = $1 AND active GROUP BY kind`, [agent]);
  const { rows: props } = await query<{ n: number }>(`SELECT count(*)::int AS n FROM org_agent_memory WHERE agent_name = $1 AND proposal_task_id IS NOT NULL`, [agent]);
  return {
    agent,
    days: d,
    episodes: e.episodes,
    done: e.done,
    corrected: e.corrected,
    corrections_per_done: e.done ? Number((e.corrected / e.done).toFixed(3)) : null,
    cost_per_done: e.done && e.cost !== null ? Number((Number(e.cost) / e.done).toFixed(4)) : null,
    avg_turns: e.turns !== null ? Number(Number(e.turns).toFixed(1)) : null,
    reflected: e.reflected,
    memory: { active: mem.reduce((n, r) => n + r.n, 0), by_kind: Object.fromEntries(mem.map((r) => [r.kind, r.n])) },
    proposals: props[0]!.n,
  };
}

// ---------------------------------------------------------------------------
// Self-improvement: propose, never apply
// ---------------------------------------------------------------------------

/** Kinds that may turn into a proposal: a repeated friction or anti-pattern, not a preference. */
export const PROPOSAL_KINDS: readonly MemoryKind[] = ['friction', 'anti_pattern'];
/** A proposal is a patch: more changed lines than this is a rewrite and is refused. */
export const PROPOSAL_MAX_CHANGED_LINES = 40;
/** The prose keys of an agent's org.yaml entry a proposal may change. Everything else is identical before and after. */
export const PROSE_KEYS = ['personality', 'goal', 'perspective', 'style', 'voice', 'principles', 'description'] as const;
/** Keys a proposal may never touch, named in the refusal when it tries. */
export const GUARDED_KEYS = ['tools', 'permission_mode', 'model', 'wakes_per_day', 'capabilities', 'runtime', 'team', 'reports_to', 'channels', 'knowledge', 'lane', 'routines', 'memory', 'work'] as const;
/** Vault files no proposal may target, whatever the config says: the harness and the owner's rules. */
const HARD_DENY = [/^AGENTS(\.base|\.local)?\.md$/, /^CLAUDE\.md$/, /^\.claude\//, /^\.agents\/guard/, /^\.agents\/org\//, /^\.agents\/improve\//, /^\.hermes\//, /(^|\/)hooks\//, /(^|\/)lanes\.toml$/, /^CURRENT\//, /^Areas\/Finance\//, /(^|\/)\.env/, /^\.secondbrain\//];

/** One file per agent in the split config directory (`config/agents/<name>.yaml`); the whole file is its block. */
export const agentFilePath = (agent: string): string => `.agents/org/config/agents/${agent}.yaml`;

export type ProposalTarget = { kind: 'own_prompt'; path: string } | { kind: 'own_skills'; path: string };

/** The agent's block of org.yaml (`agents:` → `  <name>:` to the next sibling key), as lines; null when absent. */
export function extractAgentBlock(yaml: string, agent: string): { start: number; end: number; lines: string[] } | null {
  const lines = yaml.split('\n');
  const agentsAt = lines.findIndex((l) => /^agents:\s*$/.test(l));
  if (agentsAt < 0) return null;
  let start = -1;
  let indent = '';
  for (let i = agentsAt + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^\S/.test(l) && l.trim()) break;
    const m = new RegExp(`^(\\s+)${agent}:\\s*$`).exec(l);
    if (m) {
      start = i;
      indent = m[1]!;
      break;
    }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l.trim()) continue;
    const lead = /^(\s*)/.exec(l)![1]!;
    if (lead.length <= indent.length) {
      end = i;
      break;
    }
  }
  while (end > start + 1 && !lines[end - 1]!.trim()) end--;
  return { start, end, lines: lines.slice(start, end) };
}

/** Top-level keys of an agent block → their raw text (key line plus its nested lines). */
export function blockKeys(block: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!block.length) return out;
  const head = /^(\s*)/.exec(block[0]!)![1]!.length;
  let key: string | null = null;
  let buf: string[] = [];
  const flush = (): void => {
    if (key !== null) out.set(key, buf.join('\n'));
  };
  for (const l of block.slice(1)) {
    const lead = /^(\s*)/.exec(l)![1]!.length;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_-]*):/.exec(l);
    if (m && l.trim() && lead === head + 2) {
      flush();
      key = m[1]!;
      buf = [l];
    } else buf.push(l);
  }
  flush();
  return out;
}

/** A line diff (LCS) in unified style without hunk headers; `changed` counts added plus removed lines. */
export function lineDiff(before: string, after: string, label: string): { text: string; changed: number } {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length > 2000 || b.length > 2000) throw new OrgError('target too large to diff');
  const n = a.length;
  const m = b.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: string[] = [`--- a/${label}`, `+++ b/${label}`];
  let i = 0;
  let j = 0;
  let changed = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push(` ${a[i]}`);
      i++;
      j++;
    } else if (i < n && (j >= m || dp[i + 1]![j]! >= dp[i]![j + 1]!)) {
      out.push(`-${a[i]}`);
      i++;
      changed++;
    } else {
      out.push(`+${b[j]}`);
      j++;
      changed++;
    }
  }
  return { text: out.join('\n'), changed };
}

function normalizePath(p: string): string {
  const n = normalize(p).split(sep).join('/').replace(/^\.\//, '');
  return n;
}

/**
 * Whether a proposal is within what a bot may propose about itself. Hard-coded, never configuration. Throws an
 * OrgError that names the exact field or rule it broke. Returns the diff when it is in bounds.
 */
export function validateProposal(agent: string, settings: AgentMemorySettings, target: ProposalTarget, before: string, after: string): { diff: string; changed: number } {
  const si = settings.memory.self_improvement;
  if (!si.targets.includes(target.kind)) throw new OrgError(`refused: ${target.kind} is not in this agent's self_improvement.targets`);
  if (!after.trim()) throw new OrgError('refused: the proposal empties the target');
  if (before === after) throw new OrgError('refused: the proposal changes nothing');
  if (target.kind === 'own_prompt') {
    const ownFile = agentFilePath(agent);
    if (target.path !== '.agents/org/org.yaml' && target.path !== ownFile) throw new OrgError(`refused: own_prompt targets ${ownFile} or .agents/org/org.yaml only`);
    // An agent file is the block without its `<name>:` header: wrap it so both layouts compare key by key.
    const asBlock = (t: string): string[] => (target.path === ownFile ? [`${agent}:`, ...t.split('\n').map((l) => (l ? `  ${l}` : l))] : t.split('\n'));
    const b = blockKeys(asBlock(before));
    const a = blockKeys(asBlock(after));
    if (target.path !== ownFile && before.split('\n')[0] !== after.split('\n')[0]) throw new OrgError(`refused: the diff renames the agent block (${before.split('\n')[0]!.trim()})`);
    for (const key of new Set([...b.keys(), ...a.keys()])) {
      if ((PROSE_KEYS as readonly string[]).includes(key)) continue;
      if (b.get(key) !== a.get(key)) throw new OrgError(`refused: the diff touches "${key}"; only ${PROSE_KEYS.join(', ')} may change`);
    }
  } else {
    const p = normalizePath(target.path);
    if (isAbsolute(target.path) || p.startsWith('..') || p.includes('/../')) throw new OrgError(`refused: skill target "${target.path}" is not a vault-relative path`);
    if (HARD_DENY.some((re) => re.test(p))) throw new OrgError(`refused: "${p}" is a harness or owner file, never a self-improvement target`);
    if (!/\.md$/i.test(p)) throw new OrgError(`refused: skill target "${p}" is not a markdown file`);
    const under = settings.knowledge.map(normalizePath).some((k) => k && (p === k || p.startsWith(`${k.replace(/\/+$/, '')}/`)));
    if (!under) throw new OrgError(`refused: "${p}" is outside ${agent}'s knowledge paths (${settings.knowledge.join(', ') || 'none'})`);
  }
  const { text, changed } = lineDiff(before, after, target.path);
  if (changed > PROPOSAL_MAX_CHANGED_LINES) throw new OrgError(`refused: ${changed} changed lines; a proposal is a patch of at most ${PROPOSAL_MAX_CHANGED_LINES}, not a rewrite`);
  return { diff: text, changed };
}

export interface ProposalResult {
  memory_id: number;
  target: ProposalTarget | null;
  rationale: string | null;
  diff: string | null;
  /** The card, or null when the proposal was refused or not filed (dry run, cap). */
  card: { id: string; title: string } | null;
  refused: string | null;
}

const ProposalAnswer = z.object({
  target: z.string().trim().min(1),
  after: z.string().min(1),
  rationale: z.string().trim().min(1).max(1500),
});

export function parseProposal(text: string): z.infer<typeof ProposalAnswer> | null {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const r = ProposalAnswer.safeParse(JSON.parse(cleaned.slice(start, end + 1)));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** The files a proposal for this agent may read and change: its org.yaml block, and the skill files under its knowledge. */
export function proposalTargets(vaultRoot: string, agent: string, settings: AgentMemorySettings): { target: ProposalTarget; before: string }[] {
  const out: { target: ProposalTarget; before: string }[] = [];
  const si = settings.memory.self_improvement;
  if (si.targets.includes('own_prompt')) {
    const own = agentFilePath(agent);
    if (existsSync(join(vaultRoot, own))) out.push({ target: { kind: 'own_prompt', path: own }, before: readFileSync(join(vaultRoot, own), 'utf8') });
    else {
      try {
        const block = extractAgentBlock(readFileSync(join(vaultRoot, '.agents', 'org', 'org.yaml'), 'utf8'), agent);
        if (block) out.push({ target: { kind: 'own_prompt', path: '.agents/org/org.yaml' }, before: block.lines.join('\n') });
      } catch {
        /* no org.yaml here */
      }
    }
  }
  if (si.targets.includes('own_skills')) {
    for (const k of settings.knowledge) {
      const p = normalizePath(k);
      if (HARD_DENY.some((re) => re.test(p))) continue;
      for (const f of [p, `${p.replace(/\/+$/, '')}/SKILL.md`]) {
        if (!/\.md$/i.test(f)) continue;
        try {
          const text = readFileSync(join(vaultRoot, f), 'utf8');
          if (!out.some((t) => t.target.path === f)) out.push({ target: { kind: 'own_skills', path: f }, before: text });
        } catch {
          /* not a file */
        }
      }
    }
  }
  return out;
}

export function proposalPrompt(agent: Agent, row: MemoryRow, episodes: Episode[], targets: { target: ProposalTarget; before: string }[]): { system: string; user: string } {
  const system = [
    `You are ${agent.name}, ${agent.role}. The same friction has come up ${row.occurrences} times in your runs. Propose the smallest change to one of your own files that would stop it: a few lines of your prompt's prose (personality, goal, perspective, style) or a few lines of one of your skill files.`,
    'You may not change tools, permissions, models, wake limits, capabilities or anything but prose; such a proposal is refused. A rewrite is refused: change at most a few lines.',
    'Write the rationale in the first person ("I keep doing X because my prompt says Y; I would do better if it said Z").',
    'Answer with JSON only: {"target": "<one of the target paths>", "after": "<the complete new text of that target, with your change applied>", "rationale": "<one paragraph>"}',
  ].join('\n');
  const user = [
    `Friction #${row.id} [${row.kind}]: ${row.content}`,
    `Evidence:\n${episodes.map((e) => `- episode #${e.id} (${e.outcome}${e.corrected ? ', corrected' : ''}): ${e.summary}`).join('\n') || '- (none recorded)'}`,
    ...targets.map((t) => `\nTarget ${t.target.path} (${t.target.kind}), current text:\n${t.before}`),
    '\nJSON:',
  ].join('\n');
  return { system, user };
}

export async function proposalsThisWeek(agent: string): Promise<number> {
  const { rows } = await query<{ n: number }>(`SELECT count(*)::int AS n FROM org_agent_memory WHERE agent_name = $1 AND proposed_at > now() - interval '7 days'`, [agent]);
  return rows[0]!.n;
}

export interface ProposeOpts {
  vaultRoot?: string;
  settings?: AgentMemorySettings;
  completer?: Completer | null;
  /** Skip the model: the caller supplies the proposal (tests, or a lead drafting one by hand). */
  answer?: { target: string; after: string; rationale: string };
  dryRun?: boolean;
}

/**
 * One self-improvement card from one recurring memory row: the model drafts the change against the exact current
 * text of the target, the validator bounds it, and the card goes to the owner's backlog (kind `improve`, authored by
 * the agent, never assigned to a bot, never applied here). Applying it is a human editing the file and recompiling,
 * the same way any org.yaml or skill change ships today; there is no ship-now path for a bot's self-change.
 */
export async function proposeImprovement(agent: Agent, memoryId: number, opts: ProposeOpts = {}): Promise<ProposalResult> {
  const vaultRoot = opts.vaultRoot ?? config.vaultRoot;
  const settings = opts.settings ?? memorySettingsFor(vaultRoot, agent.name);
  const si = settings.memory.self_improvement;
  const res: ProposalResult = { memory_id: memoryId, target: null, rationale: null, diff: null, card: null, refused: null };
  const refuse = async (why: string): Promise<ProposalResult> => {
    res.refused = why;
    log.warn(`propose-improvement ${agent.name} #${memoryId}: ${why}`);
    return res;
  };
  if (!si.enabled) return refuse('refused: self_improvement is off for this agent');
  const { rows } = await query<MemoryRow>(`SELECT ${MEMORY_COLS} FROM org_agent_memory WHERE id = $1 AND agent_name = $2`, [memoryId, agent.name]);
  const row = rows[0];
  if (!row) throw new OrgError(`no memory #${memoryId} for ${agent.name}`);
  if (!row.active) return refuse(`refused: memory #${memoryId} is closed`);
  if (row.promoted_to_proposal) return refuse(`refused: memory #${memoryId} already filed a proposal (${row.proposal_task_id ?? 'denied'}); it needs fresh evidence first`);
  if (row.occurrences < si.repeat_threshold) return refuse(`refused: seen ${row.occurrences}×, the threshold is ${si.repeat_threshold}`);
  if ((await proposalsThisWeek(agent.name)) >= si.max_proposals_per_week) return refuse(`refused: ${si.max_proposals_per_week} proposal(s) a week already filed`);
  const targets = proposalTargets(vaultRoot, agent.name, settings);
  if (!targets.length) return refuse('refused: no target file here (no org.yaml block or knowledge file in this vault checkout)');
  let answer = opts.answer ?? null;
  if (!answer) {
    const completer = opts.completer === undefined ? completerFor(reflectProviders(settings.memory.reflect.model)) : opts.completer;
    if (!completer) return refuse('refused: no model to draft the proposal');
    const episodes = row.evidence_episode_ids.length
      ? (await query<Episode>(`SELECT ${EPISODE_COLS} FROM org_agent_episodes WHERE id = ANY ($1) ORDER BY id`, [row.evidence_episode_ids])).rows
      : [];
    const { system, user } = proposalPrompt(agent, row, episodes, targets);
    let text: string;
    try {
      text = await completer(system, user);
    } catch (err) {
      return refuse(`model failed: ${(err as Error).message.slice(0, 200)}`);
    }
    answer = parseProposal(text);
    if (!answer) return refuse('refused: the model gave no usable proposal');
  }
  const chosen = targets.find((t) => t.target.path === normalizePath(answer!.target));
  if (!chosen) return refuse(`refused: "${answer.target}" is not one of ${agent.name}'s own files (${targets.map((t) => t.target.path).join(', ')})`);
  res.target = chosen.target;
  res.rationale = answer.rationale;
  let diff: string;
  try {
    ({ diff } = validateProposal(agent.name, settings, chosen.target, chosen.before, answer.after.replace(/\n$/, chosen.before.endsWith('\n') ? '\n' : '')));
  } catch (err) {
    if (err instanceof OrgError) return refuse(err.message);
    throw err;
  }
  res.diff = diff;
  if (opts.dryRun) return res;
  const where = chosen.target.kind === 'own_prompt' ? `my prompt (${chosen.target.path}, agents.${agent.name})` : `my skill file ${chosen.target.path}`;
  const body = [
    `Self-improvement proposal from ${agent.name}: memory #${row.id} (${row.kind}, seen ${row.occurrences}×).`,
    '',
    `**Target:** ${where}`,
    `**Rationale:** ${answer.rationale}`,
    `**Evidence:** episodes ${row.evidence_episode_ids.map((i) => `#${i}`).join(', ') || '(none recorded)'}`,
    '',
    '```diff',
    diff,
    '```',
    '',
    `To apply: make this edit in the vault, recompile the org (compile.py) and re-import; the change is then measured for two weeks against this agent's corrections per completed card (\`cli-org memory stats ${agent.name}\`) and reverted if it does not move. To deny: close this card. Either way the memory stays; the same friction re-proposes only after fresh evidence. A bot never applies a change to itself.`,
  ].join('\n');
  const title = `self-improvement: ${agent.name}, ${row.content.slice(0, 120)}`.slice(0, 200);
  const r = await createTask(agent, { assignee: null, title, body, kind: 'improve', priority: 3 });
  await query(`UPDATE org_agent_memory SET promoted_to_proposal = true, proposal_task_id = $2, proposed_at = now(), updated_at = now() WHERE id = $1`, [row.id, r.task_id]);
  res.card = { id: r.task_id, title };
  return res;
}

/** Memory rows that filed a proposal, newest first: the Proposals section of /org/agents/<name>. */
export async function listProposals(agent: string, limit = 20): Promise<(MemoryRow & { card_status: string | null; card_title: string | null })[]> {
  const { rows } = await query<MemoryRow & { card_status: string | null; card_title: string | null }>(
    `SELECT ${MEMORY_COLS.replace(/(^|, )(?=[a-z])/g, '$1m.')}, c.status AS card_status, c.title AS card_title FROM org_agent_memory m LEFT JOIN cards c ON c.id = m.proposal_task_id
      WHERE m.agent_name = $1 AND m.proposal_task_id IS NOT NULL ORDER BY m.proposed_at DESC LIMIT $2`,
    [agent, Math.min(Math.max(limit, 1), 200)],
  );
  return rows;
}

export { getAgent };
