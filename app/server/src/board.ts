import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { config } from './config.js';
import { query } from './db.js';

/**
 * The board (board module): the kanban record in the engine. Design: docs/board-design.md.
 *
 * Everything here is a thin call to the board_* SQL functions of the board migration, which hold the rules
 * (who may give whom a card, who may finish it, ship-now only from a human, claims under FOR UPDATE SKIP
 * LOCKED). The caller's name travels as the first argument and is checked against the connection's identity
 * (org_me()) when there is one, exactly as the org module does. Reads are plain SELECTs.
 */

export class BoardError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 = 400) {
    super(message);
  }
}

export const CARD_ID = /^t_[0-9a-f]{6,32}$/;
export const STATUSES = ['triage', 'todo', 'scheduled', 'ready', 'running', 'review', 'blocked', 'done', 'archived'] as const;
export type Status = (typeof STATUSES)[number];
export const CARD_KINDS = ['work', 'spec', 'build', 'review', 'verify', 'doc', 'status', 'improve', 'revert'] as const;
export const BLOCK_KINDS = ['dependency', 'needs-owner', 'missing-input', 'tool-error', 'budget', 'review-changes', 'other'] as const;
export const OUTCOMES = ['done', 'blocked', 'partial', 'budget'] as const;
export type Outcome = (typeof OUTCOMES)[number];
/** Runtimes that claim and run cards. `human` and `session` are not lanes: nothing wakes them. */
export const LANE_RUNTIMES = ['claude-code', 'hermes', 'codex', 'zen-agent'] as const;

export interface Board {
  slug: string;
  name: string;
  team_slug: string | null;
  created_at: Date;
}

/** The card's contract: what the dispatcher reads instead of parsing prose headings. */
export interface Contract {
  objective?: string;
  returns?: string[];
  budget?: { turns?: number; tokens?: number; minutes?: number; wakes?: number };
  scope?: string[];
  verification?: string;
}

export interface Card {
  id: string;
  board_slug: string;
  title: string;
  body: string | null;
  contract: Contract;
  status: Status;
  priority: number;
  assignee: string | null;
  created_by: string;
  project_slug: string | null;
  feature_slug: string | null;
  kind: string;
  work_type: string | null;
  needs: string | null;
  ship_now: boolean;
  repo: string | null;
  graph: string | null;
  node: string | null;
  rounds: number;
  scheduled_for: Date | null;
  block_kind: string | null;
  block_reason: string | null;
  result: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  updated_at: Date;
}

export interface CardComment {
  id: number;
  card_id: string;
  author: string;
  body: string;
  created_at: Date;
}

export interface CardEvent {
  id: number;
  card_id: string;
  kind: string;
  actor: string | null;
  payload: Record<string, unknown> | null;
  at: Date;
}

export interface CardRun {
  id: number;
  card_id: string;
  agent_name: string;
  runtime: string;
  wakeup_id: number | null;
  run_id: string | null;
  claimed_at: Date;
  lease_until: Date;
  heartbeat_at: Date | null;
  finished_at: Date | null;
  outcome: string | null;
  tokens: number | null;
  turns: number | null;
}

export interface CardDetail {
  card: Card;
  comments: CardComment[];
  events: CardEvent[];
  /** Cards this one waits for, and cards that wait for it. */
  depends_on: { id: string; title: string; status: string }[];
  dependants: { id: string; title: string; status: string }[];
  runs: CardRun[];
}

const CARD_COLS = 'id, board_slug, title, body, contract, status, priority, assignee, created_by, project_slug, feature_slug, kind, work_type, needs, ship_now, repo, graph, node, rounds, scheduled_for, block_kind, block_reason, result, created_at, started_at, completed_at, updated_at';

/** A Postgres RAISE from a board function becomes a BoardError with a status the API can use. */
function translate(err: unknown): never {
  const e = err as { code?: string; message?: string };
  if (e?.code === 'P0001' && e.message) {
    const m = e.message;
    const status = /^(no card|no board|unknown agent|no project|no feature|no pending|card .* has no live run)/.test(m) ? 404 : /can't|only the owner|doesn't have|not a bot|caller is|is retired|didn't give/.test(m) ? 403 : 400;
    throw new BoardError(m, status);
  }
  if (e?.code === '23514' || e?.code === '23503' || e?.code === '22P02') throw new BoardError(e.message ?? 'rejected by the database', 400);
  throw err;
}

