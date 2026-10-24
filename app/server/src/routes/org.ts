import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import {
  agentActivity,
  agentRuns,
  channelMembers,
  dm,
  getAgent,
  getThread,
  listChannels,
  listTasks,
  markChannelRead,
  messagesBy,
  orgChart,
  OrgError,
  pageMessages,
  post,
  searchMessages,
  whoami,
  type Agent,
  type Kind,
} from '../org.js';
import { listApprovals, listFacts, shipDecide } from '../org-powers.js';
import { corePath, listEpisodes, listMemory, listProposals, memorySettingsFor, memoryStats } from '../org-memory.js';
import { config } from '../config.js';
import { HttpError, intParam, parseOr400, wrap } from './http.js';

/**
 * The /org page's API: the agent company's board read as the owner (the
 * human agent named by ORG_OWNER, who sees every channel). Writes are posted
 * as the owner too. Identity is fixed here, not taken from the request: the
 * only person with a session on this app is the owner.
 */

const Name = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
const Channel = z.string().regex(/^[a-z0-9][a-z0-9:-]{0,79}$/);
const Page = z.object({
  channel: Channel.optional(),
  after: z.coerce.number().int().nonnegative().optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
const PostBody = z.object({
  channel: Channel,
  body: z.string().trim().min(1).max(8000),
  kind: z.enum(['message', 'status', 'decision']).optional(),
  thread: z.number().int().positive().optional(),
});
const DmBody = z.object({ to: Name, body: z.string().trim().min(1).max(8000) });
const DecideBody = z.object({ note: z.string().trim().max(2000).optional() });
const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const TaskQuery = z.object({ project: Slug.optional(), feature: Slug.optional(), agent: Name.optional(), limit: z.coerce.number().int().min(1).max(1000).optional() });

interface AgentCaps {
  wakes_per_day: number;
  cooldown_minutes: number;
  max_runtime_minutes: number;
  lane: string | null;
  routines: { name: string; at?: string; on?: string; kind?: string }[];
}

async function orgErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof OrgError) {
      const msg = err.message;
      throw new HttpError(/^unknown agent|^no channel|^no message/.test(msg) ? 404 : 400, msg);
    }
    throw err;
  }
}

async function readText(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch(() => null);
}

