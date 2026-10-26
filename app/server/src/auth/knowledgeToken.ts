import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

/**
 * A read-only bearer token for an agent on the same machine as the app (zen-agent's `search_notes`, `search_everything`
 * and `read_note`). The search endpoints sit behind the browser login (password and a TOTP code), and an agent cannot
 * type a code, so without this it needs a copied session cookie that expires.
 *
 * The token opens three GET paths and nothing else, and only from the machine itself:
 * - exactly `/search`, `/search/global` and `/file/source` (the paths the knowledge tool calls), never a write;
 * - the socket must be loopback AND the request must carry no forwarding header AND its Host must be a loopback name,
 *   so a request that came through Caddy is refused even with the right token: Caddy adds forwarding headers and
 *   forwards the public hostname, and either alone is enough to refuse. A leaked token is useless from the internet;
 *   a relay that strips headers still carries the public Host. (A deliberate `ssh -L` tunnel to the loopback port
 *   looks local, by design: that is the supported way to use the token from another machine.)
 * - the token is compared in constant time, it is never logged, and unset means the gate does nothing.
 *
 * It does not authenticate anything itself: a good token sets `res.locals.knowledgeToken`, and the session gate lets
 * that request through. Everything else still needs a session.
 */
export const READ_PATHS: ReadonlySet<string> = new Set(['/search', '/search/global', '/file/source']);
const LOOPBACK: ReadonlySet<string> = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i;
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
    if (!LOOPBACK_HOST.test(req.headers.host ?? '')) return next();
    if (timingSafeEqual(digest(m[1]!), want)) res.locals.knowledgeToken = true;
    next();
  };
}
