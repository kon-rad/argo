import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  assignCard, BoardBus, BoardError, claimCard, commentCard, createToken, driftReport, finishCard, flagCard, getCard, heartbeat, importHermesCards, linkCards, listBoards,
  listCards, listTokens, moveCard, reclaim, revokeToken, type Board, type Card, type CardDetail, type CardFilter, type ClaimOpts, type Contract, type FinishOpts, type HermesCard,
} from './board.js';
import { config } from './config.js';
import { pool, setDatabaseUrl } from './db.js';
import { agentDatabaseUrl, parseArgs } from './cli-org.js';
import { assignTask, createTask, getAgent, hermesProjection, OrgError } from './org.js';

/**
 * cli-board (also `secondbrain board`): the board from a terminal, for people and agents. Design: docs/board-design.md
 * section 5.2. Two doors: with BOARD_URL and BOARD_TOKEN set it speaks to the app over HTTPS as the roster member the
 * token names (any machine); otherwise it uses the database, as the owner or, with ORG_AGENT and SB_ORG_DB_URL, as the
 * row-level-security role. Same verbs, same output either way. The author of every write is the caller: no --author.
 */

const USAGE = `cli-board <command>

  boards                                      the boards and their open cards
  list [--board b] [--status s[,s]] [--assignee a|none] [--project p] [--feature f] [--kind k] [--q text] [--all] [--json]
  show <card> [--json]                        a card with its body, comments, dependencies, runs and events
  create "<title>" [--to <agent>] [--project p] [--feature f] [--kind k] [--type work] [--needs cap] [--repo r] [--priority N]
         [--after t_..,t_..] [--body "..."] [--contract file.json] [--ship-now] [--board b] [--json]
  comment <card> "<body>"                     as yourself
  assign <card> <agent|none> [--project p] [--feature f] [--type work] [--needs cap]
  move <card> <status> ["<note>"]             triage todo scheduled ready running review blocked done archived (bots: own card, not done)
  link <card> --after <card>                  card waits for the other
  claim --runtime <r> | --agent <a> [--board b] [--lease N] [--task t_..] [--json]      the next ready card, or that exact one, now running with a lease
  heartbeat <card> [--tokens N] [--turns N] [--lease N]
  finish <card> --done "<result>" | --blocked <kind> "<why>" | --partial | --budget ["<why>"]
         [--verify "<check>" [--fail] [--evidence "..."] [--verify-kind test|manual|deploy|review|metric]] [--tokens N] [--turns N] [--run id]
  flags <card> [--ship-now] [--needs cap]     ship-now: owner only
  watch [--board b]                           board events as JSON lines, until stopped
  reclaim                                     lost leases back to ready, due schedules to ready (a timer runs this)
  token create <agent> [--label "where it runs"] | list | revoke <id>     (owner, database door)
  import <file.json> | --hermes [--board b] [--check]    cards from the Hermes board's list --json / show --json; --check reports drift only

  Doors: BOARD_URL + BOARD_TOKEN → HTTPS as the token's agent; else the database (ORG_AGENT + SB_ORG_DB_URL → the RLS role; else the owner).`;

type Opts = Record<string, string | true>;
const str = (v: string | true | undefined): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: string | true | undefined, flag: string): number | undefined => {
  if (v === undefined) return undefined;
  if (v === true || !/^\d+$/.test(v)) throw new OrgError(`--${flag} needs a number`);
  return Number(v);
};
const when = (d: Date | string | null): string => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '');

export function formatCard(c: Card): string {
  const ref = c.project_slug ? `${c.project_slug}${c.feature_slug ? `/${c.feature_slug}` : ''}` : '-';
  return `${c.id}  [${c.status.padEnd(9)}] p${c.priority} ${(c.assignee ?? 'unassigned').padEnd(14)} ${ref.padEnd(28)} ${c.title}${c.block_kind ? `  (blocked: ${c.block_kind})` : ''}`;
}

