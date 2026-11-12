import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function wrap(fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return (req, res, next) => { fn(req, res).then(() => undefined, next); };
}

export function parseOr400<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new HttpError(400, 'invalid request');
  return parsed.data;
}
