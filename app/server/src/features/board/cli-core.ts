import { readFileSync } from 'node:fs';
import { parseArgs } from '../../cli-args.js';
import { OrgError } from '../../org-error.js';
import { BoardError } from './service/errors.js';
import { HOST_RETRIES } from './service/limits.js';
import type { BlockOpts, Board, Card, CardDetail, CardFilter, ClaimOpts, Contract, FinishOpts } from './service/index.js';

/**
 * The half of cli-board that needs no database: usage, flag checks, output formats, the HTTPS door and every verb that
 * runs through a BoardClient. cli.ts adds the database door, `token` and `import`; cli-remote.ts is the client-machine
 * entry that `secondbrain-vault clis install` bundles. Value imports here must stay off pg, config and db: the bundle
 * check in bin/build-agent-clis.sh fails otherwise.
 */

export const USAGE = `cli-board <command>

  boards                                      the boards and their open cards
  list [--board b] [--status s[,s]] [--assignee a|none] [--area a] [--project p] [--kind k] [--q text] [--all] [--json]
  show <card> [--json]                        a card with its body, comments, dependencies, runs and events
  create "<title>" [--to <agent>] [--area a] [--project p] [--kind k] [--type work] [--needs cap] [--repo r] [--priority N]
         [--after t_..,t_..] [--body "..."] [--contract file.json] [--ship-now] [--board b] [--json]
  comment <card> "<body>"                     as yourself
  assign <card> <agent|none> [--area a] [--project p] [--type work] [--needs cap] [--repo r] [--ship-now]   an existing card becomes the agent's
  redo <card> "<what to change>"               changes requested: a new round for the builder, the review card parked until it is done
  move <card> <status> ["<note>"]             triage todo scheduled ready running review blocked done archived (bots: own card, not done)
  move <card> blocked --after t_..[,t_..] ["<note>"]   blocked on those cards (links); back to ready when the last one is done
  move <card> blocked --host <host> ["<note>"]        blocked on a host (kind host-down); host-up re-queues it, at most ${HOST_RETRIES} times
  move <card> blocked --kind <kind> ["<note>"]        blocked with a kind (dependency needs-owner missing-input tool-error budget review-changes host-down other)
  link <card> --after <card>                  card waits for the other
  claim --runtime <r> | --agent <a> [--board b] [--lease N] [--task t_..] [--json]      the next ready card, or that exact one, now running with a lease
  heartbeat <card> [--tokens N] [--turns N] [--lease N] [--branch b] [--pr url]   --branch/--pr: what the run left, so reclaim can route it to review
  finish <card> --done "<result>" | --blocked <kind> "<why>" | --partial | --budget ["<why>"]
         [--verify "<check>" [--fail] [--evidence "..."] [--verify-kind test|manual|deploy|review|metric]] [--tokens N] [--turns N] [--run id]
  flags <card> [--ship-now] [--needs cap]     ship-now: owner only
  watch [--board b]                           board events as JSON lines, until stopped
  reclaim [--host-up h[,h]]                   lost leases and due schedules to ready, finished dependencies release their waiters,
                                              running cards whose run already ended reconcile (a timer runs this)
  host-up <host>[,<host>]                     a host is back: its host-down cards go back to ready (at most ${HOST_RETRIES} retries a card)
  token create <agent> [--label "where it runs"] | list | revoke <id>     (owner, database door)
  import <file.json> [--board b] [--check]    LEGACY migration tool: cards from a saved Hermes kanban export (list --json / show --json); --check reports drift only. Never calls hermes

  --area is one of the areas (cli-areas list); --project is a project inside it and needs its area. Until the aliases end,
  --project <area> alone is read as the area and --feature as --project, each with a warning.

  Doors: BOARD_URL + BOARD_TOKEN → HTTPS as the token's agent; else the database (ORG_AGENT + SB_ORG_DB_URL → the RLS role; else the owner).`;

export type Opts = Record<string, string | true>;
export const str = (v: string | true | undefined): string | undefined => (typeof v === 'string' ? v : undefined);
export const num = (v: string | true | undefined, flag: string): number | undefined => {
  if (v === undefined) return undefined;
  if (v === true || !/^\d+$/.test(v)) throw new OrgError(`--${flag} needs a number`);
  return Number(v);
};
export const when = (d: Date | string | null): string => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '');