export function formatDetail(d: CardDetail): string {
  const c = d.card;
  const lines = [
    `${c.id}: ${c.title}`,
    `board ${c.board_slug} · ${c.status}${c.assignee ? ` · ${c.assignee}` : ' · unassigned'} · by ${c.created_by} · ${when(c.created_at)} · priority ${c.priority} · kind ${c.kind}${c.work_type ? ` · ${c.work_type}` : ''}${c.needs ? ` · needs ${c.needs}` : ''}${c.ship_now ? ' · SHIP-NOW' : ''}`,
    ...(c.project_slug ? [`project ${c.project_slug}${c.feature_slug ? `/${c.feature_slug}` : ''}${c.repo ? ` · repo ${c.repo}` : ''}${c.graph ? ` · graph ${c.graph} node ${c.node}` : ''}${c.rounds ? ` · round ${c.rounds}` : ''}`] : []),
    ...(c.block_kind ? [`blocked (${c.block_kind}): ${c.block_reason ?? ''}`] : []),
    ...(c.result ? [`result: ${c.result}`] : []),
    ...(d.depends_on.length ? [`waits for: ${d.depends_on.map((x) => `${x.id} [${x.status}]`).join(', ')}`] : []),
    ...(d.dependants.length ? [`waited for by: ${d.dependants.map((x) => `${x.id} [${x.status}]`).join(', ')}`] : []),
  ];
  if (Object.keys(c.contract ?? {}).length) lines.push('', 'Contract:', ...Object.entries(c.contract).map(([k, v]) => `  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`));
  if (c.body) lines.push('', c.body);
  if (d.comments.length) lines.push('', 'Comments:', ...d.comments.map((m) => `- ${m.author} (${when(m.created_at)}): ${m.body}`));
  if (d.runs.length) lines.push('', 'Runs:', ...d.runs.map((r) => `- #${r.id} ${r.agent_name} (${r.runtime}) ${when(r.claimed_at)}${r.finished_at ? ` → ${r.outcome} ${when(r.finished_at)}` : ` lease until ${when(r.lease_until)}`}${r.tokens ? ` · ${r.tokens} tokens` : ''}`));
  return lines.join('\n');
}

/** The verbs, whichever door. */
export interface BoardClient {
  boards(): Promise<(Board & { open: number })[]>;
  list(f: CardFilter): Promise<Card[]>;
  show(id: string): Promise<CardDetail>;
  create(c: Record<string, unknown>): Promise<{ card: Card; message: { id: number; channel_slug: string } | null }>;
  comment(id: string, body: string): Promise<void>;
  assign(id: string, assignee: string | null, o: { project?: string; feature?: string; work?: string; needs?: string }): Promise<Card>;
  move(id: string, status: string, note?: string): Promise<Card>;
  link(id: string, dependsOn: string): Promise<void>;
  claim(o: ClaimOpts): Promise<Card | null>;
  heartbeat(id: string, o: { tokens?: number; turns?: number; leaseMinutes?: number }): Promise<void>;
  finish(id: string, o: FinishOpts): Promise<Card>;
  flags(id: string, o: { shipNow?: boolean; needs?: string }): Promise<Card>;
  watch(board: string | undefined, onEvent: (e: unknown) => void): Promise<() => void>;
  reclaim(): Promise<number>;
}

