import { Router, type ErrorRequestHandler } from 'express';
import { z } from 'zod';
import { pool } from '../../db.js';
import type { FeatureRoutes } from '../../features/types.js';
import { HostRegistryStore } from '../../hosts/registry.js';
import { readHostRegistry } from '../../hosts/config.js';
import { HostService, HostServiceError } from '../../hosts/service.js';
import { HttpError, parseOr400 } from '../../routes/http.js';

const machineInput = z.strictObject({ machine: z.string().min(1).max(128) });
const enrollment = z.strictObject({ code: z.string().min(1).max(256) });
const mapError: ErrorRequestHandler = (error, _req, _res, next) => {
  next(error instanceof HostServiceError ? new HttpError(error.status, error.message) : error);
};

export const routes: FeatureRoutes = ({ vaultRoot, sessionGate }) => {
  const store = new HostRegistryStore(pool);
  function current<T>(action: (service: HostService) => Promise<T>) {
    return store.withActive((registry, db) => action(new HostService(pool, registry, db)));
  }
  function candidate() {
    try {
      return readHostRegistry(vaultRoot);
    } catch {
      throw new HttpError(400, 'Invalid private host registry. Check the machine and command YAML files.');
    }
  }
  const host = Router();
  host.post('/enroll', async (req, res) => {
    const { code } = parseOr400(enrollment, req.body);
    res.set('Cache-Control', 'no-store').json(await current(service => service.enroll(code)));
  });
  // Limit host authentication to these three routes. Owner routes share the prefix.
  for (const action of ['poll', 'start', 'finish'] as const) {
    host.post('/' + action, async (req, res) => {
      const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.get('authorization') ?? '')?.[1];
      if (!token) throw new HttpError(401, 'Host token required');
      const response = await current(async service => {
        const machine = await service.authenticate(token);
        if (action === 'poll') return { lease: await service.poll(machine) };
        if (action === 'start') return service.start(machine, req.body);
        await service.finish(machine, req.body);
        return 'finished' as const;
      });
      if (typeof response === 'object') res.set('Cache-Control', 'no-store').json(response);
      else if (response === 'policy-denied') res.sendStatus(412);
      else res.sendStatus(204);
    });
  }
  host.use(mapError);

  const owner = Router();
  // An owner session is required even if the installation has local login disabled.
  owner.use(sessionGate ?? ((_req, _res, next) => next(new HttpError(403, 'Owner login required'))));
  owner.post('/registry/preview', async (_req, res) => {
    res.set('Cache-Control', 'no-store').json(await store.preview(candidate()));
  });
  owner.post('/registry/apply', async (req, res) => {
    const revision = z.string().regex(/^[a-f0-9]{64}$/);
    const input = parseOr400(z.strictObject({ baseRevision: revision.nullable(), revision }), req.body);
    res.json(await store.apply(candidate(), input.baseRevision, input.revision));
  });
  owner.post('/enrollment-codes', async (req, res) => {
    const { machine } = parseOr400(machineInput, req.body);
    res.set('Cache-Control', 'no-store').json(await current(service => service.issueCode(machine)));
  });
  owner.post('/revoke', async (req, res) => {
    const { machine } = parseOr400(machineInput, req.body);
    await current(service => service.revoke(machine));
    res.sendStatus(204);
  });
  owner.post('/requests', async (req, res) => { res.json(await current(service => service.submit(req.body))); });
  owner.get('/requests/:id', async (req, res) => { res.json(await current(service => service.status(req.params.id))); });
  owner.use(mapError);
  return [
    { path: '/api/host-pilot', router: host, mount: 'public' },
    { path: '/api/host-pilot', router: owner, mount: 'session' },
  ];
};