/** Flags each verb accepts; any other flag is a hard error, not a silent drop. `--json` is accepted
 * everywhere. A verb absent from this map keeps the old permissive parse (used by `token`/`import`). */
const KNOWN_FLAGS: Record<string, readonly string[]> = {
  boards: [],
  list: ['board', 'status', 'assignee', 'area', 'project', 'feature', 'kind', 'q', 'all', 'done-days', 'limit'],
  show: [],
  create: ['to', 'area', 'project', 'feature', 'board', 'priority', 'type', 'needs', 'repo', 'ship-now', 'kind', 'after', 'body', 'contract'],
  comment: [],
  assign: ['area', 'project', 'feature', 'type', 'needs', 'repo', 'ship-now'],
  redo: ['run'],
  move: ['after', 'host', 'kind'],
  link: ['after'],
  claim: ['runtime', 'agent', 'board', 'lease', 'task'],
  heartbeat: ['tokens', 'turns', 'lease', 'branch', 'pr'],
  finish: ['done', 'blocked', 'partial', 'budget', 'verify', 'fail', 'evidence', 'verify-kind', 'tokens', 'turns', 'run'],
  flags: ['ship-now', 'needs'],
  watch: ['board'],
  reclaim: ['host-up'],
  'host-up': [],
};

/** Reject a flag the verb does not know, rather than letting parseArgs set an option the case ignores.
 * A silent drop is a behaviour change: `assign <card> m4 --repo vault` used to file the card with no repo. */
export function rejectUnknownFlags(cmd: string | undefined, opts: Opts): void {
  const allowed = cmd ? KNOWN_FLAGS[cmd] : undefined;
  if (!allowed) return;
  for (const k of Object.keys(opts)) {
    if (k !== 'json' && !allowed.includes(k)) {
      const known = allowed.length ? allowed.map((f) => `--${f}`).join(', ') : '(no flags)';
      throw new OrgError(`unknown flag --${k} for "${cmd}"; it takes ${known} (plus --json)`);
    }
  }
}

/** The block kind, with the host and its retry count for a host-down block ("host-down gpu-box, retries 3/3"). */
export function blockLabel(c: Pick<Card, 'block_kind' | 'block_host' | 'host_retries'>): string {
  if (c.block_kind !== 'host-down') return c.block_kind ?? '';
  const n = c.host_retries ?? 0;
  return `host-down${c.block_host ? ` ${c.block_host}` : ''}, retries ${n}/${HOST_RETRIES}${n >= HOST_RETRIES ? ' (no more automatic retries)' : ''}`;
}

export function formatCard(c: Card): string {
  const ref = c.area_slug ? `${c.area_slug}${c.project_slug ? `/${c.project_slug}` : ''}` : '-';
  return `${c.id}  [${c.status.padEnd(9)}] p${c.priority} ${(c.assignee ?? 'unassigned').padEnd(14)} ${ref.padEnd(28)} ${c.title}${c.block_kind ? `  (blocked: ${blockLabel(c)})` : ''}`;
}

export function formatDetail(d: CardDetail): string {
  const c = d.card;
  const lines = [
    `${c.id}: ${c.title}`,
    `board ${c.board_slug} · ${c.status}${c.assignee ? ` · ${c.assignee}` : ' · unassigned'} · by ${c.created_by} · ${when(c.created_at)} · priority ${c.priority} · kind ${c.kind}${c.work_type ? ` · ${c.work_type}` : ''}${c.needs ? ` · needs ${c.needs}` : ''}${c.ship_now ? ' · SHIP-NOW' : ''}`,
    ...(c.area_slug ? [`area ${c.area_slug}${c.project_slug ? `/${c.project_slug}` : ''}${c.repo ? ` · repo ${c.repo}` : ''}${c.graph ? ` · graph ${c.graph} node ${c.node}` : ''}${c.rounds ? ` · round ${c.rounds}` : ''}`] : []),
    ...(c.block_kind ? [`blocked (${blockLabel(c)}): ${c.block_reason ?? ''}`] : []),
    ...(c.result ? [`result: ${c.result}`] : []),
    ...(d.depends_on.length ? [`waits for: ${d.depends_on.map((x) => `${x.id} [${x.status}]`).join(', ')}`] : []),
    ...(d.dependants.length ? [`waited for by: ${d.dependants.map((x) => `${x.id} [${x.status}]`).join(', ')}`] : []),
  ];
  if (Object.keys(c.contract ?? {}).length) lines.push('', 'Contract:', ...Object.entries(c.contract).map(([k, v]) => `  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`));
  if (c.body) lines.push('', c.body);
  if (d.comments.length) lines.push('', 'Comments:', ...d.comments.map((m) => `- ${m.author} (${when(m.created_at)}): ${m.body}`));
  if (d.runs.length) lines.push('', 'Runs:', ...d.runs.map((r) => `- #${r.id} ${r.agent_name} (${r.runtime}) ${when(r.claimed_at)}${r.finished_at ? ` → ${r.outcome} ${when(r.finished_at)}` : ` lease until ${when(r.lease_until)}`}${r.tokens ? ` · ${r.tokens} tokens` : ''}${r.branch ? ` · branch ${r.branch}` : ''}${r.pr ? ` · ${r.pr}` : ''}`));
  return lines.join('\n');
}

