import type { ProviderWalletApi } from '@secondbrain/desk-contracts/desk';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { Approval as DeskApproval, DeskOperatorApi, Mutation as DeskMutation, ReleaseRequest } from '@secondbrain/desk-contracts/desk';
import { parseOr400, wrap } from '../../http.js';

const Id = z.string().min(1).max(300);
const Mutation = z.object({ idempotencyKey: z.string().trim().min(1).max(200), expectedRevision: z.number().int().nonnegative() });
const Approval = Mutation.extend({ acceptanceDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/), skillVersion: z.string().min(1).max(200), corpusDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/), inputRefs: z.array(z.string().min(1).max(1000)).min(1).max(32), audience: z.string().min(1).max(200), expiresAt: z.number().int().positive(), limits: z.object({ tools: z.array(z.string().min(1).max(100)).max(32), model: z.string().min(1).max(100), maxCostAtomic: z.string().regex(/^(0|[1-9][0-9]*)$/), costAsset: z.string().min(1).max(100), maxRuntimeSeconds: z.number().int().positive(), maxOutputTokens: z.number().int().positive() }), planDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/) });
const Release = Mutation.extend({ artifactHash: z.string().regex(/^sha256:[0-9a-f]{64}$/), mediaType: z.string().min(1).max(100), publicDestination: z.string().min(1).max(500) });
const Dispatch = Mutation.extend({ corpusDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/), inputRefs: z.array(z.string().min(1).max(1000)).min(1).max(32), planDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/), audience: z.string().min(1).max(200), limits: Approval.shape.limits });
const TxHash = z.object({ txHash: z.string().min(1).max(200) });
export interface DeskPrivateControls extends DeskOperatorApi, Partial<ProviderWalletApi> {
  publishRecord?(record: unknown, idempotencyKey: string): Promise<import('@secondbrain/desk-contracts/desk').Result<import('@secondbrain/desk-contracts/desk').Confirmation>>;
  dispatch(id: string, request: DeskMutation, corpusDigest: string, inputRefs: readonly string[], planDigest: string, limits: DeskApproval['limits'], audience: string): Promise<import('@secondbrain/desk-contracts/desk').Result<{ attemptId: string; claimTransaction: unknown }>>;
  reconcileClaim(id: string): Promise<import('@secondbrain/desk-contracts/desk').Result<import('@secondbrain/desk-contracts/desk').OperatorJob>>;
  reconcileRunner(id: string): Promise<import('@secondbrain/desk-contracts/desk').Result<import('@secondbrain/desk-contracts/desk').OperatorJob>>;
  reconcilePayment(id: string, txHash: string): Promise<import('@secondbrain/desk-contracts/desk').Result<import('@secondbrain/desk-contracts/desk').OperatorJob>>;
}
const statusFor = (kind: string): number => kind === 'ok' ? 200 : kind === 'invalid-input' ? 400 : kind === 'denied' ? 403 : kind === 'pending' ? 202 : kind === 'unavailable' ? 503 : 502;
function send(res: import('express').Response, result: { kind: string; value?: unknown; message?: string }): void {
  if (result.kind === 'ok') { res.json({ value: result.value }); return; }
  res.status(statusFor(result.kind)).json({ error: { code: result.kind, message: result.message } });
}

/** Private operator routes. Require an explicit session gate even on local installs. */
export function deskOperatorRouter(api: DeskPrivateControls, sessionGate: RequestHandler): Router {
  if (!sessionGate) throw new Error('Desk operator API requires session authentication');
  const router = Router(); router.use(sessionGate, (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/inbox', wrap(async (_req, res) => send(res, await api.inbox())));
  router.get('/jobs', wrap(async (_req, res) => send(res, await api.jobs())));
  router.get('/jobs/:id', wrap(async (req, res) => send(res, await api.job(parseOr400(Id, req.params['id'])))));
  router.get('/providers', wrap(async (_req, res) => send(res, await api.providers())));
  router.post('/publications', wrap(async (req, res) => {
    const body = parseOr400(z.object({ record: z.unknown(), idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/) }).strict(), req.body);
    send(res, api.publishRecord ? await api.publishRecord(body.record, body.idempotencyKey) : { kind: 'unavailable', message: 'Backend publication is not configured' });
  }));
  router.post('/jobs/:id/approve', wrap(async (req, res) => send(res, await api.approve(parseOr400(Id, req.params['id']), parseOr400(Approval, req.body)))));
  router.post('/jobs/:id/decline', wrap(async (req, res) => send(res, await api.decline(parseOr400(Id, req.params['id']), parseOr400(Mutation, req.body)))));
  router.post('/jobs/:id/cancel', wrap(async (req, res) => send(res, await api.cancel(parseOr400(Id, req.params['id']), parseOr400(Mutation, req.body)))));
  router.get('/jobs/:id/preview', wrap(async (req, res) => send(res, await api.preview(parseOr400(Id, req.params['id'])))));
  router.post('/jobs/:id/release', wrap(async (req, res) => send(res, await api.release(parseOr400(Id, req.params['id']), parseOr400(Release, req.body)))));
  const walletUnavailable = { kind: 'unavailable', message: 'Provider wallet transactions are not configured' };
  router.post('/jobs/:id/claim/prepare', wrap(async (req, res) => send(res, api.prepareClaim ? await api.prepareClaim(parseOr400(Id, req.params['id']), parseOr400(Mutation.strict(), req.body)) : walletUnavailable)));
  router.post('/jobs/:id/release/prepare', wrap(async (req, res) => send(res, api.prepareDelivery ? await api.prepareDelivery(parseOr400(Id, req.params['id']), parseOr400(Release.strict(), req.body)) : walletUnavailable)));
  for (const [path, action] of [['claim', 'claim'], ['release', 'delivery']] as const) {
    router.get(`/jobs/:id/${path}/intent`, wrap(async (req, res) => send(res, api.walletIntent ? await api.walletIntent(parseOr400(Id, req.params['id']), action) : walletUnavailable)));
    router.post(`/jobs/:id/${path}/submit`, wrap(async (req, res) => {
      const body = parseOr400(z.object({ intentRef: Id, txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).strict(), req.body);
      send(res, api.submitWallet ? await api.submitWallet(parseOr400(Id, req.params['id']), action, body) : walletUnavailable);
    }));
    if (action === 'delivery') router.post(`/jobs/:id/${path}/reconcile`, wrap(async (req, res) => send(res, api.reconcileWallet ? await api.reconcileWallet(parseOr400(Id, req.params['id']), action) : walletUnavailable)));
  }
  router.post('/jobs/:id/dispatch', wrap(async (req, res) => { const b = parseOr400(Dispatch, req.body); send(res, await api.dispatch(parseOr400(Id, req.params['id']), b, b.corpusDigest, b.inputRefs, b.planDigest, b.limits, b.audience)); }));
  router.post('/jobs/:id/claim/reconcile', wrap(async (req, res) => send(res, api.reconcileWallet ? await api.reconcileWallet(parseOr400(Id, req.params['id']), 'claim') : await api.reconcileClaim(parseOr400(Id, req.params['id'])))));
  router.post('/jobs/:id/runner/reconcile', wrap(async (req, res) => send(res, await api.reconcileRunner(parseOr400(Id, req.params['id'])))));
  router.post('/jobs/:id/payment/reconcile', wrap(async (req, res) => send(res, await api.reconcilePayment(parseOr400(Id, req.params['id']), parseOr400(TxHash, req.body).txHash))));
  return router;
}