async function fn<T extends pg.QueryResultRow>(sql: string, params: unknown[]): Promise<T> {
  try {
    const { rows } = await query<T>(sql, params);
    return rows[0]!;
  } catch (err) {
    return translate(err);
  }
}

export function checkId(id: string): string {
  if (!CARD_ID.test(id)) throw new BoardError(`bad card id "${id}" (t_ followed by hex)`, 400);
  return id;
}

// ---- reads -------------------------------------------------------------------------------------------

/** What a caller may see: humans and the owner's process everything; an agent the company boards and its team's. */
export async function visibleBoards(viewer: string | null): Promise<string[] | null> {
  if (viewer === null) return null;
  const { rows } = await query<{ runtime: string; team_slug: string | null }>(`SELECT runtime, team_slug FROM org_agents WHERE name = $1`, [viewer]);
  const a = rows[0];
  if (!a) throw new BoardError(`unknown agent "${viewer}"`, 404);
  if (a.runtime === 'human') return null;
  const { rows: bs } = await query<{ slug: string }>(`SELECT slug FROM boards WHERE team_slug IS NULL OR team_slug = $1`, [a.team_slug]);
  return bs.map((b) => b.slug);
}

export async function listBoards(viewer: string | null = null): Promise<(Board & { open: number })[]> {
  const vis = await visibleBoards(viewer);
  const { rows } = await query<Board & { open: number }>(
    `SELECT b.slug, b.name, b.team_slug, b.created_at, (SELECT count(*)::int FROM cards c WHERE c.board_slug = b.slug AND c.status NOT IN ('done','archived')) AS open
       FROM boards b WHERE $1::text[] IS NULL OR b.slug = ANY ($1) ORDER BY b.slug`,
    [vis],
  );
  return rows;
}

export interface CardFilter {
  board?: string;
  status?: string;
  assignee?: string;
  project?: string;
  feature?: string;
  kind?: string;
  q?: string;
  /** Done cards older than this many days are left out (default 7; 0 = all). */
  doneDays?: number;
  limit?: number;
}

