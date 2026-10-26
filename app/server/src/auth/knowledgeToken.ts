import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

/**
 * A read-only bearer token for an agent on the same machine as the app (zen-agent's `search_notes`, `search_everything`
 * and `read_note`). The search endpoints sit behind the browser login (password and a TOTP code), and an agent cannot
 * type a code, so without this it needs a copied session cookie that expires.
 *
 * The token opens three GET paths and nothing else, and only from the machine itself:
 * - exactly `/search`, `/search/global` and `/file/source` (the paths the knowledge tool calls), never a write;
 * - the socket must be loopback AND the request must carry no forwarding header, so a request that came through
 *   Caddy (which adds one) is refused even with the right token: a leaked token is useless from the internet;
 * - the token is compared in constant time, it is never logged, and unset means the gate does nothing.
 *
 * It does not authenticate anything itself: a good token sets `res.locals.knowledgeToken`, and the session gate lets
 * that request through. Everything else still needs a session.
 */
export const READ_PATHS: ReadonlySet<string> = new Set(['/search', '/search/global', '/file/source']);
const LOOPBACK: ReadonlySet<string> = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const FORWARDED = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'forwarded', 'x-real-ip'];

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

/** Mount under `/api`, ahead of the session gate. */
export function knowledgeTokenGate(token: string | undefined): RequestHandler {
  if (!token) return (_req, _res, next) => next();
  const want = digest(token);
  return (req, res, next) => {
    if (req.method !== 'GET' || !READ_PATHS.has(req.path)) return next();
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    if (!m) return next();
    if (!LOOPBACK.has(req.socket.remoteAddress ?? '') || FORWARDED.some((h) => req.headers[h] !== undefined)) return next();
    if (timingSafeEqual(digest(m[1]!), want)) res.locals.knowledgeToken = true;
    next();
  };
}
