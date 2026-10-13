import { Router, type Request, type Response } from 'express';
import { HttpError, wrap } from './http.js';

/**
 * The Agents page's live half: the kanban board, Claude Code task logs and chats, and the Telegram/default-agent
 * toggle. This server is sandboxed (read-only home, no new privileges), so it can't run `hermes kanban`, start
 * Claude or touch systemd. agent-hub (argo-exo/agents/agent-hub, user hermes, 127.0.0.1 only) does those, and this
 * router forwards an allowlist of its routes with the hub's bearer token, which never reaches the browser.
 * On the Mac there is no hub: every route answers 503.
 */

export interface HubOptions {
  url?: string;
  token?: string;
  timeoutMs?: number;
}

const TASK = 't_[0-9a-f]{6,32}';
const CHAT = '[0-9a-f]{12}';
const ALLOWED: [string, RegExp][] = [
  ['GET', /^\/telegram$/],
  ['POST', /^\/telegram$/],
  ['GET', /^\/agents$/],
  ['GET', /^\/boards$/],
  ['GET', /^\/board$/],
  ['POST', /^\/tasks$/],
  ['GET', new RegExp(`^/tasks/${TASK}$`)],
  ['GET', new RegExp(`^/tasks/${TASK}/log$`)],
  ['POST', new RegExp(`^/tasks/${TASK}/comment$`)],
  ['GET', /^\/chats$/],
  ['POST', /^\/chats$/],
  ['GET', new RegExp(`^/chats/${CHAT}/events$`)],
  ['POST', new RegExp(`^/chats/${CHAT}/messages$`)],
  ['POST', new RegExp(`^/chats/${CHAT}/interrupt$`)],
];
const QUERY_KEYS = new Set(['board', 'offset']);

export function hubRouter(opts: HubOptions): Router {
  const router = Router();
  const timeoutMs = opts.timeoutMs ?? 60_000;

  router.use(
    wrap(async (req: Request, res: Response) => {
      if (!opts.url || !opts.token) {
        throw new HttpError(503, 'Agents run on the droplet: agent-hub is not configured on this machine');
      }
      const path = req.path;
      if (!ALLOWED.some(([m, re]) => m === req.method && re.test(path))) throw new HttpError(404, 'no such agents route');
      const search = new URLSearchParams();
      for (const [k, v] of Object.entries(req.query)) {
        if (QUERY_KEYS.has(k) && typeof v === 'string') search.set(k, v);
      }
      const target = `${opts.url.replace(/\/+$/, '')}${path}${search.size ? `?${search}` : ''}`;
      let upstream: globalThis.Response;
      try {
        upstream = await fetch(target, {
          method: req.method,
          headers: { Authorization: `Bearer ${opts.token}`, 'Content-Type': 'application/json' },
          body: req.method === 'POST' ? JSON.stringify(req.body ?? {}) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new HttpError(502, `agent-hub unreachable: ${(err as Error).message}`);
      }
      const body = (await upstream.json().catch(() => null)) as Record<string, unknown> | null;
      if (!upstream.ok) {
        // The hub answers { error: "..." }; the app's shape is { error: { message } }.
        const message = typeof body?.error === 'string' ? body.error : `agent-hub ${upstream.status}`;
        // A 401 from the hub is a token mismatch on the server, not the browser's session expiring.
        throw new HttpError(upstream.status === 401 ? 502 : upstream.status, message);
      }
      res.set('Cache-Control', 'no-store').json(body);
    }),
  );
  return router;
}
