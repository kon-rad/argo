import { Router } from 'express';
import { z } from 'zod';
import { parseRecord, type DeskIdentity, type DeskPublicStore, type DeskSettlement, type PaymentIntent } from '@secondbrain/desk-contracts/desk';
import type { FeatureRoutes } from '../../features/types.js';
import { HttpError, parseOr400, wrap } from '../../routes/http.js';
import { deskOperatorRouter, type DeskPrivateControls } from './operator/routes.js';

export interface DeskPublicControls {
  store: DeskPublicStore;
  identity?: DeskIdentity;
  settlement?: DeskSettlement;
}

function controls(app: { locals: Record<string, unknown> }): DeskPublicControls {
  const value = app.locals.deskPublic as DeskPublicControls | undefined;
  if (!value) throw new HttpError(503, 'Hiring desk is not configured');
  return value;
}

function result(res: import('express').Response, value: { kind: string; value?: unknown; message?: string }): void {
  if (value.kind === 'ok') { res.json({ value: value.value }); return; }
  const status = value.kind === 'invalid-input' ? 400 : value.kind === 'denied' ? 403 : value.kind === 'pending' ? 202 : 503;
  res.status(status).json({ error: { code: value.kind, message: value.message } });
}

export const publicDeskRouter = (app: { locals: Record<string, unknown> }): Router => {
  const router = Router();
  router.get('/discover', wrap(async (_req, res) => {
    const c = controls(app);
    result(res, { kind: 'ok', value: { version: 'desk/v1', mode: c.store.mode, providers: [] } });
  }));
  router.get('/jobs', wrap(async (_req, res) => result(res, await controls(app).store.listJobs())));
  router.get('/jobs/:ref', wrap(async (req, res) => result(res, await controls(app).store.get(parseOr400(z.string().min(1).max(500), req.params.ref)))));
  router.get('/read/:ref', wrap(async (req, res) => result(res, await controls(app).store.get(parseOr400(z.string().min(1).max(500), req.params.ref)))));
  router.post('/jobs', wrap(async (req, res) => {
    const c = controls(app); const record = parseRecord(req.body?.record ?? req.body); if (record.type !== 'job') throw new HttpError(400, 'Expected a job record');
    result(res, await c.store.publish(record, String(req.body?.idempotencyKey ?? '')));
  }));
  router.post('/acceptances', wrap(async (req, res) => {
    const c = controls(app); const record = parseRecord(req.body?.record ?? req.body); if (record.type !== 'acceptance') throw new HttpError(400, 'Expected an acceptance record');
    result(res, await c.store.publish(record, String(req.body?.idempotencyKey ?? '')));
  }));
  router.get('/jobs/:ref/offers', (_req, res) => res.json({ value: [] }));
  router.post('/payments/prepare', wrap(async (req, res) => {
    const c = controls(app); if (!c.settlement) throw new HttpError(503, 'Settlement is not configured');
    result(res, await c.settlement.prepare(req.body as PaymentIntent));
  }));
  return router;
};

export const routes: FeatureRoutes = ({ app, sessionGate }) => {
  const result: ReturnType<FeatureRoutes> = [{ path: '/public', router: publicDeskRouter(app), mount: 'public' }];
  const operator = app.locals.deskOperator as DeskPrivateControls | undefined;
  if (operator && sessionGate) {
    result.push({ path: '/api/desk', router: deskOperatorRouter(operator, sessionGate), mount: 'session' });
  } else {
    const unavailable = Router();
    unavailable.use((_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.status(503).json({ error: { code: 'unavailable', message: 'Hiring desk operator service is not configured' } });
    });
    result.push({ path: '/api/desk', router: unavailable, mount: 'session' });
  }
  return result;
};
