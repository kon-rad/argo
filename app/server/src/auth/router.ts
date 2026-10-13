import { createHash, randomBytes } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { log } from '../logger.js';
import { HttpError, parseOr400, wrap } from '../routes/http.js';
import { LoginLimiter } from './limiter.js';
import { verifyPassword } from './password.js';
import { verifyTotp } from './totp.js';

export interface AuthOptions {
  passwordHash: string;
  totpSecret: string;
  /** e.g. https://brain.example.com — the only Origin a mutating request may carry. */
  publicOrigin: string;
  /** False only in tests, which speak plain HTTP to supertest. */
  secureCookie?: boolean;
  limiter?: LoginLimiter;
  now?: () => number;
}

/** A borrowed laptop you forgot to log out of stops working within a week. */
const IDLE_MS = 7 * 24 * 60 * 60_000;
/** And any session, however active, has to re-authenticate monthly. */
const ABSOLUTE_MS = 30 * 24 * 60 * 60_000;

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

function cookieName(secure: boolean): string {
  // __Host- makes the browser refuse the cookie unless it is Secure, host-only
  // and Path=/ — a subdomain or plain-HTTP response can never plant or shadow it.
  return secure ? '__Host-sb_session' : 'sb_session';
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

async function sessionFor(token: string | null): Promise<boolean> {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
  // One statement: validates, enforces idle expiry, and slides last_seen at
  // most once a minute so browsing is not a write per request.
  const { rows } = await query<{ ok: boolean }>(
    `WITH s AS (
       SELECT token_hash FROM auth_sessions
       WHERE token_hash = $1 AND expires_at > now()
         AND last_seen_at > now() - ($2::bigint * interval '1 millisecond')
     ), touched AS (
       UPDATE auth_sessions SET last_seen_at = now()
       WHERE token_hash = (SELECT token_hash FROM s) AND last_seen_at < now() - interval '1 minute'
     )
     SELECT true AS ok FROM s`,
    [sha256(token), IDLE_MS],
  );
  return rows.length > 0;
}

/**
 * Serialises scrypt: each check allocates 128 MiB, so twenty concurrent login
 * attempts would be a memory-exhaustion attack on a small droplet.
 */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  pending = 0;
  run<T>(fn: () => Promise<T>): Promise<T> {
    this.pending++;
    const next = this.tail.then(fn, fn).finally(() => this.pending--);
    this.tail = next.catch(() => {});
    return next;
  }
}

const LoginBody = z.object({
  password: z.string().min(1).max(1024),
  code: z.string().min(6).max(12),
});

export function createAuth(opts: AuthOptions): { router: Router; requireSession: RequestHandler; checkOrigin: RequestHandler } {
  const secure = opts.secureCookie ?? true;
  const name = cookieName(secure);
  const limiter = opts.limiter ?? new LoginLimiter();
  const now = opts.now ?? Date.now;
  const kdf = new Mutex();

  const setCookie = (res: Response, value: string, maxAgeMs: number): void => {
    res.cookie(name, value, {
      httpOnly: true,
      secure,
      sameSite: 'strict',
      path: '/',
      maxAge: maxAgeMs,
    });
  };

  /**
   * CSRF: SameSite=Strict already keeps the cookie off cross-site requests;
   * this is the second, independent check. Applies to login too, so a hostile
   * page cannot log the browser into a session of its choosing.
   */
  const checkOrigin: RequestHandler = (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const origin = req.headers.origin;
    if (origin === opts.publicOrigin) return next();
    // Some browsers omit Origin on same-origin requests; Fetch Metadata is the fallback.
    if (!origin && req.headers['sec-fetch-site'] === 'same-origin') return next();
    res.status(403).json({ error: { message: 'cross-origin request refused' } });
  };

  const requireSession: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    sessionFor(readCookie(req, name))
      .then((ok) => {
        if (ok) return next();
        res.status(401).json({ error: { message: 'login required' } });
      })
      .catch(next);
  };

  const router = Router();

  router.get(
    '/me',
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ required: true, authenticated: await sessionFor(readCookie(req, name)) });
    }),
  );

  router.post(
    '/login',
    wrap(async (req, res) => {
      const ip = req.ip ?? 'unknown';
      const wait = limiter.retryAfter(ip);
      if (wait > 0) {
        res.setHeader('Retry-After', String(wait));
        throw new HttpError(429, `too many attempts — try again in ${Math.ceil(wait / 60)} min`);
      }
      if (kdf.pending >= 4) throw new HttpError(503, 'busy — try again');

      const body = parseOr400(LoginBody, req.body);
      // Both factors are always evaluated, and one generic message covers every
      // failure, so a response never says which half was right.
      const passwordOk = await kdf.run(() => verifyPassword(body.password, opts.passwordHash));
      const step = verifyTotp(opts.totpSecret, body.code, now());

      let fresh = false;
      if (passwordOk && step !== null) {
        // Single-use codes: only advances if this step is newer than the last
        // accepted one, atomically, so two racing requests cannot both win.
        const { rows } = await query(
          `INSERT INTO auth_totp_state (id, last_step) VALUES (true, $1)
           ON CONFLICT (id) DO UPDATE SET last_step = EXCLUDED.last_step
           WHERE auth_totp_state.last_step < EXCLUDED.last_step
           RETURNING last_step`,
          [step],
        );
        fresh = rows.length > 0;
      }

      if (!passwordOk || step === null || !fresh) {
        limiter.fail(ip);
        log.warn(`login failed from ${ip}`);
        throw new HttpError(401, 'wrong password or code');
      }

      limiter.succeed(ip);
      const token = randomBytes(32).toString('base64url');
      await query(
        `INSERT INTO auth_sessions (token_hash, expires_at, ip, user_agent)
         VALUES ($1, now() + ($2::bigint * interval '1 millisecond'), $3, $4)`,
        [sha256(token), ABSOLUTE_MS, ip, String(req.headers['user-agent'] ?? '').slice(0, 300)],
      );
      // Opportunistic cleanup; the table only ever holds a handful of rows.
      await query(`DELETE FROM auth_sessions WHERE expires_at < now()`);
      log.info(`login ok from ${ip}`);
      setCookie(res, token, ABSOLUTE_MS);
      res.json({ authenticated: true });
    }),
  );

  router.post(
    '/logout',
    wrap(async (req, res) => {
      const token = readCookie(req, name);
      if (token) await query(`DELETE FROM auth_sessions WHERE token_hash = $1`, [sha256(token)]);
      res.clearCookie(name, { httpOnly: true, secure, sameSite: 'strict', path: '/' });
      res.json({ authenticated: false });
    }),
  );

  // "I lost my phone": ends every session on every device, this one included.
  router.post(
    '/logout-all',
    requireSession,
    wrap(async (_req, res) => {
      const { rowCount } = await query(`DELETE FROM auth_sessions`);
      res.clearCookie(name, { httpOnly: true, secure, sameSite: 'strict', path: '/' });
      res.json({ authenticated: false, ended: rowCount ?? 0 });
    }),
  );

  return { router, requireSession, checkOrigin };
}