export class HttpBoard implements BoardClient {
  constructor(private readonly url: string, private readonly token: string, private readonly fetchFn: typeof fetch = fetch) {}
  private async call<T>(method: 'GET' | 'POST', path: string, query?: Record<string, string | number | undefined>, body?: unknown): Promise<T> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== '') q.set(k, String(v));
    const res = await this.fetchFn(`${this.url}/api/board${path}${q.size ? `?${q}` : ''}`, {
      method, headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined, signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 204) return null as T;
    const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    if (!res.ok) throw new BoardError(`board ${res.status}: ${data?.error?.message ?? res.statusText}`, res.status === 404 ? 404 : res.status === 403 ? 403 : 400);
    return data as T;
  }
  async boards() { return (await this.call<{ boards: (Board & { open: number })[] }>('GET', '/boards')).boards; }
  async list(f: CardFilter) { return (await this.call<{ cards: Card[] }>('GET', '/cards', { ...f, done_days: f.doneDays, doneDays: undefined })).cards; }
  show(id: string) { return this.call<CardDetail>('GET', `/cards/${id}`); }
  create(c: Record<string, unknown>) { return this.call<{ card: Card; message: { id: number; channel_slug: string } | null }>('POST', '/cards', undefined, c); }
  async comment(id: string, body: string) { await this.call('POST', `/cards/${id}/comment`, undefined, { body }); }
  async assign(id: string, assignee: string | null, o: { project?: string; feature?: string; work?: string; needs?: string }) { return (await this.call<{ card: Card }>('POST', `/cards/${id}/assign`, undefined, { assignee, ...o })).card; }
  async move(id: string, status: string, note?: string) { return (await this.call<{ card: Card }>('POST', `/cards/${id}/move`, undefined, { status, note })).card; }
  async link(id: string, dependsOn: string) { await this.call('POST', `/cards/${id}/link`, undefined, { depends_on: dependsOn }); }
  async claim(o: ClaimOpts) { return (await this.call<{ card: Card } | null>('POST', '/claim', undefined, { runtime: o.runtime, agent: o.agent, board: o.board, lease_minutes: o.leaseMinutes, task_id: o.taskId }))?.card ?? null; }
  async heartbeat(id: string, o: { tokens?: number; turns?: number; leaseMinutes?: number }) { await this.call('POST', `/cards/${id}/heartbeat`, undefined, { tokens: o.tokens, turns: o.turns, lease_minutes: o.leaseMinutes }); }
  async finish(id: string, o: FinishOpts) {
    return (await this.call<{ card: Card }>('POST', `/cards/${id}/finish`, undefined, { outcome: o.outcome, result: o.result, block_kind: o.blockKind, verification: o.verification, tokens: o.tokens, turns: o.turns, run_id: o.runId })).card;
  }
  async flags(id: string, o: { shipNow?: boolean; needs?: string }) { return (await this.call<{ card: Card }>('POST', `/cards/${id}/flags`, undefined, { ship_now: o.shipNow, needs: o.needs })).card; }
  async watch(board: string | undefined, onEvent: (e: unknown) => void): Promise<() => void> {
    const ctl = new AbortController();
    const res = await this.fetchFn(`${this.url}/api/board/events`, { headers: { Authorization: `Bearer ${this.token}`, Accept: 'text/event-stream' }, signal: ctl.signal });
    if (!res.ok || !res.body) throw new BoardError(`board ${res.status}: the event stream did not open`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    void (async () => {
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = chunk.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
          if (!data) continue;
          try {
            const e = JSON.parse(data) as { board?: string };
            if (!board || e.board === board) onEvent(e);
          } catch {
            /* skip */
          }
        }
      }
    })();
    return () => ctl.abort();
  }
  async reclaim() { return (await this.call<{ reclaimed: number }>('POST', '/reclaim')).reclaimed; }
}

/** The database door: the board functions as the caller named here. */
export class DbBoard implements BoardClient {
  constructor(private readonly me: string, private readonly viewer: string | null) {}
  boards() { return listBoards(this.viewer); }
  list(f: CardFilter) { return listCards(f, this.viewer); }
  show(id: string) { return getCard(id, this.viewer); }
  async create(c: Record<string, unknown>) {
    const b = c as { title: string; assignee?: string | null; body?: string; contract?: Contract; project?: string; feature?: string; board?: string; priority?: number; work?: string; needs?: string; repo?: string; ship_now?: boolean; kind?: string; deps?: string[] };
    const r = await createTask(await getAgent(this.me), { assignee: b.assignee ?? null, title: b.title, body: b.body, contract: b.contract, project: b.project, feature: b.feature, board: b.board, priority: b.priority, type: b.work, needs: b.needs, repo: b.repo, shipNow: b.ship_now, kind: b.kind, deps: b.deps, run: process.env.ORG_RUN }, hermesProjection());
    return { card: r.card, message: r.message };
  }
  async comment(id: string, body: string) { await commentCard(this.me, id, body); }
  async assign(id: string, assignee: string | null, o: { project?: string; feature?: string; work?: string; needs?: string }) {
    if (assignee === null) return assignCard(this.me, id, null);
    return (await assignTask(await getAgent(this.me), { taskId: id, assignee, project: o.project, feature: o.feature, type: o.work, needs: o.needs, run: process.env.ORG_RUN }, hermesProjection())).card;
  }
  move(id: string, status: string, note?: string) { return moveCard(this.me, id, status, note); }
  link(id: string, dependsOn: string) { return linkCards(this.me, id, dependsOn); }
  claim(o: ClaimOpts) { return claimCard(this.viewer === null ? null : this.me, o); }
  async heartbeat(id: string, o: { tokens?: number; turns?: number; leaseMinutes?: number }) { await heartbeat(this.me, id, o); }
  finish(id: string, o: FinishOpts) { return finishCard(this.me, id, o); }
  flags(id: string, o: { shipNow?: boolean; needs?: string }) { return flagCard(this.me, id, o); }
  async watch(board: string | undefined, onEvent: (e: unknown) => void): Promise<() => void> {
    const bus = new BoardBus(process.env.SB_ORG_DB_URL && this.viewer ? agentDatabaseUrl(process.env.SB_ORG_DB_URL, this.viewer) : config.databaseUrl);
    const off = bus.subscribe((n) => { if (!board || n.board === board) onEvent(n); });
    return () => { off(); void bus.close(); };
  }
  reclaim() { return reclaim(); }
}

