import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { OrgError } from '../org.js';
import { factById, forget, listCandidates, listFacts, remember } from '../org-powers.js';
import { HttpError, parseOr400, wrap } from './http.js';

/**
 * Memory (docs/memory.md, engine core v2 phase 6): the sourced claims every runtime recalls (`memory_facts`), the
 * automatically saved session facts and the retire button. Read-mostly; the
 * one CLI (`secondbrain memory`) is the agent-facing door and this is the page's.
 */
const listFactsQuery = z.object({
  subject: z.string().trim().max(200).optional(),
  project: z.string().trim().max(100).optional(),
  agent: z.string().trim().max(64).optional(),
  author: z.string().trim().max(64).optional(),
  all: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const rememberBody = z.object({
  subject: z.string().trim().min(1).max(200),
  claim: z.string().trim().min(1).max(1000),
  source: z.string().trim().min(1).max(500),
  project: z.string().trim().max(100).optional(),
  agent: z.string().trim().max(64).optional(),
  inferred: z.boolean().default(false),
  supersedes: z.coerce.number().int().positive().optional(),
  via: z.string().trim().max(60).optional(),
});

/** A write the caller got wrong (a bad source, an agent not on the roster) is a 400, not a 500. */
function badRequest(err: unknown): never {
  if (err instanceof OrgError) throw new HttpError(400, err.message);
  throw err;
}

export function memoryRouter(): Router {
  const router = Router();
  const owner = (): { name: string } => ({ name: config.orgOwner });

  // Facts, newest first. `agent` narrows to one bot's own memory; without it, every fact, company-wide ones included.
  router.get('/', wrap(async (req, res) => {
    res.json({ facts: await listFacts(parseOr400(listFactsQuery, req.query)) });
  }));

  // Legacy read endpoint for session-fact history. New session facts are saved automatically.
  router.get('/candidates', wrap(async (req, res) => {
    const q = parseOr400(z.object({ status: z.enum(['proposed', 'promoted', 'rejected']).default('proposed'), limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    res.json({ candidates: await listCandidates(q) });
  }));

  router.post(['/candidates/:id/promote', '/candidates/:id/reject'], (_req, res) => {
    res.status(410).json({ error: 'Memory is saved automatically. Retire a saved fact if it is incorrect.' });
  });

  // One claim, written by the owner's session (the same write the CLI's `remember` makes).
  router.post('/', wrap(async (req, res) => {
    const body = parseOr400(rememberBody, req.body ?? {});
    res.json(await remember(owner(), body).catch(badRequest));
  }));

  router.post('/:id/retire', wrap(async (req, res) => {
    const id = parseOr400(z.coerce.number().int().positive(), req.params.id);
    const why = parseOr400(z.object({ why: z.string().trim().min(1).max(500) }), req.body ?? {}).why;
    if (!(await factById(id))) throw new HttpError(404, `no fact #${id}`);
    await forget(owner(), id, why).catch(badRequest);
    res.json({ id, status: 'retired' });
  }));

  return router;
}
