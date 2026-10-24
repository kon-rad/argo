import { Router, type Request, type Response } from 'express';
import { HttpError, wrap } from './http.js';

/**
 * An allowlisted reverse proxy to a loopback service that holds the hands this server does not have. This server is
 * sandboxed (read-only home, no new privileges), so anything that runs a shell, starts an agent or touches systemd
 * lives in another process (agent-hub, `zen-agent serve`) that listens on 127.0.0.1 with a bearer token. A proxy
 * forwards only the routes it names, only the query keys it names, and adds the token, which never reaches the
 * browser. Where the upstream is not configured (the Mac), every route answers 503 with a plain explanation.
 */
export interface ProxyOptions {
  url?: string;
  token?: string;
  timeoutMs?: number;
}

export interface ProxySpec {
  /** How the upstream is called in error messages ("agent-hub", "zen-agent"). */
  name: string;
  /** Method and path (after the mount point) of every route that may pass. */
  allowed: [string, RegExp][];
  queryKeys: ReadonlySet<string>;
  /** The 503 message when `url` or `token` is missing. */
  unconfigured: string;
  /** Put in front of the request path on the way upstream ("/zen" turns /chats into /zen/chats). */
  prefix?: string;
}

export function allowlistProxy(opts: ProxyOptions, spec: ProxySpec): Router {
  const router = Router();
  const timeoutMs = opts.timeoutMs ?? 60_000;

  router.use(
    wrap(async (req: Request, res: Response) => {
      if (!opts.url || !opts.token) throw new HttpError(503, spec.unconfigured);
      const path = req.path;
      if (!spec.allowed.some(([m, re]) => m === req.method && re.test(path))) throw new HttpError(404, `no such ${spec.name} route`);
      const search = new URLSearchParams();
      for (const [k, v] of Object.entries(req.query)) {
        if (spec.queryKeys.has(k) && typeof v === 'string') search.set(k, v);
      }
      const target = `${opts.url.replace(/\/+$/, '')}${spec.prefix ?? ''}${path}${search.size ? `?${search}` : ''}`;
      let upstream: globalThis.Response;
      try {
        upstream = await fetch(target, {
          method: req.method,
          headers: { Authorization: `Bearer ${opts.token}`, 'Content-Type': 'application/json' },
          body: req.method === 'POST' || req.method === 'PUT' ? JSON.stringify(req.body ?? {}) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new HttpError(502, `${spec.name} unreachable: ${(err as Error).message}`);
      }
      const body = (await upstream.json().catch(() => null)) as Record<string, unknown> | null;
      if (!upstream.ok) {
        // The upstream answers { error: "..." }; the app's shape is { error: { message } }.
        const message = typeof body?.error === 'string' ? body.error : `${spec.name} ${upstream.status}`;
        // A 401 from upstream is a token mismatch on the server, not the browser's session expiring.
        throw new HttpError(upstream.status === 401 ? 502 : upstream.status, message);
      }
      res.set('Cache-Control', 'no-store').json(body);
    }),
  );
  return router;
}
