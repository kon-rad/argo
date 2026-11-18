import express, { Router, type Request } from 'express';
import { z } from 'zod';
import {
  ACK_LIMITS, AckRequestSchema, ChangeRequestSchema, DraftCreateRequestSchema, DraftFileWriteRequestSchema, SkillNameSchema,
} from '@secondbrain/contracts/skills';
import type { FeatureRoutes } from '../../features/types.js';
import { findDevice } from '../../ingest/devices.js';
import { HttpError, parseOr400, wrap } from '../../routes/http.js';
import { settings } from '../../settings.js';
import { LifecycleError } from './lifecycle.js';
import { recordAck } from './machines.js';
import { SkillsService } from './service.js';

/**
 * /api/skills (behind the login): library, detail, files, matrix, agent catalogs, machines, drafts
 * and proposed changes. Writes stay inside the vault's drafts and changes folders (lifecycle.ts).
 * /api/skills/ack (device token, before the login): a machine's bounded acknowledgement of what it
 * deployed. The token decides the host; the body cannot name one. No route runs a command on a host.
 */

const nameParam = (req: Request): string => parseOr400(SkillNameSchema, req.params['name']);
const lifecycle = async <T>(fn: () => Promise<T>): Promise<T> => {
  try { return await fn(); } catch (err) {
    if (err instanceof LifecycleError) throw new HttpError(err.status, err.message);
    throw err;
  }
};

export function skillsRouter(service: SkillsService): Router {
  const r = Router();
  r.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  r.get('/', wrap(async (req, res) => { res.json(await service.library(req.query['refresh'] === '1')); }));
  r.get('/matrix', wrap(async (_req, res) => { res.json(await service.matrix()); }));
  r.get('/machines', wrap(async (_req, res) => { res.json(await lifecycle(() => service.machines())); }));
  r.get('/agents/:agent', wrap(async (req, res) => {
    const agent = parseOr400(z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/), req.params['agent']);
    const out = await service.agent(agent);
    if (!out) throw new HttpError(404, `no agent ${agent} in the roster`);
    res.json(out);
  }));
  r.get('/skill/:name', wrap(async (req, res) => {
    const id = req.query['id'] === undefined ? undefined : parseOr400(z.string().min(3).max(200), req.query['id']);
    const out = await lifecycle(() => service.detail(nameParam(req), id));
    if (!out) throw new HttpError(404, 'no such skill');
    res.json(out);
  }));
  r.get('/skill/:name/file', wrap(async (req, res) => {
    const q = parseOr400(z.object({ id: z.string().min(3).max(200).optional(), path: z.string().min(1).max(255) }).strict(), req.query);
    const out = await lifecycle(() => service.file(nameParam(req), q.id, q.path));
    if (!out) throw new HttpError(404, 'no such file in the package');
    res.json(out);
  }));

  r.get('/drafts', wrap(async (_req, res) => { res.json({ drafts: await service.drafts() }); }));
  r.post('/drafts', wrap(async (req, res) => {
    const body = parseOr400(DraftCreateRequestSchema, req.body);
    res.status(201).json({ draft: await lifecycle(() => service.createDraft(body.name, body.from, body.description)) });
  }));
  r.get('/drafts/:name', wrap(async (req, res) => { res.json({ draft: await lifecycle(() => service.draft(nameParam(req))) }); }));
  r.get('/drafts/:name/file', wrap(async (req, res) => {
    const q = parseOr400(z.object({ path: z.string().min(1).max(255) }).strict(), req.query);
    const f = await lifecycle(() => service.readDraftFile(nameParam(req), q.path));
    res.json({ id: `draft:${nameParam(req)}`, ...f });
  }));
  r.put('/drafts/:name/file', wrap(async (req, res) => {
    const body = parseOr400(DraftFileWriteRequestSchema, req.body);
    res.json({ draft: await lifecycle(() => service.writeDraftFile(nameParam(req), body.path, body.content, body.exec)) });
  }));
  r.delete('/drafts/:name/file', wrap(async (req, res) => {
    const q = parseOr400(z.object({ path: z.string().min(1).max(255) }).strict(), req.query);
    res.json({ draft: await lifecycle(() => service.deleteDraftFile(nameParam(req), q.path)) });
  }));
  r.delete('/drafts/:name', wrap(async (req, res) => { await lifecycle(() => service.deleteDraft(nameParam(req))); res.json({ ok: true }); }));

  r.get('/changes', wrap(async (_req, res) => { res.json({ changes: await service.changes() }); }));
  r.post('/changes/preview', wrap(async (req, res) => {
    const body = parseOr400(ChangeRequestSchema, req.body);
    res.json({ preview: await lifecycle(() => service.preview(body)) });
  }));
  r.post('/changes', wrap(async (req, res) => {
    const body = parseOr400(ChangeRequestSchema, req.body);
    res.status(201).json({ change: await lifecycle(() => service.propose(body)) });
  }));
  return r;
}

export function ackRouter(): Router {
  const router = Router();
  router.post('/',
    // The token first: nobody without a live device token gets a body parsed.
    wrap(async (req, res) => {
      const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
      const device = m ? await findDevice(m[1]!) : null;
      if (!device) throw new HttpError(401, 'bad, revoked or missing device token');
      res.locals['device'] = device;
    }, true),
    express.json({ limit: ACK_LIMITS.bytes }),
    wrap(async (req, res) => {
      const body = AckRequestSchema.safeParse(req.body);
      if (!body.success) throw new HttpError(422, `invalid acknowledgement: ${body.error.issues.slice(0, 5).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
      const seen = new Set<string>();
      for (const v of body.data.views) {
        const k = `${v.agent}\0${v.runtime}`;
        if (seen.has(k)) throw new HttpError(422, `view ${v.agent}/${v.runtime} listed twice`);
        seen.add(k);
      }
      const device = res.locals['device'] as { id: number; host: string };
      const r = await recordAck(device, body.data);
      res.json({ host: device.host, ...r });
    }));
  return router;
}

export function serviceFor(vaultRoot: string): SkillsService {
  return new SkillsService(vaultRoot, settings(vaultRoot).skills);
}

export const routes: FeatureRoutes = ({ vaultRoot }) => [
  { path: '/api/skills/ack', router: ackRouter(), mount: 'raw' },
  { path: '/api/skills', router: skillsRouter(serviceFor(vaultRoot)) },
];
