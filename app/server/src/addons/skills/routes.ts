import express, { Router, type Request } from 'express';
import { z } from 'zod';
import {
  ACK_LIMITS, AckRequestSchema, AgentNameSchema, ChangeRequestSchema, DigestSchema, DraftCreateRequestSchema, DraftFileDeleteRequestSchema, DraftFileWriteRequestSchema, RuntimeSchema, SkillNameSchema,
} from '@secondbrain/contracts/skills';
import type { FeatureRoutes } from '../../features/types.js';
import { config } from '../../config.js';
import { findDevice } from '../../ingest/devices.js';
import { HttpError, parseOr400, wrap } from '../../routes/http.js';
import { settings } from '../../settings.js';
import { LifecycleError } from './lifecycle.js';
import { recordAck } from './machines.js';
import { SkillsService } from './service.js';
import { PolicyReviewError } from './policy-review.js';
import { planFingerprint, planViews, ReconcileError, validatePlanCapacity, type Plan } from './reconcile.js';

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
    if (err instanceof PolicyReviewError) throw new HttpError(err.status, err.message);
    if (err instanceof ReconcileError) throw new HttpError(409, err.message);
    throw err;
  }
};

export function skillsRouter(service: SkillsService, ownerIdentity = config.orgOwner): Router {
  const r = Router();
  r.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  r.get('/', wrap(async (req, res) => { res.json(await service.library(req.query['refresh'] === '1')); }));
  r.get('/matrix', wrap(async (_req, res) => { res.json(await service.matrix()); }));
  r.get('/machines', wrap(async (_req, res) => { res.json(await lifecycle(() => service.machines())); }));
  r.post('/policy/approve', wrap(async (req, res) => {
    const body = parseOr400(z.object({
      digest: DigestSchema, revision: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
      source: z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/),
      approvedBy: z.string().trim().min(1).max(100).regex(/^[^\u0000-\u001f\u007f]+$/).optional(),
    }).strict(), req.body);
    if (body.approvedBy !== undefined && body.approvedBy !== ownerIdentity) throw new HttpError(400, 'Policy approval identity is the configured authenticated owner; a request cannot select another reviewer.');
    res.status(201).json({ approval: await lifecycle(() => service.approvePolicy({ digest: body.digest, revision: body.revision, source: body.source, approvedBy: ownerIdentity })) });
  }));
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
    res.json({ draft: await lifecycle(() => service.writeDraftFile(nameParam(req), body.path, body.content, body.exec, body.expectedVersion)) });
  }));
  r.delete('/drafts/:name/file', wrap(async (req, res) => {
    const q = parseOr400(z.object({ path: z.string().min(1).max(255) }).strict(), req.query);
    const body = parseOr400(DraftFileDeleteRequestSchema, req.body);
    res.json({ draft: await lifecycle(() => service.deleteDraftFile(nameParam(req), q.path, body.expectedVersion)) });
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

/** A device may verify a canonical reviewed plan, but it may never create policy approval. */
export function authorizeRouter(service: SkillsService): Router {
  const router = Router();
  router.post('/',
    wrap(async (req, res) => {
      const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
      const device = match ? await findDevice(match[1]!) : null;
      if (!device) throw new HttpError(401, 'bad, revoked or missing device token');
      res.locals['device'] = device;
      res.setHeader('Cache-Control', 'no-store');
    }, true),
    express.json({ limit: 32 * 1024 }),
    wrap(async (req, res) => {
      const body = parseOr400(z.object({
        policyDigest: DigestSchema, fingerprint: DigestSchema,
        views: z.array(z.object({ agent: AgentNameSchema, runtime: RuntimeSchema }).strict()).min(1).max(ACK_LIMITS.views),
      }).strict(), req.body);
      const selected = new Set<string>();
      for (const view of body.views) {
        const key = `${view.agent}\0${view.runtime}`;
        if (selected.has(key)) throw new HttpError(422, 'An agent/runtime view is listed more than once');
        selected.add(key);
      }
      const canonical = await lifecycle(async () => {
        const state = await service.reviewedPolicy();
        const plan: Plan = { policyDigest: state.policy.digest, views: [], packages: new Map() };
        for (const runtime of new Set(body.views.map(view => view.runtime))) {
          const agents = body.views.filter(view => view.runtime === runtime).map(view => view.agent);
          const group = planViews(state.catalog, state.policy, state.roster, { agents, runtime });
          plan.views.push(...group.views);
          for (const [digest, source] of group.packages) plan.packages.set(digest, source);
        }
        validatePlanCapacity(plan);
        return plan;
      });
      const fingerprint = planFingerprint(canonical);
      if (body.policyDigest !== canonical.policyDigest || body.fingerprint !== fingerprint) throw new HttpError(409, 'The requested plan does not match the current reviewed policy and packages; refresh it before deploying.');
      res.json({ policyDigest: canonical.policyDigest, fingerprint });
    }));
  return router;
}

export function serviceFor(vaultRoot: string): SkillsService {
  return new SkillsService(vaultRoot, settings(vaultRoot).skills);
}

export const routes: FeatureRoutes = ({ vaultRoot }) => {
  const service = serviceFor(vaultRoot);
  return [
    { path: '/api/skills/ack', router: ackRouter(), mount: 'raw' },
    { path: '/api/skills/authorize', router: authorizeRouter(service), mount: 'raw' },
    { path: '/api/skills', router: skillsRouter(service) },
  ];
};