export async function listCards(f: CardFilter = {}, viewer: string | null = null): Promise<Card[]> {
  const vis = await visibleBoards(viewer);
  const params: unknown[] = [vis];
  const where = ['($1::text[] IS NULL OR board_slug = ANY ($1))'];
  const add = (sql: string, v: unknown): void => {
    params.push(v);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (f.board) add('board_slug = ?', f.board);
  if (f.status) add('status = ANY (?)', f.status.split(','));
  if (f.assignee) add(f.assignee === 'none' ? 'assignee IS NULL AND ?::text IS NOT NULL' : 'assignee = ?', f.assignee);
  if (f.project) add('project_slug = ?', f.project);
  if (f.feature) add('feature_slug = ?', f.feature);
  if (f.kind) add('kind = ?', f.kind);
  if (f.q) add(`tsv @@ plainto_tsquery('simple', ?)`, f.q);
  const doneDays = f.doneDays ?? 7;
  if (doneDays > 0) add(`(status NOT IN ('done','archived') OR coalesce(completed_at, updated_at) > now() - make_interval(days => ?))`, doneDays);
  params.push(Math.min(Math.max(f.limit ?? 500, 1), 2000));
  const { rows } = await query<Card>(
    `SELECT ${CARD_COLS} FROM cards WHERE ${where.join(' AND ')}
      ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'ready' THEN 1 WHEN 'review' THEN 2 WHEN 'blocked' THEN 3 WHEN 'todo' THEN 4 WHEN 'scheduled' THEN 5 WHEN 'triage' THEN 6 ELSE 7 END,
               priority, coalesce(completed_at, started_at, created_at) DESC LIMIT $${params.length}`,
    params,
  );
  return rows;
}

export async function getCard(id: string, viewer: string | null = null): Promise<CardDetail> {
  checkId(id);
  const vis = await visibleBoards(viewer);
  const { rows } = await query<Card>(`SELECT ${CARD_COLS} FROM cards WHERE id = $1 AND ($2::text[] IS NULL OR board_slug = ANY ($2))`, [id, vis]);
  const card = rows[0];
  if (!card) throw new BoardError(`no card ${id}`, 404);
  const [comments, events, deps, dependants, runs] = await Promise.all([
    query<CardComment>(`SELECT id, card_id, author, body, created_at FROM card_comments WHERE card_id = $1 ORDER BY id`, [id]),
    query<CardEvent>(`SELECT id, card_id, kind, actor, payload, at FROM card_events WHERE card_id = $1 ORDER BY id`, [id]),
    query<{ id: string; title: string; status: string }>(`SELECT c.id, c.title, c.status FROM card_deps d JOIN cards c ON c.id = d.depends_on WHERE d.card_id = $1 ORDER BY c.created_at`, [id]),
    query<{ id: string; title: string; status: string }>(`SELECT c.id, c.title, c.status FROM card_deps d JOIN cards c ON c.id = d.card_id WHERE d.depends_on = $1 ORDER BY c.created_at`, [id]),
    query<CardRun>(`SELECT * FROM card_runs WHERE card_id = $1 ORDER BY id DESC LIMIT 50`, [id]),
  ]);
  return { card, comments: comments.rows, events: events.rows, depends_on: deps.rows, dependants: dependants.rows, runs: runs.rows };
}

// ---- writes: one function each ------------------------------------------------------------------------

export interface NewCard {
  board?: string;
  title: string;
  body?: string;
  contract?: Contract;
  assignee?: string | null;
  project?: string;
  feature?: string;
  kind?: string;
  work?: string;
  needs?: string;
  repo?: string;
  priority?: number;
  deps?: string[];
  graph?: string;
  node?: string;
  rounds?: number;
  shipNow?: boolean;
  /** A fixed id (the Hermes projection's, while both boards run). */
  id?: string;
  scheduledFor?: Date;
}

export async function createCard(by: string, c: NewCard): Promise<Card> {
  if (c.id) checkId(c.id);
  for (const d of c.deps ?? []) checkId(d);
  if (!c.title?.trim() || c.title.trim().length > 200) throw new BoardError('a card title is 1 to 200 characters');
  if ((c.body ?? '').length > 20000) throw new BoardError('a card body is at most 20000 characters');
  return fn<Card>(
    `SELECT * FROM board_card_create($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [by, c.board ?? null, c.title, c.body ?? null, JSON.stringify(c.contract ?? {}), c.assignee ?? null, c.project ?? null, c.feature ?? null, c.kind ?? null,
     c.work ?? null, c.needs ?? null, c.repo ?? null, c.priority ?? null, c.deps ?? null, c.graph ?? null, c.node ?? null, c.rounds ?? null, c.shipNow ?? false, c.id ?? null, c.scheduledFor ?? null],
  );
}

export async function assignCard(by: string, id: string, assignee: string | null, opts: { project?: string; feature?: string; work?: string; needs?: string; repo?: string } = {}): Promise<Card> {
  checkId(id);
  return fn<Card>(`SELECT * FROM board_card_assign($1,$2,$3,$4,$5,$6,$7,$8)`, [by, id, assignee, opts.project ?? null, opts.feature ?? null, opts.work ?? null, opts.needs ?? null, opts.repo ?? null]);
}

export async function commentCard(by: string, id: string, body: string): Promise<CardComment> {
  checkId(id);
  if (!body.trim() || body.length > 8000) throw new BoardError('a comment is 1 to 8000 characters');
  return fn<CardComment>(`SELECT * FROM board_card_comment($1,$2,$3)`, [by, id, body]);
}

export async function moveCard(by: string, id: string, status: string, note?: string, opts: { blockKind?: string; rounds?: number } = {}): Promise<Card> {
  checkId(id);
  if (!(STATUSES as readonly string[]).includes(status)) throw new BoardError(`status is one of ${STATUSES.join(', ')}, not ${status}`);
  return fn<Card>(`SELECT * FROM board_card_move($1,$2,$3,$4,$5,$6)`, [by, id, status, note ?? null, opts.blockKind ?? null, opts.rounds ?? null]);
}

export interface ClaimOpts {
  runtime?: string;
  agent?: string;
  board?: string;
  leaseMinutes?: number;
  wakeup?: number;
  /** Claim this exact card, not just the next ready one: a lane (cc-dispatcher) that already picked a task from its
   * own sorted, filtered list needs the same "claim this one or fail" guarantee Hermes's `kanban claim <id>` gives. */
  taskId?: string;
}

/** The next ready card for a lane, now running with a lease; null when nothing waits. `by` null is the owner's own process.
 * With `taskId`, claims that exact card instead (null if it is not `ready` or was claimed first). */
export async function claimCard(by: string | null, o: ClaimOpts): Promise<Card | null> {
  if (!o.runtime && !o.agent) throw new BoardError('claim needs --runtime or --agent');
  if (o.taskId) checkId(o.taskId);
  try {
    const { rows } = await query<Card>(`SELECT * FROM board_card_claim($1,$2,$3,$4,$5,$6,$7)`, [by, o.runtime ?? null, o.agent ?? null, o.leaseMinutes ?? config.boardLeaseMinutes, o.board ?? null, o.wakeup ?? null, o.taskId ?? null]);
    return rows[0]?.id ? rows[0] : null;
  } catch (err) {
    return translate(err);
  }
}

export async function heartbeat(by: string, id: string, o: { tokens?: number; turns?: number; leaseMinutes?: number } = {}): Promise<CardRun> {
  checkId(id);
  return fn<CardRun>(`SELECT * FROM board_card_heartbeat($1,$2,$3,$4,$5)`, [by, id, o.tokens ?? null, o.turns ?? null, o.leaseMinutes ?? config.boardLeaseMinutes]);
}

export interface Verification {
  kind?: 'test' | 'manual' | 'deploy' | 'review' | 'metric';
  check: string;
  result?: 'pass' | 'fail';
  evidence?: string;
}

export interface FinishOpts {
  outcome: Outcome;
  result?: string;
  blockKind?: string;
  verification?: Verification;
  tokens?: number;
  turns?: number;
  runId?: string;
}

export async function finishCard(by: string, id: string, o: FinishOpts): Promise<Card> {
  checkId(id);
  if (!(OUTCOMES as readonly string[]).includes(o.outcome)) throw new BoardError(`outcome is one of ${OUTCOMES.join(', ')}`);
  if (o.blockKind && !(BLOCK_KINDS as readonly string[]).includes(o.blockKind)) throw new BoardError(`block kind is one of ${BLOCK_KINDS.join(', ')}`);
  return fn<Card>(`SELECT * FROM board_card_finish($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [
    by, id, o.outcome, o.result ?? null, o.blockKind ?? null, o.verification ? JSON.stringify(o.verification) : null, o.tokens ?? null, o.turns ?? null, o.runId ?? null,
  ]);
}

export async function linkCards(by: string, id: string, dependsOn: string): Promise<void> {
  checkId(id);
  checkId(dependsOn);
  await fn(`SELECT board_card_link($1,$2,$3)`, [by, id, dependsOn]);
}

export async function flagCard(by: string, id: string, o: { shipNow?: boolean; needs?: string }): Promise<Card> {
  checkId(id);
  return fn<Card>(`SELECT * FROM board_card_flags($1,$2,$3,$4)`, [by, id, o.shipNow ?? null, o.needs ?? null]);
}

/** Lost runs back to ready, due scheduled cards to ready. For a timer. */
export async function reclaim(): Promise<number> {
  const { rows } = await query<{ n: number }>(`SELECT board_reclaim() AS n`);
  return rows[0]!.n;
}

// ---- tokens: a device or agent process that reaches the board over HTTPS as one roster member ------------

export interface BoardToken {
  id: number;
  agent_name: string;
  label: string | null;
  created_at: Date;
  last_seen_at: Date | null;
  revoked_at: Date | null;
}

const TOKEN = /^sbb_[A-Za-z0-9_-]{43}$/;
const hash = (t: string): string => createHash('sha256').update(t).digest('hex');

/** Mints a token for a roster member. The token is returned once; only its hash is stored. */
export async function createToken(agent: string, label?: string): Promise<{ id: number; token: string }> {
  const { rows } = await query<{ runtime: string }>(`SELECT runtime FROM org_agents WHERE name = $1 AND retired_at IS NULL`, [agent]);
  if (!rows[0]) throw new BoardError(`unknown agent "${agent}"; run cli-org agents for the roster`, 404);
  const token = `sbb_${randomBytes(32).toString('base64url')}`;
  const { rows: r } = await query<{ id: number }>(`INSERT INTO board_tokens (agent_name, label, token_hash) VALUES ($1,$2,$3) RETURNING id`, [agent, label ?? null, hash(token)]);
  return { id: Number(r[0]!.id), token };
}

/** The live roster member behind a bearer token, or null. Stamps last_seen_at. */
export async function findToken(token: string): Promise<{ id: number; agent: string } | null> {
  if (!TOKEN.test(token)) return null;
  const { rows } = await query<{ id: number; agent_name: string }>(
    `UPDATE board_tokens t SET last_seen_at = now() FROM org_agents a
      WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND a.name = t.agent_name AND a.retired_at IS NULL RETURNING t.id, t.agent_name`,
    [hash(token)],
  );
  return rows[0] ? { id: Number(rows[0].id), agent: rows[0].agent_name } : null;
}

export async function listTokens(): Promise<BoardToken[]> {
  const { rows } = await query<BoardToken>(`SELECT id, agent_name, label, created_at, last_seen_at, revoked_at FROM board_tokens ORDER BY (revoked_at IS NULL) DESC, last_seen_at NULLS LAST, id`);
  return rows;
}

export async function revokeToken(id: number): Promise<boolean> {
  const r = await query(`UPDATE board_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [id]);
  return (r.rowCount ?? 0) > 0;
}

// ---- live: pg_notify('board') fanned out to SSE listeners ---------------------------------------------

export interface BoardNotice {
  card: string;
  kind: string;
  board: string | null;
}

/**
 * One LISTEN connection per process, opened on the first subscriber and closed with the last. A lost
 * connection is reopened on the next subscribe; listeners never see an error, only silence.
 */
export class BoardBus {
  private client: pg.Client | null = null;
  private readonly listeners = new Set<(n: BoardNotice) => void>();
  constructor(private readonly url: string = config.databaseUrl) {}

  subscribe(fn: (n: BoardNotice) => void): () => void {
    this.listeners.add(fn);
    void this.ensure();
    return () => {
      this.listeners.delete(fn);
      if (!this.listeners.size) void this.close();
    };
  }

  private async ensure(): Promise<void> {
    if (this.client) return;
    const client = new pg.Client({ connectionString: this.url });
    this.client = client;
    try {
      await client.connect();
      client.on('notification', (m) => {
        if (m.channel !== 'board' || !m.payload) return;
        try {
          const n = JSON.parse(m.payload) as BoardNotice;
          for (const l of this.listeners) l(n);
        } catch {
          /* not ours */
        }
      });
      client.on('error', () => void this.close());
      await client.query('LISTEN board');
    } catch {
      this.client = null;
      client.end().catch(() => {});
    }
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    if (c) await c.end().catch(() => {});
  }
}

// ---- the mirror: cards from the Hermes board's `--json` output ------------------------------------------

export interface HermesCard {
  id: string;
  title: string;
  body?: string | null;
  assignee?: string | null;
  status?: string;
  priority?: number;
  created_by?: string | null;
  created_at?: number | string;
  started_at?: number | string | null;
  completed_at?: number | string | null;
  result?: string | null;
  comments?: { author: string; body: string; created_at?: number | string }[];
  parents?: string[];
}

const toDate = (v: number | string | null | undefined): Date | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? (v > 1e12 ? v : v * 1000) : Date.parse(v);
  return Number.isFinite(n) ? new Date(n) : null;
};

/**
 * Upserts cards exported from the Hermes board (`hermes kanban list --json`, `show --json`). Assignees and
 * authors the roster does not know get a roster row with runtime `hermes`, so the keys hold and the page can show
 * them; they carry no team. Comments are matched by author, body and time, so a re-import adds nothing twice.
 */
export async function importHermesCards(board: string, docs: HermesCard[], by: string): Promise<{ cards: number; comments: number; agents: number; deps: number }> {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(board)) throw new BoardError(`bad board name "${board}"`);
  await query(`INSERT INTO boards (slug, name) VALUES ($1, initcap($1)) ON CONFLICT DO NOTHING`, [board]);
  let agents = 0;
  let comments = 0;
  let deps = 0;
  const names = new Set<string>([by]);
  for (const d of docs) {
    if (d.assignee) names.add(d.assignee);
    if (d.created_by) names.add(d.created_by);
    for (const c of d.comments ?? []) names.add(c.author);
  }
  for (const n of names) {
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(n)) continue;
    const r = await query(
      `INSERT INTO org_agents (name, runtime, role, org_version) VALUES ($1, 'hermes', 'imported from the Hermes board', 'board-import') ON CONFLICT (name) DO NOTHING`,
      [n],
    );
    agents += r.rowCount ?? 0;
  }
  const known = (n: string | null | undefined): string | null => (n && /^[a-z0-9][a-z0-9-]{0,31}$/.test(n) ? n : null);
  let cards = 0;
  for (const d of docs) {
    if (!CARD_ID.test(d.id) || !d.title?.trim()) continue;
    const status = (STATUSES as readonly string[]).includes(d.status ?? '') ? d.status! : 'todo';
    await query(
      `INSERT INTO cards (id, board_slug, title, body, status, priority, assignee, created_by, result, created_at, started_at, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10, now()),$11,$12)
       ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, status = EXCLUDED.status, priority = EXCLUDED.priority,
         assignee = EXCLUDED.assignee, result = EXCLUDED.result, started_at = EXCLUDED.started_at, completed_at = EXCLUDED.completed_at`,
      [d.id, board, d.title.trim().slice(0, 200), d.body ?? null, status, Math.min(Math.max(d.priority ?? 3, 1), 5), known(d.assignee), known(d.created_by) ?? by, d.result ?? null,
       toDate(d.created_at), toDate(d.started_at), toDate(d.completed_at)],
    );
    cards++;
    for (const c of d.comments ?? []) {
      const author = known(c.author) ?? by;
      const at = toDate(c.created_at) ?? new Date();
      const r = await query(
        `INSERT INTO card_comments (card_id, author, body, created_at) SELECT $1, $2, $3, $4
          WHERE NOT EXISTS (SELECT 1 FROM card_comments WHERE card_id = $1 AND author = $2 AND body = $3 AND created_at = $4)`,
        [d.id, author, c.body, at],
      );
      comments += r.rowCount ?? 0;
    }
  }
  for (const d of docs) {
    for (const p of d.parents ?? []) {
      if (!CARD_ID.test(p) || p === d.id) continue;
      const r = await query(`INSERT INTO card_deps (card_id, depends_on) SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM cards WHERE id = $2) ON CONFLICT DO NOTHING`, [d.id, p]);
      deps += r.rowCount ?? 0;
    }
  }
  return { cards, comments, agents, deps };
}

/** Compares the engine's cards with a Hermes export: ids on one side only, and statuses that differ. */
export async function driftReport(board: string, docs: HermesCard[]): Promise<{ onlyHermes: string[]; onlyEngine: string[]; statusDiffers: { id: string; engine: string; hermes: string }[] }> {
  const { rows } = await query<{ id: string; status: string }>(`SELECT id, status FROM cards WHERE board_slug = $1`, [board]);
  const engine = new Map(rows.map((r) => [r.id, r.status]));
  const hermes = new Map(docs.map((d) => [d.id, d.status ?? 'todo']));
  return {
    onlyHermes: [...hermes.keys()].filter((id) => !engine.has(id)).sort(),
    onlyEngine: [...engine.keys()].filter((id) => !hermes.has(id)).sort(),
    statusDiffers: [...hermes].filter(([id, s]) => engine.has(id) && engine.get(id) !== s).map(([id, s]) => ({ id, engine: engine.get(id)!, hermes: s })).sort((a, b) => a.id.localeCompare(b.id)),
  };
}