/** The verbs, whichever door. */
export interface BoardClient {
  boards(): Promise<(Board & { open: number })[]>;
  list(f: CardFilter & { feature?: string }): Promise<Card[]>;
  show(id: string): Promise<CardDetail>;
  create(c: Record<string, unknown>): Promise<{ card: Card; message: { id: number; channel_slug: string } | null }>;
  comment(id: string, body: string): Promise<void>;
  assign(id: string, assignee: string | null, o: { area?: string; project?: string; feature?: string; work?: string; needs?: string; repo?: string; shipNow?: boolean }): Promise<Card>;
  redo(id: string, changes: string, runId?: string): Promise<{ escalated: boolean; task_id: string | null; rounds: number }>;
  move(id: string, status: string, note?: string): Promise<Card>;
  block(id: string, o: BlockOpts): Promise<Card>;
  link(id: string, dependsOn: string): Promise<void>;
  claim(o: ClaimOpts): Promise<Card | null>;
  heartbeat(id: string, o: { tokens?: number; turns?: number; leaseMinutes?: number; branch?: string; pr?: string }): Promise<void>;
  finish(id: string, o: FinishOpts): Promise<Card>;
  flags(id: string, o: { shipNow?: boolean; needs?: string }): Promise<Card>;
  watch(board: string | undefined, onEvent: (e: unknown) => void): Promise<() => void>;
  reclaim(hostsUp?: string[]): Promise<number>;
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
  async list(f: CardFilter & { feature?: string }) { return (await this.call<{ cards: Card[] }>('GET', '/cards', { ...f, id: f.ids?.join(','), ids: undefined, done_days: f.doneDays, doneDays: undefined })).cards; }
  show(id: string) { return this.call<CardDetail>('GET', `/cards/${id}`); }
  create(c: Record<string, unknown>) { return this.call<{ card: Card; message: { id: number; channel_slug: string } | null }>('POST', '/cards', undefined, c); }
  async comment(id: string, body: string) { await this.call('POST', `/cards/${id}/comment`, undefined, { body }); }
  async assign(id: string, assignee: string | null, o: { area?: string; project?: string; feature?: string; work?: string; needs?: string; repo?: string; shipNow?: boolean }) { return (await this.call<{ card: Card }>('POST', `/cards/${id}/assign`, undefined, { assignee, area: o.area, project: o.project, feature: o.feature, work: o.work, needs: o.needs, repo: o.repo, ship_now: o.shipNow })).card; }
  async redo(id: string, changes: string, runId?: string) { return this.call<{ escalated: boolean; task_id: string | null; rounds: number }>('POST', `/cards/${id}/redo`, undefined, { changes, run_id: runId }); }
  async move(id: string, status: string, note?: string) { return (await this.call<{ card: Card }>('POST', `/cards/${id}/move`, undefined, { status, note })).card; }
  async block(id: string, o: BlockOpts) { return (await this.call<{ card: Card }>('POST', `/cards/${id}/block`, undefined, { kind: o.kind, note: o.reason, host: o.host, after: o.after })).card; }
  async link(id: string, dependsOn: string) { await this.call('POST', `/cards/${id}/link`, undefined, { depends_on: dependsOn }); }
  async claim(o: ClaimOpts) { return (await this.call<{ card: Card } | null>('POST', '/claim', undefined, { runtime: o.runtime, agent: o.agent, board: o.board, lease_minutes: o.leaseMinutes, task_id: o.taskId }))?.card ?? null; }
  async heartbeat(id: string, o: { tokens?: number; turns?: number; leaseMinutes?: number; branch?: string; pr?: string }) { await this.call('POST', `/cards/${id}/heartbeat`, undefined, { tokens: o.tokens, turns: o.turns, lease_minutes: o.leaseMinutes, branch: o.branch, pr: o.pr }); }
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
  async reclaim(hostsUp?: string[]) {
    return (hostsUp?.length ? await this.call<{ reclaimed: number }>('POST', '/host-up', undefined, { hosts: hostsUp }) : await this.call<{ reclaimed: number }>('POST', '/reclaim')).reclaimed;
  }
}