/** Which door this process uses: HTTPS with a token, else the database (as the RLS role with ORG_AGENT, else the owner). */
export function boardClient(env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch): BoardClient {
  const url = env.BOARD_URL ?? config.boardUrl;
  const token = env.BOARD_TOKEN ?? config.boardToken;
  if (url && token) return new HttpBoard(url.replace(/\/+$/, ''), token, fetchFn);
  const agent = env.ORG_AGENT?.trim();
  if (agent && env.SB_ORG_DB_URL) setDatabaseUrl(agentDatabaseUrl(env.SB_ORG_DB_URL, agent));
  return new DbBoard(agent || config.orgOwner, agent ? agent : null);
}

const HermesDoc = z.object({ id: z.string(), title: z.string() }).passthrough();

/** Hermes exports: an array of cards, `{tasks: [...]}`, or one `show --json` document (`{task, comments, parents}`). */
export function parseHermesExport(text: string): HermesCard[] {
  const doc = JSON.parse(text) as unknown;
  const list = Array.isArray(doc) ? doc : (doc as { tasks?: unknown[] })?.tasks ?? [doc];
  return list.map((d) => {
    const o = d as { task?: Record<string, unknown>; comments?: unknown; parents?: unknown } & Record<string, unknown>;
    const task = HermesDoc.parse(o.task ?? o);
    return { ...(task as unknown as HermesCard), comments: (o.comments as HermesCard['comments']) ?? undefined, parents: (o.parents as string[]) ?? undefined };
  });
}

function hermesExport(board: string, env: NodeJS.ProcessEnv): Promise<string> {
  const cmd = env.ORG_KANBAN_CMD ?? 'hermes';
  return new Promise((ok, fail) => {
    execFile(cmd, ['kanban', '--board', board, 'list', '--json', '--all'], { env, timeout: 60_000, maxBuffer: 64_000_000 }, (err, stdout, stderr) => {
      if (err) fail(new OrgError(`kanban: ${(stderr || err.message).trim().slice(0, 300)}`));
      else ok(stdout);
    });
  });
}

