import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { OrgError } from '../org-error.js';
import { HttpError, wrap, parseOr400 } from '../routes/http.js';
import { runtimeStatus, registerRuntimeTarget, requireRuntimeOwner, saveProfile, previewRuntime, applyRuntime, revertRuntime, TargetSchema } from './index.js';

/** Mounted behind the org feature's existing owner session gate. Request bodies never supply identity. */
export function runtimeRouter(): Router {
  const router = Router();
  router.use(wrap(async () => {
    try { await requireRuntimeOwner(config.orgOwner); }
    catch (e) { if (e instanceof OrgError) throw new HttpError(403,e.message); throw e; }
  }, true));
  const run = async <T>(fn: () => Promise<T>) => {
    try { return await fn(); } catch (e) { if (e instanceof OrgError || e instanceof z.ZodError) throw new HttpError(400,e.message); throw e; }
  };
  router.get('/',wrap(async (_req,res) => { res.json(await runtimeStatus()); }));
  router.get('/profiles',wrap(async (_req,res) => { res.json((await runtimeStatus()).profiles); }));
  router.get('/history',wrap(async (_req,res) => { res.json((await runtimeStatus()).history); }));
  router.post('/profiles/:id',wrap(async (req,res) => { res.json(await run(() => saveProfile(String(req.params.id),req.body,config.orgOwner))); }));
  router.post('/targets',wrap(async (req,res) => {
    const body = parseOr400(z.object({target:TargetSchema,configured:z.unknown()}).strict(),req.body);
    res.json(await run(() => registerRuntimeTarget(body.target,body.configured,config.orgOwner)));
  }));
  router.post('/preview',wrap(async (req,res) => {
    const body = parseOr400(z.object({profileId:z.string(),scope:z.array(TargetSchema).default([])}).strict(),req.body);
    res.json(await run(() => previewRuntime(body.profileId,body.scope,config.orgOwner)));
  }));
  router.post('/apply',wrap(async (req,res) => {
    const body = parseOr400(z.object({token:z.string().uuid()}).strict(),req.body);
    res.json(await run(() => applyRuntime(body.token,config.orgOwner)));
  }));
  router.post('/revert',wrap(async (req,res) => {
    const body = parseOr400(z.object({version:z.number().int().positive()}).strict(),req.body);
    res.json(await run(() => revertRuntime(body.version,config.orgOwner)));
  }));
  return router;
}
