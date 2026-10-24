import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import {
  assignCard, BLOCK_KINDS, BoardBus, BoardError, CARD_KINDS, claimCard, commentCard, finishCard, flagCard, getCard, heartbeat, linkCards, listBoards,
  listCards, listTokens, moveCard, OUTCOMES, reclaim, revokeToken, STATUSES, findToken, type BoardNotice,
} from '../board.js';
import { config } from '../config.js';
import { assignTask, createTask, getAgent, hermesProjection, OrgError, type Agent } from '../org.js';
import { HttpError, intParam, parseOr400, wrap } from './http.js';
import type { HubOptions } from './hub.js';

/**
 * /api/board: the board module's API (docs/board-design.md section 5). Three doors, one identity: a browser
 * session acts as the owner (ORG_OWNER); a request with `Authorization: Bearer sbb_…` acts as the roster member
 * its board token names; a process on the server uses the CLI, not this router. The rules live in the SQL
 * functions, so these handlers only parse and call.
 */

export interface BoardRouterOptions {
  /** The app's session check, applied to requests without a token. Absent on a local install (no login). */
  sessionGate?: RequestHandler;
  /** Who a session acts as; defaults to ORG_OWNER. */
  owner?: string;
  /** The live feed's source; one per process. */
  bus?: BoardBus;
  /** agent-hub, while the Claude lanes' worker logs still live there: GET /cards/:id/log forwards to it. */
  hub?: HubOptions;
}

const Name = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const BoardSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/);
const Id = z.string().regex(/^t_[0-9a-f]{6,32}$/);
const Contract = z.object({
  objective: z.string().max(4000).optional(),
  returns: z.array(z.string().max(500)).max(20).optional(),
  budget: z.object({ turns: z.number().int().positive().optional(), tokens: z.number().int().positive().optional(), minutes: z.number().int().positive().optional(), wakes: z.number().int().positive().optional() }).optional(),
  scope: z.array(z.string().max(500)).max(50).optional(),
  verification: z.string().max(2000).optional(),
});
const ListQuery = z.object({
  board: BoardSlug.optional(), status: z.string().regex(/^[a-z,]+$/).optional(), assignee: z.union([Name, z.literal('none')]).optional(), project: Slug.optional(), feature: Slug.optional(),
  kind: z.enum(CARD_KINDS).optional(), q: z.string().trim().min(1).max(200).optional(), done_days: z.coerce.number().int().min(0).max(3650).optional(), limit: z.coerce.number().int().min(1).max(2000).optional(),
});
const NewCardBody = z.object({
  board: BoardSlug.optional(), title: z.string().trim().min(1).max(200), body: z.string().max(20000).optional(), contract: Contract.optional(),
  assignee: Name.nullable().optional(), project: Slug.optional(), feature: Slug.optional(), kind: z.enum(CARD_KINDS).optional(),
  work: z.enum(['research', 'coding', 'design', 'media', 'writing', 'sales', 'education', 'ops']).optional(), needs: z.enum(['code', 'review', 'merge', 'deploy', 'm1', 'web']).optional(),
  repo: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/).optional(), priority: z.number().int().min(1).max(5).optional(), deps: z.array(Id).max(50).optional(), ship_now: z.boolean().optional(),
});
const AssignBody = z.object({ assignee: Name.nullable(), project: Slug.optional(), feature: Slug.optional(), work: z.string().optional(), needs: z.string().optional() });
const CommentBody = z.object({ body: z.string().trim().min(1).max(8000) });
const MoveBody = z.object({ status: z.enum(STATUSES), note: z.string().trim().max(2000).optional() });
const LinkBody = z.object({ depends_on: Id });
const FlagsBody = z.object({ ship_now: z.boolean().optional(), needs: z.enum(['code', 'review', 'merge', 'deploy', 'm1', 'web']).optional() });
const ClaimBody = z.object({ runtime: z.string().regex(/^[a-z-]{1,20}$/).optional(), agent: Name.optional(), board: BoardSlug.optional(), lease_minutes: z.number().int().min(1).max(1440).optional(), wakeup: z.number().int().positive().optional() });
const HeartbeatBody = z.object({ tokens: z.number().int().nonnegative().optional(), turns: z.number().int().nonnegative().optional(), lease_minutes: z.number().int().min(1).max(1440).optional() });
const FinishBody = z.object({
  outcome: z.enum(OUTCOMES), result: z.string().trim().max(4000).optional(), block_kind: z.enum(BLOCK_KINDS).optional(),
  verification: z.object({ kind: z.enum(['test', 'manual', 'deploy', 'review', 'metric']).optional(), check: z.string().trim().min(1).max(500), result: z.enum(['pass', 'fail']).optional(), evidence: z.string().max(4000).optional() }).optional(),
  tokens: z.number().int().nonnegative().optional(), turns: z.number().int().nonnegative().optional(), run_id: z.string().max(200).optional(),
});

