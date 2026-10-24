import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { query, withTransaction } from './db.js';
import { getAgent, OrgError, type Agent, type Message } from './org.js';

/**
 * Bot powers and shared memory (vault: Areas/argo/second-brain/agent-company/bot-powers-and-shared-memory-design.md).
 *
 * Shipping: a bot asks (`shipRequest`), only a human answers (`shipDecide`), and the git and deploy wrappers ask the
 * database (`shipCheck`) before they merge or deploy. One approval covers what its request named: the PR, the deploy
 * target, or both. A card the owner created with --ship-now is approved on the spot.
 *
 * Memory: `memory_facts` holds sourced claims written by any runtime; `recallFacts` and `recallMemoryFiles` are two of
 * the three sources `cli-org recall` merges (the vault search is the third, run in cli-org on the app's connection).
 */

const MESSAGE_COLS = 'id, channel_slug, thread_id, author, kind, body, mentions, urgent, task_id, project_slug, feature_slug, run_id, created_at';
const CARD_ID = /^t_[0-9a-f]{6,32}$/;
const SHIP_CAPS = ['code', 'merge', 'deploy'];
/** An approval is good for a week; after that the bot asks again with what changed. */
export const APPROVAL_DAYS = 7;

export interface Approval {
  id: number;
  task_id: string;
  pr_url: string | null;
  deploy_target: string | null;
  summary: string;
  requested_by: string;
  status: 'pending' | 'approved' | 'denied';
  ship_now: boolean;
  decided_by: string | null;
  decided_at: Date | null;
  note: string | null;
  message_id: number | null;
  created_at: Date;
}

const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/;
const TARGET = /^[a-z0-9][a-z0-9-]{0,40}$/;

export interface ShipRequestOpts {
  card: string;
  summary: string;
  pr?: string;
  deploy?: string;
}

/**
 * Asks the owner whether a card's PR (and deploy) may ship. Posts a question-for-owner in the bot's team channel
 * (it shows in the stand-up and on /org) and returns the text for the phone notifier. A second request for the same
 * card, PR and target while one is pending returns the pending one.
 */
export async function shipRequest(caller: Agent, opts: ShipRequestOpts): Promise<{ approval: Approval; message: Message | null; created: boolean }> {
  if (caller.runtime === 'human') throw new OrgError('the owner ships by approving; a request comes from a bot');
  if (!(caller.capabilities ?? []).some((c) => SHIP_CAPS.includes(c))) throw new OrgError(`${caller.name} has none of ${SHIP_CAPS.join(', ')}; the bot that built or merges it asks`);
  if (!CARD_ID.test(opts.card)) throw new OrgError(`bad card id "${opts.card}"`);
  if (opts.pr !== undefined && !PR_URL.test(opts.pr)) throw new OrgError(`--pr takes a GitHub pull request URL, not "${opts.pr}"`);
  if (opts.deploy !== undefined && !TARGET.test(opts.deploy)) throw new OrgError(`bad deploy target "${opts.deploy}"`);
  if (opts.pr === undefined && opts.deploy === undefined) throw new OrgError('ship request needs --pr <url>, --deploy <target>, or both');
  const summary = opts.summary.trim();
  if (!summary || summary.length > 2000) throw new OrgError('the summary is 1 to 2000 characters: what changed, the tests that ran, what the deploy touches');
  const { rows: link } = await query<{ project_slug: string | null; feature_slug: string | null }>(`SELECT project_slug, feature_slug FROM task_links WHERE task_id = $1`, [opts.card]);
  if (!link[0]) throw new OrgError(`card ${opts.card} has no link row; company work goes through cli-org task create|assign`);

  const { rows: open } = await query<Approval>(
    `SELECT * FROM org_approvals WHERE task_id = $1 AND status = 'pending' AND pr_url IS NOT DISTINCT FROM $2 AND deploy_target IS NOT DISTINCT FROM $3 ORDER BY id DESC LIMIT 1`,
    [opts.card, opts.pr ?? null, opts.deploy ?? null],
  );
  if (open[0]) return { approval: open[0], message: null, created: false };

  return withTransaction(async (tx) => {
    const { rows } = await tx.query<Approval>(`SELECT * FROM org_ship_request($1, $2, $3, $4, $5)`, [opts.card, opts.pr ?? null, opts.deploy ?? null, summary, caller.name]);
    const approval = rows[0]!;
    let message: Message | null = null;
    if (approval.status === 'pending' && caller.team_slug) {
      const what = [opts.pr ? `PR ${opts.pr}` : '', opts.deploy ? `deploy ${opts.deploy}` : ''].filter(Boolean).join(' + ');
      const { rows: m } = await tx.query<Message>(
        `INSERT INTO org_messages (channel_slug, author, kind, body, mentions, task_id, project_slug, feature_slug, run_id)
         VALUES ($1,$2,'question-for-owner',$3,'{}',$4,$5,$6,$7) RETURNING ${MESSAGE_COLS}`,
        [caller.team_slug, caller.name, `Ship #${approval.id}? ${what}. ${summary}`, opts.card, link[0]!.project_slug, link[0]!.feature_slug, process.env.ORG_RUN ?? null],
      );
      message = m[0]!;
      await tx.query(`SELECT org_ship_set_message($1, $2)`, [approval.id, message.id]);
      approval.message_id = message.id;
    }
    return { approval, message, created: true };
  });
}