/**
 * One verb against a client, whichever door. `undefined` for a verb this half does not run (token, import, help), so
 * the caller decides what that means for its door.
 */
export async function runVerb(cmd: string | undefined, pos: string[], opts: Opts, kb: BoardClient, out: (s: string) => void): Promise<number | undefined> {
  const json = opts.json === true;
  const need = (ok: unknown, usage: string): void => { if (!ok) throw new OrgError(usage); };
  switch (cmd) {
    case 'boards': {
      const bs = await kb.boards();
      out(json ? JSON.stringify(bs, null, 2) : bs.map((b) => `${b.slug.padEnd(16)} ${String(b.open).padStart(4)} open  ${b.name}${b.team_slug ? `  (team ${b.team_slug})` : ''}`).join('\n') || 'no boards');
      return 0;
    }
    case 'list': {
      const cards = await kb.list({ board: str(opts.board), status: str(opts.status), assignee: str(opts.assignee), area: str(opts.area), project: str(opts.project), feature: str(opts.feature), kind: str(opts.kind), q: str(opts.q), doneDays: opts.all === true ? 0 : num(opts['done-days'], 'done-days'), limit: num(opts.limit, 'limit') });
      out(json ? JSON.stringify(cards, null, 2) : cards.map(formatCard).join('\n') || 'no cards');
      return 0;
    }
    case 'show': {
      need(pos[0], 'show <card>');
      const d = await kb.show(pos[0]!);
      out(json ? JSON.stringify(d, null, 2) : formatDetail(d));
      return 0;
    }
    case 'create': {
      need(pos[0], 'create "<title>" [--to <agent>] [--area a] [--project p] ...');
      const contract = str(opts.contract) ? (JSON.parse(readFileSync(str(opts.contract)!, 'utf8')) as Contract) : undefined;
      const r = await kb.create({
        title: pos[0], assignee: str(opts.to) ?? null, body: str(opts.body), contract, area: str(opts.area), project: str(opts.project), feature: str(opts.feature), board: str(opts.board), priority: num(opts.priority, 'priority'),
        work: str(opts.type), needs: str(opts.needs), repo: str(opts.repo), ship_now: opts['ship-now'] === true, kind: str(opts.kind), deps: str(opts.after)?.split(',').map((x) => x.trim()).filter(Boolean),
      });
      out(json ? JSON.stringify(r) : `card ${r.card.id} ${r.card.assignee ? `for ${r.card.assignee}` : 'unassigned'} [${r.card.status}]: ${r.card.title}${r.message ? `; noted as ${r.message.id} in #${r.message.channel_slug}` : ''}`);
      return 0;
    }
    case 'comment': {
      need(pos[0] && pos[1], 'comment <card> "<body>"');
      await kb.comment(pos[0]!, pos[1]!);
      out(`commented on ${pos[0]}`);
      return 0;
    }
    case 'assign': {
      need(pos[0] && pos[1], 'assign <card> <agent|none> [--area a] [--project p] [--repo r] [--ship-now]');
      const c = await kb.assign(pos[0]!, pos[1] === 'none' ? null : pos[1]!, { area: str(opts.area), project: str(opts.project), feature: str(opts.feature), work: str(opts.type), needs: str(opts.needs), repo: str(opts.repo), shipNow: opts['ship-now'] === true });
      out(json ? JSON.stringify(c) : `${c.id} is now ${c.assignee ?? 'unassigned'} [${c.status}]`);
      return 0;
    }
    case 'redo': {
      need(pos[0] && pos[1], 'redo <review card> "<what to change>"');
      const r = await kb.redo(pos[0]!, pos[1]!, str(opts.run));
      out(json ? JSON.stringify(r) : r.escalated ? `${pos[0]}: review failed ${r.rounds - 1} times, escalated (${r.rounds} rounds)` : `round ${r.rounds} requested on ${r.task_id} from ${pos[0]}`);
      return 0;
    }
    case 'move': {
      need(pos[0] && pos[1], 'move <card> <status> ["<note>"]');
      const blockOpts = opts.after !== undefined || opts.host !== undefined || opts.kind !== undefined;
      if (blockOpts && pos[1] !== 'blocked') throw new OrgError('--after, --host and --kind go with: move <card> blocked');
      if (opts.after === true || opts.host === true || opts.kind === true) throw new OrgError('--after, --host and --kind need a value');
      const after = str(opts.after)?.split(',').map((x) => x.trim()).filter(Boolean);
      const c = blockOpts ? await kb.block(pos[0]!, { kind: str(opts.kind), reason: pos[2], host: str(opts.host), after }) : await kb.move(pos[0]!, pos[1]!, pos[2]);
      out(json ? JSON.stringify(c) : `${c.id} is ${c.status}${c.block_kind ? ` (${blockLabel(c)})` : ''}`);
      return 0;
    }
    case 'link': {
      need(pos[0] && str(opts.after), 'link <card> --after <card>');
      await kb.link(pos[0]!, str(opts.after)!);
      out(`${pos[0]} waits for ${str(opts.after)}`);
      return 0;
    }
    case 'claim': {
      const c = await kb.claim({ runtime: str(opts.runtime), agent: str(opts.agent), board: str(opts.board), leaseMinutes: num(opts.lease, 'lease'), taskId: str(opts.task) });
      if (!c) {
        out(json ? 'null' : 'nothing ready');
        return 3;
      }
      out(json ? JSON.stringify(c) : `claimed ${c.id} for ${c.assignee}: ${c.title}`);
      return 0;
    }
    case 'heartbeat': {
      need(pos[0], 'heartbeat <card> [--tokens N] [--turns N] [--lease N]');
      await kb.heartbeat(pos[0]!, { tokens: num(opts.tokens, 'tokens'), turns: num(opts.turns, 'turns'), leaseMinutes: num(opts.lease, 'lease'), branch: str(opts.branch), pr: str(opts.pr) });
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
      const c = await kb.finish(pos[0]!, o);
      out(json ? JSON.stringify(c) : `${c.id} is ${c.status}${c.block_kind ? ` (${c.block_kind})` : ''}${c.result && c.status === 'done' ? `: ${c.result}` : ''}`);
      return 0;
    }
    case 'flags': {
      need(pos[0], 'flags <card> [--ship-now] [--needs cap]');
      const c = await kb.flags(pos[0]!, { shipNow: opts['ship-now'] === true ? true : undefined, needs: str(opts.needs) });
      out(json ? JSON.stringify(c) : `${c.id}: ship-now ${c.ship_now}${c.needs ? `, needs ${c.needs}` : ''}`);
      return 0;
    }
    case 'watch': {
      const stop = await kb.watch(str(opts.board), (e) => out(JSON.stringify(e)));
      await new Promise<void>((r) => { process.once('SIGINT', r); process.once('SIGTERM', r); });
      stop();
      return 0;
    }
    case 'reclaim':
    case 'host-up': {
      const raw = cmd === 'host-up' ? pos[0] : opts['host-up'];
      if ((cmd === 'host-up' || raw !== undefined) && typeof raw !== 'string') throw new OrgError(cmd === 'host-up' ? 'host-up <host>[,<host>]' : 'reclaim --host-up <host>[,<host>]');
      const hosts = typeof raw === 'string' ? raw.split(',').map((h) => h.trim()).filter(Boolean) : undefined;
      const n = await kb.reclaim(hosts);
      out(json ? JSON.stringify({ reclaimed: n }) : `${n} card(s) moved`);
      return 0;
    }
    default:
      return undefined;
  }
}

/** The verbs runVerb answers: every one but `token` and `import`, which need the database door. */
export const CLIENT_VERBS: readonly string[] = Object.keys(KNOWN_FLAGS);

/** Split argv and reject a flag the verb does not take: the start of every door's main. */
export function parseVerb(argv: string[]): { cmd: string | undefined; pos: string[]; opts: Opts } {
  const [cmd, ...rest] = argv;
  const { pos, opts } = parseArgs(rest) as { pos: string[]; opts: Opts };
  rejectUnknownFlags(cmd, opts);
  return { cmd, pos, opts };
}