async function boardErrors<T>(fnc: () => Promise<T>): Promise<T> {
  try {
    return await fnc();
  } catch (err) {
    if (err instanceof BoardError) throw new HttpError(err.status, err.message);
    if (err instanceof OrgError) throw new HttpError(/^unknown agent|^no card|^no project|^no feature/.test(err.message) ? 404 : /can't|only the owner|doesn't have|not a bot|takes vault work|is worked by/.test(err.message) ? 403 : 400, err.message);
    throw err;
  }
}

interface Caller {
  /** The roster name every write is made as. */
  name: string;
  /** Null for the owner's session: sees every board. A token's agent sees the company boards and its team's. */
  viewer: string | null;
  viaToken: boolean;
}

export function boardRouter(opts: BoardRouterOptions = {}): Router {
  const router = Router();
  const owner = opts.owner ?? config.orgOwner;
  const bus = opts.bus ?? new BoardBus();

  // Identity first. A bearer token names the caller; otherwise the session (when there is a gate) means the owner.
  router.use((req, res, next) => {
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    if (m) {
      findToken(m[1]!).then(
        (t) => {
          if (!t) return next(new HttpError(401, 'bad, revoked or missing board token'));
          res.locals['caller'] = { name: t.agent, viewer: t.agent, viaToken: true } satisfies Caller;
          next();
        },
        next,
      );
      return;
    }
    const asOwner = (): void => {
      res.locals['caller'] = { name: owner, viewer: null, viaToken: false } satisfies Caller;
      next();
    };
    if (opts.sessionGate) opts.sessionGate(req, res, (err?: unknown) => (err ? next(err) : asOwner()));
    else asOwner();
  });
  const caller = (res: Response): Caller => res.locals['caller'] as Caller;
  const agentOf = async (c: Caller): Promise<Agent> =>
    boardErrors(() => getAgent(c.name)).catch((err: unknown) => {
      if (err instanceof HttpError && err.status === 404 && !c.viaToken) throw new HttpError(503, `no org agent named ${c.name} in this database: run cli-org import on the server`);
      throw err;
    });
  const noStore = (res: Response): void => void res.setHeader('Cache-Control', 'no-store');

  router.get('/boards', wrap(async (_req, res) => {
    noStore(res);
    res.json({ boards: await boardErrors(() => listBoards(caller(res).viewer)) });
  }));

  router.get('/cards', wrap(async (req, res) => {
    const q = parseOr400(ListQuery, req.query);
    noStore(res);
    res.json({ cards: await boardErrors(() => listCards({ ...q, doneDays: q.done_days }, caller(res).viewer)) });
  }));

  router.get('/cards/:id', wrap(async (req, res) => {
    const id = parseOr400(Id, req.params['id']);
    noStore(res);
    res.json(await boardErrors(() => getCard(id, caller(res).viewer)));
  }));

  // Create and assign go through the org's verbs: the repo rule, the team mention and the Hermes projection live there.
  router.post('/cards', wrap(async (req, res) => {
    const b = parseOr400(NewCardBody, req.body);
    const me = await agentOf(caller(res));
    const r = await boardErrors(() => createTask(me, {
      assignee: b.assignee ?? null, title: b.title, body: b.body, contract: b.contract, project: b.project, feature: b.feature, board: b.board, priority: b.priority,
      type: b.work, needs: b.needs, repo: b.repo, shipNow: b.ship_now, kind: b.kind, deps: b.deps, run: 'app',
    }, hermesProjection()));
    res.status(201).json({ card: r.card, message: r.message });
  }));

  router.post('/cards/:id/assign', wrap(async (req, res) => {
    const id = parseOr400(Id, req.params['id']);
    const b = parseOr400(AssignBody, req.body);
    const me = await agentOf(caller(res));
    if (b.assignee === null) {
      res.json({ card: await boardErrors(() => assignCard(me.name, id, null)) });
      return;
    }
    const r = await boardErrors(() => assignTask(me, { taskId: id, assignee: b.assignee!, project: b.project, feature: b.feature, type: b.work, needs: b.needs, run: 'app' }, hermesProjection()));
    res.json({ card: r.card, message: r.message });
  }));

  router.post('/cards/:id/comment', wrap(async (req, res) => {
    const id = parseOr400(Id, req.params['id']);
    const b = parseOr400(CommentBody, req.body);
    res.status(201).json({ comment: await boardErrors(() => commentCard(caller(res).name, id, b.body)) });
  }));

  router.post('/cards/:id/move', wrap(async (req, res) => {
    const id = parseOr400(Id, req.params['id']);
    const b = parseOr400(MoveBody, req.body);
    res.json({ card: await boardErrors(() => moveCard(caller(res).name, id, b.status, b.note)) });
  }));

  router.post('/cards/:id/link', wrap(async (req, res) => {
    const id = parseOr400(Id, req.params['id']);
    const b = parseOr400(LinkBody, req.body);
    await boardErrors(() => linkCards(caller(res).name, id, b.depends_on));
    res.json({ ok: true });
  }));

  router.post('/cards/:id/flags', wrap(async (req, res) => {
    const id = parseOr400(Id, req.params['id']);
    const b = parseOr400(FlagsBody, req.body);
    res.json({ card: await boardErrors(() => flagCard(caller(res).name, id, { shipNow: b.ship_now, needs: b.needs })) });
  }));

  router.post('/claim', wrap(async (req, res) => {
    const b = parseOr400(ClaimBody, req.body ?? {});
    const c = caller(res);
    // The owner's session claims as the owner's process (any lane); a token claims as its agent (its own cards, or any with dispatch).
    const card = await boardErrors(() => claimCard(c.viaToken ? c.name : null, { runtime: b.runtime, agent: b.agent, board: b.board, leaseMinutes: b.lease_minutes, wakeup: b.wakeup }));
    if (!card) {
      res.status(204).end();
      return;
    }
    res.json({ card });
  }));

  router.post('/cards/:id/heartbeat', wrap(async (req, res) => {
    const id = parseOr400(Id, req.params['id']);
    const b = parseOr400(HeartbeatBody, req.body ?? {});
    res.json({ run: await boardErrors(() => heartbeat(caller(res).name, id, { tokens: b.tokens, turns: b.turns, leaseMinutes: b.lease_minutes })) });
  }));

  router.post('/cards/:id/finish', wrap(async (req, res) => {
    const id = parseOr400(Id, req.params['id']);
    const b = parseOr400(FinishBody, req.body);
    res.json({ card: await boardErrors(() => finishCard(caller(res).name, id, { outcome: b.outcome, result: b.result, blockKind: b.block_kind, verification: b.verification, tokens: b.tokens, turns: b.turns, runId: b.run_id })) });
  }));

  // The live feed: one line per board event, a comment every 25 s so proxies keep the stream open.
  router.get('/events', (req: Request, res: Response) => {
    const vis = caller(res).viewer;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`: connected\n\n`);
    const send = (n: BoardNotice): void => {
      res.write(`data: ${JSON.stringify(n)}\n\n`);
    };
    let unsubscribe: (() => void) | null = null;
    const start = async (): Promise<void> => {
      // A token's agent hears only about the boards it may read.
      const allowed = vis === null ? null : new Set((await listBoards(vis)).map((b) => b.slug));
      unsubscribe = bus.subscribe((n) => {
        if (allowed === null || (n.board && allowed.has(n.board))) send(n);
      });
    };
    void start();
    const beat = setInterval(() => res.write(`: ping\n\n`), 25_000);
    req.on('close', () => {
      clearInterval(beat);
      unsubscribe?.();
    });
  });

  // While the Claude lanes' worker logs live on agent-hub, the card's log comes from there.
  router.get('/cards/:id/log', wrap(async (req, res) => {
    const id = parseOr400(Id, req.params['id']);
    if (!opts.hub?.url || !opts.hub.token) throw new HttpError(404, 'no worker log for this card: no agent-hub is configured here');
    const offset = typeof req.query['offset'] === 'string' ? req.query['offset'] : '0';
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(`${opts.hub.url.replace(/\/+$/, '')}/tasks/${id}/log?offset=${encodeURIComponent(offset)}`, {
        headers: { Authorization: `Bearer ${opts.hub.token}` }, signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new HttpError(502, `agent-hub unreachable: ${(err as Error).message}`);
    }
    const body = (await upstream.json().catch(() => null)) as Record<string, unknown> | null;
    if (!upstream.ok) throw new HttpError(upstream.status === 401 ? 502 : upstream.status, typeof body?.error === 'string' ? body.error : `agent-hub ${upstream.status}`);
    noStore(res);
    res.json(body);
  }));

  // Tokens: who may reach the board from elsewhere. The owner's session only; minting stays on the CLI (the secret is shown once, in a terminal).
  const ownerOnly = (res: Response): void => {
    if (caller(res).viaToken) throw new HttpError(403, 'tokens are managed by the owner, from a session or the CLI');
  };
  router.get('/tokens', wrap(async (_req, res) => {
    ownerOnly(res);
    noStore(res);
    res.json({ tokens: await listTokens() });
  }));
  router.post('/tokens/:id/revoke', wrap(async (req, res) => {
    ownerOnly(res);
    const id = intParam(req.params['id'], 'token id');
    if (!(await revokeToken(id))) throw new HttpError(404, `no live token ${id}`);
    res.json({ ok: true });
  }));

  // The sweep a timer runs: lost leases and due schedules. Owner only.
  router.post('/reclaim', wrap(async (_req, res) => {
    ownerOnly(res);
    res.json({ reclaimed: await reclaim() });
  }));

  return router;
}
