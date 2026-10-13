import { Router } from 'express';
import { z } from 'zod';
import { describeSchema, runReadOnly, schemaAsText } from '../dbExplorer.js';
import type { SqlGenerator } from '../sqlgen.js';
import { HttpError, parseOr400, wrap } from './http.js';

const Ask = z.object({ question: z.string().trim().min(1, 'a question is required').max(2000) });
const Run = z.object({ sql: z.string().trim().min(1, 'SQL is required').max(20_000) });

/**
 * The Database page: the schema as the catalog sees it, a question box that
 * writes SQL, and a runner that executes it read-only. Generating and running
 * are separate calls on purpose — the SQL is shown and editable before and
 * after it runs, so a wrong guess from the model is one edit away from right.
 */
export function databaseRouter(generator?: () => SqlGenerator): Router {
  const router = Router();

  router.get(
    '/schema',
    wrap(async (_req, res) => {
      res.json({ tables: await describeSchema() });
    }),
  );

  router.post(
    '/ask',
    wrap(async (req, res) => {
      const { question } = parseOr400(Ask, req.body);
      let generate: SqlGenerator;
      try {
        if (!generator) throw new Error('SQL generation is not configured on this server');
        generate = generator();
      } catch (err) {
        throw new HttpError(503, err instanceof Error ? err.message : String(err));
      }
      const schema = schemaAsText(await describeSchema());
      try {
        res.json(await generate(question, schema));
      } catch (err) {
        throw new HttpError(502, err instanceof Error ? err.message : String(err));
      }
    }),
  );

  router.post(
    '/query',
    wrap(async (req, res) => {
      const { sql } = parseOr400(Run, req.body);
      res.json(await runReadOnly(sql));
    }),
  );

  return router;
}
