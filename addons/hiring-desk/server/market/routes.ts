import { Router, json, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import { verifySignedEnvelope } from './envelope.js';
import { CybaError, paymentTerms, publicJob, type CybaJob, type CybaProfile, type CybaStore } from './types.js';
export interface MarketActions {
    ensureCard(job: CybaJob): Promise<void>;
    approve(job: CybaJob): Promise<void>;
    stage(job: CybaJob, artifactRef: string, summary: string): Promise<void>;
    release(job: CybaJob, sha256: string, summary: string): Promise<void>;
    pay(job: CybaJob, txHash: string): Promise<void>;
    cancel(job: CybaJob): Promise<void>;
    reconcileDelivery?(job: CybaJob, reference: string): Promise<void>;
}
export interface MarketControls {
    store: CybaStore;
    envelopeSecret: string;
    actions: MarketActions;
    verifiedProfiles(): Promise<CybaProfile[]>;
    artifactBytes?(job: CybaJob): Promise<Uint8Array>;
}
const createBody = z.object({ providerId: z.string().min(1).max(100), title: z.string().trim().min(1).max(200), brief: z.string().trim().min(1).max(10000), requestKey: z.string().regex(/^[A-Za-z0-9._:-]{8,200}$/) }).strict();
const txBody = z.object({ txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).strict();
const stageBody = z.object({ artifactRef: z.string().min(1).max(2000), summary: z.string().trim().min(1).max(4000) }).strict();
const releaseBody = z.object({ artifactSha256: z.string().regex(/^[0-9a-f]{64}$/), summary: z.string().trim().min(1).max(4000) }).strict();
const reconcileBody = z.object({ reference: z.string().regex(/^swarm:\/\/[0-9a-f]{64}$/) }).strict();
function body<T>(schema: z.ZodType<T>, req: Request): T { const parsed = schema.safeParse(req.body); if (!parsed.success)
    throw new CybaError(400, 'Invalid market request.'); return parsed.data; }
function wrap(fn: (req: Request, res: import('express').Response) => Promise<unknown>): RequestHandler { return (req, res, next) => { Promise.resolve(fn(req, res)).catch(next); }; }
function protect(router: Router): void {
    router.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); if (req.method !== 'GET' && req.method !== 'POST') {
        res.status(405).json({ error: { code: 'method', message: 'Method not allowed.' } });
        return;
    } next(); });
    router.use(json({ limit: '24kb', strict: true, verify: (req, _res, buffer) => { (req as Request & {
            cybaRawBody?: string;
        }).cybaRawBody = buffer.toString('utf8'); } }));
    const limits = new Map<string, {
        count: number;
        until: number;
    }>();
    router.use((req, res, next) => { const now = Date.now(); if (limits.size > 10000)
        for (const [k, v] of limits)
            if (v.until <= now)
                limits.delete(k); const key = req.ip ?? 'unknown'; if (limits.size > 10000 && !limits.has(key)) {
        res.status(429).end();
        return;
    } let l = limits.get(key); if (!l || l.until <= now) {
        l = { count: 0, until: now + 60000 };
        limits.set(key, l);
    } if (++l.count > 120) {
        res.status(429).json({ error: { code: 'rate-limit', message: 'Please retry later.' } });
        return;
    } next(); });
}
function errors(router: Router): void {
    router.use((error: unknown, _req: Request, res: import('express').Response, _next: import('express').NextFunction) => { const status = error instanceof CybaError ? error.status : [400, 413].includes((error as {
        status?: number;
    })?.status ?? 0) ? (error as {
        status: number;
    }).status : 503; res.status(status).json({ error: { code: status === 503 ? 'unavailable' : status === 409 ? 'conflict' : status === 401 ? 'unauthorized' : status === 404 ? 'not-found' : 'invalid', message: error instanceof CybaError ? error.message : 'Marketplace operation is unavailable.' } }); });
    router.use((_req, res) => res.status(404).json({ error: { code: 'not-found', message: 'Market endpoint not found.' } }));
}
export function marketRouter(controls: MarketControls): Router {
    const router = Router();
    protect(router);
    router.get('/agents', wrap(async (_req, res) => res.json({ agents: await controls.verifiedProfiles() })));
    router.use((req, res, next) => {
        const wallet = req.get('x-cyba-wallet') ?? '', timestamp = Number(req.get('x-cyba-timestamp')), signature = req.get('x-cyba-signature') ?? '';
        const raw = (req as Request & {
            cybaRawBody?: string;
        }).cybaRawBody ?? (req.method === 'GET' ? '' : JSON.stringify(req.body ?? {}));
        if (!verifySignedEnvelope({ method: req.method, path: req.originalUrl, body: raw, wallet, timestamp }, signature, controls.envelopeSecret)) {
            res.status(401).json({ error: { code: 'unauthorized', message: 'Authenticated market envelope required.' } });
            return;
        }
        res.locals.cybaWallet = wallet.toLowerCase();
        next();
    });
    const project = async (j: CybaJob) => ({ ...publicJob(j), ...(j.status === 'paid' ? { evidenceRefs: await controls.store.confirmedPublications(j.id) } : {}) });
    const owned = async (req: Request, wallet: string): Promise<CybaJob> => { const j = await controls.store.getJob(String(req.params.id)); if (!j || j.clientWallet !== wallet)
        throw new CybaError(404, 'Job not found.'); return j; };
    router.get('/jobs', wrap(async (_req, res) => res.json({ jobs: await Promise.all((await controls.store.listJobs(res.locals.cybaWallet as string)).map(project)) })));
    router.post('/jobs', wrap(async (req, res) => { const input = body(createBody, req); const profiles = await controls.verifiedProfiles(); if (!profiles.some(p => p.id === input.providerId))
        throw new CybaError(503, 'Provider identity is unavailable.'); let j = await controls.store.createJob(res.locals.cybaWallet as string, input); await controls.actions.ensureCard(j); j = (await controls.store.getJob(j.id))!; res.status(201).json({ job: await project(j) }); }));
    router.get('/jobs/:id', wrap(async (req, res) => res.json({ job: await project(await owned(req, res.locals.cybaWallet as string)) })));
    router.get('/jobs/:id/payment-terms', wrap(async (req, res) => { const j = await owned(req, res.locals.cybaWallet as string); if (!['released', 'paid'].includes(j.status))
        throw new CybaError(409, 'Result has not been released.'); res.json({ terms: paymentTerms(j), job: await project(j) }); }));
    router.post('/jobs/:id/payment', wrap(async (req, res) => { const j = await owned(req, res.locals.cybaWallet as string); await controls.actions.pay(j, body(txBody, req).txHash); const updated = (await controls.store.getJob(j.id))!; res.status(updated.status === 'paid' ? 200 : 202).json({ job: await project(updated) }); }));
    errors(router);
    return router;
}
/** Owner gate is mandatory and runs before any private row is read. */
export function marketOperatorRouter(controls: MarketControls, ownerGate: RequestHandler): Router {
    const router = Router();
    router.use(ownerGate);
    protect(router);
    const get = async (req: Request): Promise<CybaJob> => { const j = await controls.store.getJob(String(req.params.id)); if (!j)
        throw new CybaError(404, 'Job not found.'); return j; };
    router.get('/jobs', wrap(async (_req, res) => res.json({ jobs: await controls.store.listJobs() })));
    router.get('/jobs/:id', wrap(async (req, res) => res.json({ job: await get(req) })));
    router.get('/jobs/:id/artifact', wrap(async (req, res) => { const j = await get(req); if (!controls.artifactBytes || !j.artifactPath || !j.artifactSha256)
        throw new CybaError(404, 'Reviewed artifact not found.'); if (req.query.hash !== undefined && req.query.hash !== j.artifactSha256)
        throw new CybaError(409, 'Reviewed artifact changed; refresh the review.'); const bytes = await controls.artifactBytes(j); res.setHeader('Content-Type', 'video/mp4'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Disposition', 'inline'); res.send(Buffer.from(bytes)); }));
    router.post('/jobs/:id/approve', wrap(async (req, res) => { const j = await get(req); await controls.actions.approve(j); res.json({ job: await controls.store.getJob(j.id) }); }));
    router.post('/jobs/:id/stage', wrap(async (req, res) => { const j = await get(req), input = body(stageBody, req); await controls.actions.stage(j, input.artifactRef, input.summary); res.json({ job: await controls.store.getJob(j.id) }); }));
    router.post('/jobs/:id/release', wrap(async (req, res) => { const j = await get(req); const reviewed = body(releaseBody, req); await controls.actions.release(j, reviewed.artifactSha256, reviewed.summary); res.json({ job: await controls.store.getJob(j.id) }); }));
    router.post('/jobs/:id/cancel', wrap(async (req, res) => { const j = await get(req); await controls.actions.cancel(j); res.json({ job: await controls.store.getJob(j.id) }); }));
    router.post('/jobs/:id/reconcile-delivery', wrap(async (req, res) => { const j = await get(req); if (!controls.actions.reconcileDelivery)
        throw new CybaError(503, 'Delivery reconciliation unavailable.'); await controls.actions.reconcileDelivery(j, body(reconcileBody, req).reference); res.json({ job: await controls.store.getJob(j.id) }); }));
    errors(router);
    return router;
}