/** The phone line for a new request. */
export function shipNotice(a: Approval): string {
  const what = [a.pr_url, a.deploy_target ? `deploy ${a.deploy_target}` : ''].filter(Boolean).join(' + ');
  return `[ship #${a.id}] ${a.requested_by} (${a.task_id}): ${a.summary.slice(0, 400)}${what ? `\n${what}` : ''}\nReply "approve ${a.id}" or "deny ${a.id} <why>".`;
}

/**
 * Only a human decides, and never from inside a bot's run: the dispatcher sets ORG_RUN for every wake, so a run that
 * calls `cli-org ship approve` under any name is refused here before the database refuses a bot name.
 */
export async function shipDecide(caller: Agent, id: number, approve: boolean, note: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<Approval> {
  if (env.ORG_RUN) throw new OrgError('approvals are never given from inside a bot run');
  if (caller.runtime !== 'human') throw new OrgError(`only the owner approves shipping; ${caller.name} is a bot`);
  if (!approve && !note?.trim()) throw new OrgError('a denial says why, so the bot can fix it');
  const { rows: cur } = await query<{ status: string }>(`SELECT status FROM org_approvals WHERE id = $1`, [id]);
  if (!cur[0]) throw new OrgError(`no ship request #${id}`);
  if (cur[0].status !== 'pending') throw new OrgError(`ship #${id} is already ${cur[0].status}`);
  const approval = await withTransaction(async (tx) => {
    const { rows } = await tx.query<Approval>(`SELECT * FROM org_ship_decide($1, $2, $3, $4)`, [id, approve, caller.name, note?.trim() || null]);
    const a = rows[0]!;
    if (a.message_id) {
      const { rows: root } = await tx.query<{ channel_slug: string }>(`SELECT channel_slug FROM org_messages WHERE id = $1`, [a.message_id]);
      if (root[0]) {
        await tx.query(
          `INSERT INTO org_messages (channel_slug, thread_id, author, kind, body, mentions, task_id) VALUES ($1,$2,$3,'decision',$4,'{}',$5)`,
          [root[0].channel_slug, a.message_id, caller.name, `${approve ? 'Approved' : 'Denied'} ship #${a.id}${note?.trim() ? `: ${note.trim()}` : ''}`, a.task_id],
        );
      }
    }
    return a;
  });
  return approval;
}

/**
 * What the git and deploy wrappers ask before they merge or deploy. Ship-now rows pass for any PR or target of their
 * card; otherwise an approved row from the last week must name the PR being merged or the target being deployed.
 */
export async function shipCheck(card: string, opts: { pr?: string; deploy?: string } = {}): Promise<{ ok: boolean; approval: Approval | null; reason: string }> {
  if (!CARD_ID.test(card)) throw new OrgError(`bad card id "${card}"`);
  const { rows } = await query<Approval>(
    `SELECT * FROM org_approvals WHERE task_id = $1 AND status = 'approved' AND decided_at > now() - make_interval(days => $2) ORDER BY id DESC`,
    [card, APPROVAL_DAYS],
  );
  const now = rows.find((a) => a.ship_now);
  if (now) return { ok: true, approval: now, reason: `ship-now card (#${now.id})` };
  // A merge needs the approval that named this PR, a deploy the one that named this target.
  const fit = rows.find((a) => (opts.pr === undefined || a.pr_url === opts.pr) && (opts.deploy === undefined || a.deploy_target === opts.deploy));
  if (fit) return { ok: true, approval: fit, reason: `approved by ${fit.decided_by} (#${fit.id})` };
  const { rows: pending } = await query<{ id: number }>(`SELECT id FROM org_approvals WHERE task_id = $1 AND status = 'pending' ORDER BY id DESC LIMIT 1`, [card]);
  return {
    ok: false,
    approval: null,
    reason: pending[0] ? `ship #${pending[0].id} is waiting on the owner` : `no approval for ${card}${opts.deploy ? ` to deploy ${opts.deploy}` : ''}; ask with cli-org ship request`,
  };
}

export async function listApprovals(opts: { pending?: boolean; card?: string; limit?: number } = {}): Promise<Approval[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.pending) where.push(`status = 'pending'`);
  if (opts.card) where.push(`task_id = $${params.push(opts.card)}`);
  const { rows } = await query<Approval>(
    `SELECT * FROM org_approvals ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT $${params.push(Math.min(opts.limit ?? 30, 200))}`,
    params,
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Shared memory
// ---------------------------------------------------------------------------

export interface Fact {
  id: number;
  subject: string;
  claim: string;
  source: string;
  author: string;
  via: string | null;
  project_slug: string | null;
  confidence: 'confirmed' | 'inferred';
  supersedes: number | null;
  valid_from: Date;
  valid_to: Date | null;
  retired_by: string | null;
  retired_why: string | null;
}

const FACT_COLS = 'id, subject, claim, source, author, via, project_slug, confidence, supersedes, valid_from, valid_to, retired_by, retired_why';
const VIA = /^[a-z0-9][a-z0-9.@_-]{0,60}$/;

export interface RememberOpts {
  subject: string;
  claim: string;
  source: string;
  project?: string;
  inferred?: boolean;
  supersedes?: number;
  via?: string;
}

/** One sourced claim, authored by the caller. Superseding closes the old fact in the same transaction. */
export async function remember(caller: Agent, opts: RememberOpts): Promise<Fact> {
  const subject = opts.subject.trim();
  const claim = opts.claim.trim().replace(/\s+/g, ' ');
  const source = opts.source.trim();
  if (!subject || subject.length > 200) throw new OrgError('a subject is 1 to 200 characters (the thing the fact is about)');
  if (!claim || claim.length > 1000) throw new OrgError('a claim is 1 to 1000 characters; put longer prose in a vault note and cite it');
  if (!source || source.length > 500) throw new OrgError('every fact needs --source: a vault path, a message #id, a card t_… or a URL');
  if (opts.via !== undefined && !VIA.test(opts.via)) throw new OrgError(`bad --via "${opts.via}" (e.g. claude-code@mac)`);
  if (opts.project) {
    const { rowCount } = await query(`SELECT 1 FROM projects WHERE slug = $1`, [opts.project]);
    if (!rowCount) throw new OrgError(`no project "${opts.project}" in the tracker`);
  }
  return withTransaction(async (tx) => {
    const { rows } = await tx.query<Fact>(
      `INSERT INTO memory_facts (subject, claim, source, author, via, project_slug, confidence, supersedes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${FACT_COLS}`,
      [subject, claim, source, caller.name, opts.via ?? null, opts.project ?? null, opts.inferred ? 'inferred' : 'confirmed', opts.supersedes ?? null],
    );
    const fact = rows[0]!;
    if (opts.supersedes !== undefined) await tx.query(`SELECT memory_fact_retire($1, $2, $3)`, [opts.supersedes, caller.name, `superseded by #${fact.id}`]);
    return fact;
  });
}

export async function forget(caller: Agent, id: number, why: string): Promise<void> {
  if (!why.trim()) throw new OrgError('forget <id> "<why>": say why the fact is no longer true');
  await query(`SELECT memory_fact_retire($1, $2, $3)`, [id, caller.name, why.trim().slice(0, 500)]);
}

export async function listFacts(opts: { subject?: string; project?: string; author?: string; all?: boolean; limit?: number } = {}): Promise<Fact[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!opts.all) where.push('valid_to IS NULL');
  if (opts.subject) where.push(`subject ILIKE $${params.push(`%${opts.subject}%`)}`);
  if (opts.project) where.push(`project_slug = $${params.push(opts.project)}`);
  if (opts.author) where.push(`author = $${params.push(opts.author)}`);
  const { rows } = await query<Fact>(
    `SELECT ${FACT_COLS} FROM memory_facts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT $${params.push(Math.min(opts.limit ?? 50, 500))}`,
    params,
  );
  return rows;
}

export interface RecallHit {
  source: 'fact' | 'memory' | 'vault';
  ref: string;
  title: string;
  text: string;
  score: number;
}

/** Current facts first, then by text rank; a project filter keeps project-less facts too (they are company-wide). */
export async function recallFacts(q: string, opts: { project?: string; limit?: number } = {}): Promise<RecallHit[]> {
  const params: unknown[] = [q, `%${q}%`];
  const project = opts.project ? `AND (project_slug = $${params.push(opts.project)} OR project_slug IS NULL)` : '';
  const { rows } = await query<Fact & { rank: number }>(
    `SELECT ${FACT_COLS}, ts_rank(tsv, websearch_to_tsquery('english', $1)) + CASE WHEN subject ILIKE $2 THEN 0.5 ELSE 0 END AS rank
       FROM memory_facts
      WHERE valid_to IS NULL AND (tsv @@ websearch_to_tsquery('english', $1) OR subject ILIKE $2 OR claim ILIKE $2) ${project}
      ORDER BY rank DESC, id DESC LIMIT $${params.push(Math.min(opts.limit ?? 8, 50))}`,
    params,
  );
  return rows.map((f) => ({
    source: 'fact',
    ref: `fact #${f.id}`,
    title: f.subject,
    text: `${f.claim} [${f.confidence}; source ${f.source}; by ${f.author}${f.via ? ` via ${f.via}` : ''}, ${new Date(f.valid_from).toISOString().slice(0, 10)}]`,
    score: Number(f.rank),
  }));
}

/** Words of three letters or more, lowercased; what a memory-file line is scored against. */
export function terms(q: string): string[] {
  return [...new Set(q.toLowerCase().split(/[^a-z0-9_.-]+/).filter((t) => t.length >= 3))];
}

/**
 * Lines of the bots' memory files that share words with the query, best first: the hand-written
 * `.agents/org/memory/<bot>.md` and the generated core block `.agents/org/memory/<bot>/core.md` (org-memory.ts).
 * Plain scoring: the share of the query's words a line contains. These files are small (tens of KB in all).
 */
export function recallMemoryFiles(vaultRoot: string, q: string, limit = 5): RecallHit[] {
  const words = terms(q);
  if (!words.length) return [];
  const dir = join(vaultRoot, '.agents', 'org', 'memory');
  let files: { rel: string; title: string }[] = [];
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.md')) files.push({ rel: e.name, title: e.name.replace(/\.md$/, '') });
      else if (e.isDirectory() && existsSync(join(dir, e.name, 'core.md'))) files.push({ rel: `${e.name}/core.md`, title: e.name });
    }
  } catch {
    return [];
  }
  const hits: RecallHit[] = [];
  for (const f of files) {
    const lines = readFileSync(join(dir, f.rel), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const l = line.toLowerCase();
      const n = words.filter((w) => l.includes(w)).length;
      if (n && line.trim().length > 3) hits.push({ source: 'memory', ref: `.agents/org/memory/${f.rel}:${i + 1}`, title: f.title, text: line.trim().slice(0, 400), score: n / words.length });
    });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Vault paths recall never returns, whatever the search finds: the owner's working files and finances. */
export const RECALL_EXCLUDE = ['CURRENT/', 'Areas/Finance/', '.env'];

export function recallExcluded(path: string, extra: string[] = []): boolean {
  return [...RECALL_EXCLUDE, ...extra].some((p) => p && (path.startsWith(p) || path.includes(`/${p}`)));
}

export { getAgent };