export async function main(argv: string[], out: (s: string) => void = console.log, env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch): Promise<number> {
  const [cmd, ...rest] = argv;
  const { pos, opts } = parseArgs(rest) as { pos: string[]; opts: Opts };
  const json = opts.json === true;
  const kb = cmd && !['token', 'import', 'help', '--help', undefined].includes(cmd) ? boardClient(env, fetchFn) : null;
  const need = (ok: unknown, usage: string): void => { if (!ok) throw new OrgError(usage); };

  switch (cmd) {
    case 'boards': {
      const bs = await kb!.boards();
      out(json ? JSON.stringify(bs, null, 2) : bs.map((b) => `${b.slug.padEnd(16)} ${String(b.open).padStart(4)} open  ${b.name}${b.team_slug ? `  (team ${b.team_slug})` : ''}`).join('\n') || 'no boards');
      return 0;
    }
    case 'list': {
      const cards = await kb!.list({ board: str(opts.board), status: str(opts.status), assignee: str(opts.assignee), project: str(opts.project), feature: str(opts.feature), kind: str(opts.kind), q: str(opts.q), doneDays: opts.all === true ? 0 : num(opts['done-days'], 'done-days'), limit: num(opts.limit, 'limit') });
      out(json ? JSON.stringify(cards, null, 2) : cards.map(formatCard).join('\n') || 'no cards');
      return 0;
    }
    case 'show': {
      need(pos[0], 'show <card>');
      const d = await kb!.show(pos[0]!);
      out(json ? JSON.stringify(d, null, 2) : formatDetail(d));
      return 0;
    }
    case 'create': {
      need(pos[0], 'create "<title>" [--to <agent>] [--project p] ...');
      const contract = str(opts.contract) ? (JSON.parse(readFileSync(str(opts.contract)!, 'utf8')) as Contract) : undefined;
      const r = await kb!.create({
        title: pos[0], assignee: str(opts.to) ?? null, body: str(opts.body), contract, project: str(opts.project), feature: str(opts.feature), board: str(opts.board), priority: num(opts.priority, 'priority'),
        work: str(opts.type), needs: str(opts.needs), repo: str(opts.repo), ship_now: opts['ship-now'] === true, kind: str(opts.kind), deps: str(opts.after)?.split(',').map((x) => x.trim()).filter(Boolean),
      });
      out(json ? JSON.stringify(r) : `card ${r.card.id} ${r.card.assignee ? `for ${r.card.assignee}` : 'unassigned'} [${r.card.status}]: ${r.card.title}${r.message ? `; noted as ${r.message.id} in #${r.message.channel_slug}` : ''}`);
      return 0;
    }
    case 'comment': {
      need(pos[0] && pos[1], 'comment <card> "<body>"');
      await kb!.comment(pos[0]!, pos[1]!);
      out(`commented on ${pos[0]}`);
      return 0;
    }
    case 'assign': {
      need(pos[0] && pos[1], 'assign <card> <agent|none> [--project p] [--feature f]');
      const c = await kb!.assign(pos[0]!, pos[1] === 'none' ? null : pos[1]!, { project: str(opts.project), feature: str(opts.feature), work: str(opts.type), needs: str(opts.needs) });
      out(json ? JSON.stringify(c) : `${c.id} is now ${c.assignee ?? 'unassigned'} [${c.status}]`);
      return 0;
    }
    case 'move': {
      need(pos[0] && pos[1], 'move <card> <status> ["<note>"]');
      const c = await kb!.move(pos[0]!, pos[1]!, pos[2]);
      out(json ? JSON.stringify(c) : `${c.id} is ${c.status}`);
      return 0;
    }
    case 'link': {
      need(pos[0] && str(opts.after), 'link <card> --after <card>');
      await kb!.link(pos[0]!, str(opts.after)!);
      out(`${pos[0]} waits for ${str(opts.after)}`);
      return 0;
    }
    case 'claim': {
      const c = await kb!.claim({ runtime: str(opts.runtime), agent: str(opts.agent), board: str(opts.board), leaseMinutes: num(opts.lease, 'lease'), taskId: str(opts.task) });
      if (!c) {
        out(json ? 'null' : 'nothing ready');
        return 3;
      }
      out(json ? JSON.stringify(c) : `claimed ${c.id} for ${c.assignee}: ${c.title}`);
      return 0;
    }
    case 'heartbeat': {
      need(pos[0], 'heartbeat <card> [--tokens N] [--turns N] [--lease N]');
      await kb!.heartbeat(pos[0]!, { tokens: num(opts.tokens, 'tokens'), turns: num(opts.turns, 'turns'), leaseMinutes: num(opts.lease, 'lease') });
      out(`${pos[0]} lease extended`);
      return 0;
    }
    case 'finish': {
      need(pos[0], 'finish <card> --done "<result>" | --blocked <kind> "<why>" | --partial | --budget');
      const o: FinishOpts = opts.done !== undefined ? { outcome: 'done', result: str(opts.done) }
        : opts.blocked !== undefined ? { outcome: 'blocked', blockKind: str(opts.blocked), result: pos[1] }
        : opts.partial === true ? { outcome: 'partial', result: pos[1] }
        : opts.budget !== undefined ? { outcome: 'budget', blockKind: 'budget', result: str(opts.budget) ?? pos[1] }
        : (() => { throw new OrgError('finish needs --done, --blocked <kind>, --partial or --budget'); })();
      if (str(opts.verify)) o.verification = { check: str(opts.verify)!, result: opts.fail === true ? 'fail' : 'pass', evidence: str(opts.evidence), kind: str(opts['verify-kind']) as never };
      o.tokens = num(opts.tokens, 'tokens'); o.turns = num(opts.turns, 'turns'); o.runId = str(opts.run);
      const c = await kb!.finish(pos[0]!, o);
      out(json ? JSON.stringify(c) : `${c.id} is ${c.status}${c.block_kind ? ` (${c.block_kind})` : ''}${c.result && c.status === 'done' ? `: ${c.result}` : ''}`);
      return 0;
    }
    case 'flags': {
      need(pos[0], 'flags <card> [--ship-now] [--needs cap]');
      const c = await kb!.flags(pos[0]!, { shipNow: opts['ship-now'] === true ? true : undefined, needs: str(opts.needs) });
      out(json ? JSON.stringify(c) : `${c.id}: ship-now ${c.ship_now}${c.needs ? `, needs ${c.needs}` : ''}`);
      return 0;
    }
    case 'watch': {
      const stop = await kb!.watch(str(opts.board), (e) => out(JSON.stringify(e)));
      await new Promise<void>((r) => { process.once('SIGINT', r); process.once('SIGTERM', r); });
      stop();
      return 0;
    }
    case 'reclaim': {
      const n = await kb!.reclaim();
      out(json ? JSON.stringify({ reclaimed: n }) : `${n} card(s) moved`);
      return 0;
    }
    case 'token': {
      const [sub, a] = pos;
      if (sub === 'create') {
        need(a, 'token create <agent> [--label "..."]');
        const t = await createToken(a!, str(opts.label));
        out(json ? JSON.stringify(t) : `token ${t.id} for ${a} (shown once; put it in BOARD_TOKEN on that machine, with BOARD_URL):\n${t.token}`);
        return 0;
      }
      if (sub === 'list') {
        const ts = await listTokens();
        out(json ? JSON.stringify(ts, null, 2) : ts.map((t) => `#${t.id} ${t.agent_name.padEnd(14)} ${(t.label ?? '-').padEnd(24)} made ${when(t.created_at)}  seen ${when(t.last_seen_at) || 'never'}${t.revoked_at ? `  REVOKED ${when(t.revoked_at)}` : ''}`).join('\n') || 'no tokens');
        return 0;
      }
      if (sub === 'revoke') {
        const id = num(a, 'id');
        need(id, 'token revoke <id>');
        out((await revokeToken(id!)) ? `token ${id} revoked` : `no live token ${id}`);
        return 0;
      }
      throw new OrgError('token create|list|revoke');
    }
    case 'import': {
      const board = str(opts.board) ?? 'exo';
      const text = opts.hermes === true ? await hermesExport(board, env) : pos[0] ? readFileSync(pos[0], 'utf8') : (() => { throw new OrgError('import <file.json> | --hermes [--board b] [--check]'); })();
      const docs = parseHermesExport(text);
      if (opts.check === true) {
        const d = await driftReport(board, docs);
        out(json ? JSON.stringify(d, null, 2) : `${docs.length} cards in the export; only on Hermes: ${d.onlyHermes.length}; only in the engine: ${d.onlyEngine.length}; status differs: ${d.statusDiffers.length}${d.statusDiffers.length ? `\n${d.statusDiffers.map((x) => `  ${x.id} engine ${x.engine} / hermes ${x.hermes}`).join('\n')}` : ''}`);
        return d.onlyHermes.length || d.statusDiffers.length ? 3 : 0;
      }
      const r = await importHermesCards(board, docs, env.ORG_AGENT?.trim() || config.orgOwner);
      out(json ? JSON.stringify(r) : `imported ${r.cards} cards, ${r.comments} new comments, ${r.deps} dependencies; ${r.agents} roster rows added for names the org did not know`);
      return 0;
    }
    default:
      out(USAGE);
      return cmd === undefined || cmd === 'help' || cmd === '--help' ? 0 : 1;
  }
}

if (process.argv[1]?.endsWith('cli-board.js') || process.argv[1]?.endsWith('cli-board.ts')) {
  let code = 1;
  try {
    code = await main(process.argv.slice(2));
  } catch (err) {
    if (err instanceof OrgError || err instanceof BoardError) console.error(err.message);
    else if (err instanceof z.ZodError) console.error(err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('\n'));
    else console.error(err instanceof Error ? err.message : String(err));
  } finally {
    await pool.end();
  }
  process.exit(code);
}