export function orgRouter(vaultRoot: string): Router {
  const router = Router();

  // Every handler reads and writes as the owner; resolve them once per request.
  router.use((_req, res, next) => {
    getAgent(config.orgOwner).then(
      (a) => {
        res.locals['owner'] = a;
        next();
      },
      () => next(new HttpError(503, `no org agent named ${config.orgOwner} in this database: run cli-org import on the server`)),
    );
  });
  const owner = (res: { locals: Record<string, unknown> }): Agent => res.locals['owner'] as Agent;

  /** Caps and routines per agent from the compiled org file in the vault; empty when it is missing. */
  const caps = async (): Promise<Record<string, AgentCaps>> => {
    const text = await readText(join(vaultRoot, '.agents', 'org', 'org-agents.json'));
    if (!text) return {};
    try {
      const doc = JSON.parse(text) as { agents?: Record<string, Partial<AgentCaps>> };
      return Object.fromEntries(
        Object.entries(doc.agents ?? {}).map(([n, a]) => [
          n,
          {
            wakes_per_day: a.wakes_per_day ?? 0,
            cooldown_minutes: a.cooldown_minutes ?? 0,
            max_runtime_minutes: a.max_runtime_minutes ?? 0,
            lane: a.lane ?? null,
            routines: a.routines ?? [],
          },
        ]),
      );
    } catch {
      return {};
    }
  };

  router.get(
    '/chart',
    wrap(async (_req, res) => {
      const [chart, activity, limits] = await Promise.all([orgChart(), agentActivity(), caps()]);
      res.json({
        teams: chart.teams,
        agents: chart.agents.map((a) => ({ ...a, activity: activity[a.name] ?? null, caps: limits[a.name] ?? null })),
      });
    }),
  );

  router.get(
    '/channels',
    wrap(async (_req, res) => {
      res.json({ channels: await listChannels(owner(res)) });
    }),
  );

  router.get(
    '/channels/:slug/members',
    wrap(async (req, res) => {
      const slug = parseOr400(Channel, req.params['slug']);
      res.json({ members: await orgErrors(() => channelMembers(owner(res), slug)) });
    }),
  );

  router.post(
    '/channels/:slug/read',
    wrap(async (req, res) => {
      const slug = parseOr400(Channel, req.params['slug']);
      await orgErrors(() => markChannelRead(owner(res), slug));
      res.json({ ok: true });
    }),
  );

  router.get(
    '/messages',
    wrap(async (req, res) => {
      const q = parseOr400(Page, req.query);
      const messages = await orgErrors(() => pageMessages(owner(res), q.channel, q));
      res.setHeader('Cache-Control', 'no-store');
      res.json({ messages, cursor: messages.length ? messages[messages.length - 1]!.id : (q.after ?? 0) });
    }),
  );

  router.get(
    '/thread/:id',
    wrap(async (req, res) => {
      const id = intParam(req.params['id'], 'message id');
      res.json({ messages: await orgErrors(() => getThread(owner(res), id)) });
    }),
  );

  router.get(
    '/search',
    wrap(async (req, res) => {
      const { q, limit } = parseOr400(z.object({ q: z.string().trim().min(1).max(200), limit: z.coerce.number().int().min(1).max(200).optional() }), req.query);
      res.json({ messages: await searchMessages(owner(res), q, limit) });
    }),
  );

  router.get(
    '/agents/:name',
    wrap(async (req, res) => {
      const name = parseOr400(Name, req.params['name']);
      const agent = await orgErrors(() => getAgent(name));
      const [who, runs, posts, limits, prompt, memory, core, memoryRows, episodes, proposals, stats] = await Promise.all([
        whoami(agent),
        agentRuns(name),
        messagesBy(owner(res), name),
        caps(),
        readText(join(vaultRoot, '.claude', 'agents', `${name}.md`)),
        readText(join(vaultRoot, '.agents', 'org', 'memory', `${name}.md`)),
        readText(corePath(vaultRoot, name)),
        listMemory(name, { limit: 100 }),
        listEpisodes(name, 20),
        listProposals(name, 20),
        memoryStats(name, 14),
      ]);
      let memoryConfig: unknown = null;
      try {
        memoryConfig = memorySettingsFor(vaultRoot, name).memory;
      } catch {
        /* a bad block in the compiled org file: the page still renders */
      }
      res.json({
        agent: who.agent,
        team: who.team,
        is_lead: who.is_lead,
        reports: who.reports,
        channels: who.channels,
        open_wakeups: who.wakeups,
        runs,
        posts,
        caps: limits[name] ?? null,
        // The compiled definition minus its frontmatter: the identity, personality and rules the agent runs with.
        prompt: prompt ? prompt.replace(/^---\n[\s\S]*?\n---\n/, '').trim() : null,
        memory,
        memory_path: `.agents/org/memory/${name}.md`,
        // The persona memory (docs/agent-memory.md): the generated core block, its rows, the episodes behind them,
        // the self-improvement proposals it filed, and the numbers the ledger reads.
        core,
        core_path: `.agents/org/memory/${name}/core.md`,
        memory_rows: memoryRows,
        episodes,
        proposals,
        memory_stats: stats,
        memory_config: memoryConfig,
      });
    }),
  );

  // The work graph: cards for bots with their project and feature (task_links). Status lives on the kanban (agent-hub).
  router.get(
    '/tasks',
    wrap(async (req, res) => {
      const q = parseOr400(TaskQuery, req.query);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ tasks: await listTasks(q) });
    }),
  );

  router.post(
    '/post',
    wrap(async (req, res) => {
      const b = parseOr400(PostBody, req.body);
      const m = await orgErrors(() => post(owner(res), b.channel, b.body, { kind: b.kind as Kind | undefined, thread: b.thread, run: 'app' }));
      res.status(201).json(m);
    }),
  );

  // Ship approvals: the panel on /org. Only the owner has a session here, so approving from the page is the owner's yes.
  router.get(
    '/approvals',
    wrap(async (req, res) => {
      res.json(await listApprovals({ pending: req.query['pending'] === '1', limit: 50 }));
    }),
  );

  router.post(
    '/approvals/:id/:decision',
    wrap(async (req, res) => {
      const id = parseOr400(z.coerce.number().int().positive(), req.params['id']);
      const decision = parseOr400(z.enum(['approve', 'deny']), req.params['decision']);
      const b = parseOr400(DecideBody, req.body ?? {});
      if (decision === 'deny' && !b.note) throw new HttpError(400, 'a denial says why');
      res.json(await orgErrors(() => shipDecide(owner(res), id, decision === 'approve', b.note, {})));
    }),
  );

  router.get(
    '/facts',
    wrap(async (req, res) => {
      res.json(await listFacts({ subject: typeof req.query['subject'] === 'string' ? req.query['subject'] : undefined, limit: 100 }));
    }),
  );

  router.post(
    '/dm',
    wrap(async (req, res) => {
      const b = parseOr400(DmBody, req.body);
      const m = await orgErrors(() => dm(owner(res), b.to, b.body, { run: 'app' }));
      res.status(201).json(m);
    }),
  );

  return router;
}
