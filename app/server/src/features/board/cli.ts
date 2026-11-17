import { exitFlushed } from '../../cli-exit.js';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  assignCard, BoardBus, BoardError, claimCard, commentCard, createToken, driftReport, finishCard, flagCard, getCard, heartbeat, importHermesCards, linkCards, listBoards,
  listCards, listTokens, moveCard, reclaim, revokeToken, type CardFilter, type ClaimOpts, type Contract, type FinishOpts, type HermesCard,
} from './service/index.js';
import { CLIENT_VERBS, HttpBoard, num, parseVerb, runVerb, str, USAGE, when, type BoardClient } from './cli-core.js';
import { config } from '../../config.js';
import { pool, setDatabaseUrl } from '../../db.js';
import { agentDatabaseUrl } from '../../cli-org.js';
import { assignTask, createTask, getAgent, OrgError, redoTask, trackerRef } from '../../org.js';

/**
 * cli-board (also `secondbrain board`): the board from a terminal, for people and agents. Design: docs/board-design.md
 * section 5.2. Two doors: with BOARD_URL and BOARD_TOKEN set it speaks to the app over HTTPS as the roster member the
 * token names (any machine); otherwise it uses the database, as the owner or, with ORG_AGENT and SB_ORG_DB_URL, as the
 * row-level-security role. Same verbs, same output either way. The author of every write is the caller: no --author.
 * The verbs, formats and the HTTPS door live in cli-core.ts (no database imports), so a client machine runs them from
 * a bundle (cli-remote.ts); this file adds the database door, `token` and `import`.
 */

export { formatCard, formatDetail, HttpBoard, rejectUnknownFlags, runVerb, USAGE, type BoardClient } from './cli-core.js';

/** The database door: the board functions as the caller named here. */
export class DbBoard implements BoardClient {
  constructor(private readonly me: string, private readonly viewer: string | null) {}
  boards() { return listBoards(this.viewer); }
  async list(f: CardFilter & { feature?: string }) {
    const { feature, ...rest } = f;
    return listCards({ ...rest, area: undefined, project: undefined, ...(await trackerRef({ area: f.area, project: f.project, feature })) }, this.viewer);
  }
  show(id: string) { return getCard(id, this.viewer); }
  async create(c: Record<string, unknown>) {
    const b = c as { title: string; assignee?: string | null; body?: string; contract?: Contract; area?: string; project?: string; feature?: string; board?: string; priority?: number; work?: string; needs?: string; repo?: string; ship_now?: boolean; kind?: string; deps?: string[] };
    const r = await createTask(await getAgent(this.me), { assignee: b.assignee ?? null, title: b.title, body: b.body, contract: b.contract, ...(await trackerRef(b)), board: b.board, priority: b.priority, type: b.work, needs: b.needs, repo: b.repo, shipNow: b.ship_now, kind: b.kind, deps: b.deps, run: config.env.ORG_RUN });
    return { card: r.card, message: r.message };
  }
  async comment(id: string, body: string) { await commentCard(this.me, id, body); }
  async assign(id: string, assignee: string | null, o: { area?: string; project?: string; feature?: string; work?: string; needs?: string; repo?: string; shipNow?: boolean }) {
    if (assignee === null) return assignCard(this.me, id, null);
    return (await assignTask(await getAgent(this.me), { taskId: id, assignee, ...(await trackerRef(o)), type: o.work, needs: o.needs, repo: o.repo, shipNow: o.shipNow, run: config.env.ORG_RUN })).card;
  }
  async redo(id: string, changes: string, runId?: string) {
    const r = await redoTask(await getAgent(this.me), id, changes, runId);
    return { escalated: r.escalated, task_id: r.task_id, rounds: r.rounds };
  }
  move(id: string, status: string, note?: string) { return moveCard(this.me, id, status, note); }
  link(id: string, dependsOn: string) { return linkCards(this.me, id, dependsOn); }
  claim(o: ClaimOpts) { return claimCard(this.viewer === null ? null : this.me, o); }
  async heartbeat(id: string, o: { tokens?: number; turns?: number; leaseMinutes?: number }) { await heartbeat(this.me, id, o); }
  finish(id: string, o: FinishOpts) { return finishCard(this.me, id, o); }
  flags(id: string, o: { shipNow?: boolean; needs?: string }) { return flagCard(this.me, id, o); }
  async watch(board: string | undefined, onEvent: (e: unknown) => void): Promise<() => void> {
    const bus = new BoardBus(config.env.SB_ORG_DB_URL && this.viewer ? agentDatabaseUrl(config.env.SB_ORG_DB_URL, this.viewer) : config.databaseUrl);
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

export async function main(argv: string[], out: (s: string) => void = console.log, env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch): Promise<number> {
  const { cmd, pos, opts } = parseVerb(argv);
  const json = opts.json === true;
  if (cmd && CLIENT_VERBS.includes(cmd)) return (await runVerb(cmd, pos, opts, boardClient(env, fetchFn), out))!;
  const need = (ok: unknown, usage: string): void => { if (!ok) throw new OrgError(usage); };

  switch (cmd) {
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
      const text = pos[0] ? readFileSync(pos[0], 'utf8') : (() => { throw new OrgError('import <file.json> [--board b] [--check]  (legacy migration tool)'); })();
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
  await exitFlushed(code);
}
