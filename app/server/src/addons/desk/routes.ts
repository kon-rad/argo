import { json, Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { isEntityRef, parseRecord, type DeskRecord } from '@secondbrain/desk-contracts/desk';
import type { FeatureRoutes } from '../../features/types.js';
import { HttpError, parseOr400, wrap } from '../../routes/http.js';
import { deskOperatorRouter, type DeskPrivateControls } from './operator/routes.js';
import { paymentContext, paymentStatus, publicObservation, snapshot, PublicDeskError, type DeskPublicControls } from './public-api.js';
export type { DeskPublicControls } from './public-api.js';
const reference = z.string().min(1).max(500).refine(isEntityRef);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const hashBody = z.object({ txHash: hash }).strict();
const refBody = z.object({ jobRef: reference }).strict();
const paymentBody = z.object({ jobRef: reference, txHash: hash }).strict();
const publication = z.object({ record: z.unknown(), idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/) }).strict();
function controls(app: { locals: Record<string, unknown> }): DeskPublicControls {
  const value = app.locals.deskPublic as DeskPublicControls | undefined;
  if (!value) throw new PublicDeskError(503, 'unavailable', 'Hiring Desk is not configured.');
  return value;
}
function result(res: Response, value: { kind: string; value?: unknown }): void {
  if (value.kind === 'ok') { res.json({ value: value.value }); return; }
  const status = value.kind === 'invalid-input' ? 400 : value.kind === 'denied' ? 403 : value.kind === 'pending' ? 202 : 503;
  res.status(status).json({ state: value.kind === 'pending' ? 'pending' : 'unavailable', error: { code: value.kind, message: 'Public desk operation could not be completed.' } });
}
/** No private router or generic vault API is mounted below this boundary. */
export const publicDeskRouter = (app: { locals: Record<string, unknown> }): Router => {
  const router = Router();
  router.use(json({ limit: '16kb', strict: true }));
  const limits = new Map<string, { count: number; reset: number }>();
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Vary', 'Origin');
    const origin = req.get('Origin'), allowed = (app.locals.deskPublic as DeskPublicControls | undefined)?.publicOrigin;
    if (origin && (!allowed || origin !== allowed)) { res.status(403).json({ state: 'unavailable', message: 'Origin is not allowed.' }); return; }
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); res.status(204).end(); return; }
    const now = Date.now(), key = `${req.ip}:${req.method === 'GET' ? 'read' : 'write'}`;
    if (limits.size > 10_000) for (const [entry, value] of limits) if (value.reset <= now) limits.delete(entry);
    if (limits.size > 10_000 && !limits.has(key)) { res.status(429).json({ state: 'unavailable', message: 'Please retry later.' }); return; }
    let limit = limits.get(key);
    if (!limit || limit.reset <= now) { limit = { count: 0, reset: now + 60_000 }; limits.set(key, limit); }
    if (++limit.count > (req.method === 'GET' ? 120 : 30)) { res.setHeader('Retry-After', '60'); res.status(429).json({ state: 'unavailable', message: 'Please retry later.' }); return; }
    if (Number(req.get('Content-Length') ?? '0') > 16_384 || (req.body !== undefined && Buffer.byteLength(JSON.stringify(req.body)) > 16_384)) { res.status(413).json({ state: 'unavailable', message: 'Payload is too large.' }); return; }
    next();
  });
  router.get('/discover', wrap(async (_req, res) => result(res, { kind: 'ok', value: { version: 'desk/v1', mode: controls(app).store.mode, providers: [] } })));
  router.get('/jobs', wrap(async (_req, res) => {
    const listing = await controls(app).store.listJobs();
    if (listing.kind !== 'ok') { result(res, listing); return; }
    result(res, { kind: 'ok', value: listing.value.filter(value => (value.record as { type?: unknown })?.type === 'job').map(publicObservation) });
  }));
  router.get('/jobs/:ref', wrap(async (req, res) => {
    const read = await snapshot(controls(app), parseOr400(reference, req.params.ref)); result(res, { kind: 'ok', value: read.state });
  }));
  router.get('/jobs/:ref/offers', wrap(async (req, res) => {
    const ref = parseOr400(reference, req.params.ref), read = await snapshot(controls(app), ref);
    result(res, { kind: 'ok', value: read.observations.filter(value => { const record = value.record as DeskRecord; return record.type === 'offer' && record.jobRef === ref && !read.state.rejected.some(rejected => rejected.ref === value.ref); }) });
  }));
  router.get('/jobs/:ref/payment', wrap(async (req, res) => { const outcome = await paymentStatus(controls(app), parseOr400(reference, req.params.ref)); res.status(outcome.status).json(outcome.body); }));
  for (const type of ['job', 'acceptance'] as const) router.post(type === 'job' ? '/jobs' : '/acceptances', wrap(async (req, res) => {
    const body = parseOr400(publication, req.body); let record: DeskRecord;
    try { record = parseRecord(body.record); } catch { throw new HttpError(400, 'Invalid desk/v1 public record.'); }
    if (record.type !== type) throw new HttpError(400, `Expected a ${type} record.`);
    result(res, await controls(app).store.publish(record, body.idempotencyKey));
  }));
  router.post('/payments/prepare', wrap(async (req, res) => {
    const context = await paymentContext(controls(app), parseOr400(refBody, req.body).jobRef);
    if ('response' in context) { res.status(409).json(context.response); return; }
    res.json({ state: 'payable', terms: context.terms, value: context.prepared });
  }));
  for (const operation of ['verify', 'reconcile']) {
    router.post(`/jobs/:ref/payments/${operation}`, wrap(async (req, res) => {
      const body = parseOr400(hashBody, req.body), outcome = await paymentStatus(controls(app), parseOr400(reference, req.params.ref), body.txHash); res.status(outcome.status).json(outcome.body);
    }));
    router.post(`/payments/${operation}`, wrap(async (req, res) => {
      const body = parseOr400(paymentBody, req.body), outcome = await paymentStatus(controls(app), body.jobRef, body.txHash); res.status(outcome.status).json(outcome.body);
    }));
  }
  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (error instanceof PublicDeskError) { res.status(error.status).json({ state: error.state, message: error.message }); return; }
    if (error instanceof HttpError) { res.status(error.status).json({ state: 'failed', message: 'Invalid public desk request.' }); return; }
    if ((error as { status?: number })?.status === 413 || (error as { status?: number })?.status === 400) { res.status((error as { status: number }).status).json({ state: 'failed', message: 'Invalid public desk payload.' }); return; }
    if (error) { res.status(503).json({ state: 'unavailable', message: 'Hiring Desk is temporarily unavailable.' }); return; }
    next();
  });
  router.use((_req, res) => { res.status(404).json({ state: 'unavailable', message: 'Public desk endpoint was not found.' }); });
  return router;
};
export const routes: FeatureRoutes = ({ app, sessionGate, opts }) => {
  if (opts.desk) { app.locals.deskPublic = opts.desk.public; app.locals.deskOperator = opts.desk.operator; }
  const mounted: ReturnType<FeatureRoutes> = [{ path: '/api/desk/public', router: publicDeskRouter(app), mount: 'raw' }];
  const operator = app.locals.deskOperator as DeskPrivateControls | undefined;
  if (operator && sessionGate) mounted.push({ path: '/api/desk', router: deskOperatorRouter(operator, sessionGate), mount: 'session' });
  return mounted;
};
