import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { log } from '../logger.js';

/** Thrown by routes; anything else reaching the error handler is a 500. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/**
 * Express 5 forwards rejected promises, but only from a handler it can see.
 * `passOn`: a middleware step that calls next() once `fn` resolves.
 */
export function wrap(
  fn: (req: Request, res: Response) => Promise<unknown>,
  passOn = false,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res).then(() => { if (passOn) next(); }, next);
  };
}

export function parseOr400<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new HttpError(400, 'invalid request', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return parsed.data;
}

export function intParam(raw: string | string[] | undefined, what: string): number {
  const n = typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `invalid ${what}`);
  return n;
}

/**
 * `expose` is true on the Mac, where the raw message is the fastest way to
 * debug. On the server an unexpected error's text (SQL, file paths) is
 * reconnaissance for anyone who can trigger it, so it stays in the log.
 */
export function errorHandlerFor(expose: boolean) {
  return function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: { message: err.message, ...err.extra } });
      return;
    }
    // body-parser's own errors (oversized or malformed JSON) carry a status.
    const status = (err as { status?: unknown })?.status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      res.status(status).json({ error: { message: (err as Error).message } });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error('unhandled route error:', err);
    res.status(500).json({ error: { message: expose ? message : 'internal error' } });
  };
}

export const errorHandler = errorHandlerFor(true);
