import { Router, type ErrorRequestHandler } from 'express';
import { z } from 'zod';
import { pool } from '../../db.js';
import type { FeatureRoutes } from '../../features/types.js';
import { log } from '../../logger.js';
import { readHostRegistry } from '../../hosts/config.js';
import { HostService, HostServiceError } from '../../hosts/service.js';
import { HttpError, parseOr400 } from '../../routes/http.js';

const machineInput = z.strictObject({ machine: z.string().min(1).max(128) });
const enrollment = z.strictObject({ code: z.string().min(1).max(256) });
const mapError: ErrorRequestHandler = (error, _req, _res, next) => {
  next(error instanceof HostServiceError ? new HttpError(error.status, error.message) : error);
};

export const routes: FeatureRoutes = ({ vaultRoot, sessionGate }) => {
  let service: HostService;
  try {
    service = new HostService(pool, readHostRegistry(vaultRoot));
  } catch {
    log.warn('Host pilot disabled until the private machine and command configuration is valid');
    const unavailable = Router().use((_req, res) => {
      res.status(503).json({ error: 'Host registry unavailable' });
    });
    return [{ path: '/api/host-pilot', router: unavailable, mount: 'public' }];
  }
  const host = Router();
  host.post('/enroll', async (req, res) => {
    const { code } = parseOr400(enrollment, req.body);
    res.set('Cache-Control', 'no-store').json(await service.enroll(code));
  });
  // Limit host authentication to these three routes. Owner routes share the prefix.
  for (const action of ['poll', 'start', 'finish'] as const) {
    host.post('/' + action, async (req, res) => {
      const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.get('authorization') ?? '')?.[1];
      if (!token) throw new HttpError(401, 'Host token required');
      const machine = await service.authenticate(token);
      if (action === 'poll') {
        res.set('Cache-Control', 'no-store').json({ lease: await service.poll(machine) });
        return;
      }
      await service[action](machine, req.body);
      res.sendStatus(204);
    });
  }
  host.use(mapError);

  const owner = Router();
  // An owner session is required even if the installation has local login disabled.
  owner.use(sessionGate ?? ((_req, _res, next) => next(new HttpError(403, 'Owner login required'))));
  owner.post('/enrollment-codes', async (req, res) => {
    const { machine } = parseOr400(machineInput, req.body);
    res.set('Cache-Control', 'no-store').json(await service.issueCode(machine));
  });
  owner.post('/revoke', async (req, res) => {
    const { machine } = parseOr400(machineInput, req.body);
    await service.revoke(machine);
    res.sendStatus(204);
  });
  owner.post('/requests', async (req, res) => { res.json(await service.submit(req.body)); });
  owner.get('/requests/:id', async (req, res) => { res.json(await service.status(req.params.id)); });
  owner.use(mapError);
  return [
    { path: '/api/host-pilot', router: host, mount: 'public' },
    { path: '/api/host-pilot', router: owner, mount: 'session' },
  ];
};
