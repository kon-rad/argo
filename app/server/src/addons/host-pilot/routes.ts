import { Router, raw, type ErrorRequestHandler, type Request } from 'express';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { readMediaObject } from '../../hosts/artifact-objects.js';
import { artifactMaxBytes, artifactRef } from '@secondbrain/contracts/hosts';
import { storeInput, storeOutput, resultContent, leasedInputContent } from '../../hosts/artifacts.js';
import { pool } from '../../db.js';
import type { FeatureRoutes } from '../../features/types.js';
import { HostRegistryStore } from '../../hosts/registry.js';
import { readHostRegistry } from '../../hosts/config.js';
import { hostCommandStatus, HostService, HostServiceError, revokeHost } from '../../hosts/service.js';
import { HttpError, parseOr400 } from '../../routes/http.js';

const machineInput = z.strictObject({ machine: z.string().min(1).max(128) });
const enrollment = z.strictObject({ code: z.string().min(1).max(256) });
const mapError: ErrorRequestHandler = (error, _req, _res, next) => {
  next(error instanceof HostServiceError ? new HttpError(error.status, error.message) : error);
};

export const routes: FeatureRoutes = ({ vaultRoot, sessionGate }) => {
  const store = new HostRegistryStore(pool);
  function current<T>(action: (service: HostService, db: PoolClient) => Promise<T>) {
    return store.withActive((registry, db) => action(new HostService(pool, registry, db), db));
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
  const binary = raw({ type: 'application/octet-stream', limit: artifactMaxBytes, inflate: false });
  function hostToken(req: Request) {
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.get('authorization') ?? '')?.[1];
    if (!token) throw new HttpError(401, 'Host token required');
    return token;
  }
  function upload(req: Request) {
    const digest = req.get('x-content-sha256') ?? '';
    if (!Buffer.isBuffer(req.body) || !/^[a-f0-9]{64}$/.test(digest)) throw new HttpError(400, 'Expected binary content and SHA-256 header');
    return { data: req.body, digest };
  }
  function fence(req: Request) {
    return parseOr400(z.object({ attempt: z.uuid(), generation: z.coerce.number().int().positive().max(2147483647) }), req.params);
  }
  host.get('/transfers/:attempt/:generation/input', async (req, res) => {
    const token = hostToken(req);
    const { attempt, generation } = fence(req);
    const data = await current(async (service, db) => {
      const machine = await service.authenticate(token);
      await service.checkTransferPermission(machine, attempt, generation);
      return leasedInputContent(db, machine, attempt, generation);
    });
    res.set('Cache-Control', 'no-store').set('X-Content-Type-Options', 'nosniff').attachment('artifact.bin').type('application/octet-stream').send(data);
  });
  host.put('/transfers/:attempt/:generation/output', async (req, _res, next) => {
    const token = hostToken(req);
    await current(service => service.authenticate(token));
    next();
  }, binary, async (req, res) => {
    const token = hostToken(req);
    const { attempt, generation } = fence(req);
    const { data, digest } = upload(req);
    const output = await current(async (service, db) => storeOutput(db, await service.authenticate(token), attempt, generation, data, digest));
    res.set('Cache-Control', 'no-store').json(output);
  });
  for (const action of ['poll', 'start', 'finish'] as const) {
    host.post('/' + action, async (req, res) => {
      const token = hostToken(req);
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
  owner.post('/artifacts/import', async (req, res) => {
    const input = parseOr400(artifactRef, req.body);
    const data = await readMediaObject(input);
    res.set('Cache-Control', 'no-store').json(await storeInput(pool, data, input.sha256));
  });
  owner.post('/artifacts', binary, async (req, res) => {
    const { data, digest } = upload(req);
    res.set('Cache-Control', 'no-store').json(await storeInput(pool, data, digest));
  });
  owner.get('/requests/:id/output', async (req, res) => {
    res.set('Cache-Control', 'no-store').type('application/octet-stream').send(await resultContent(pool, req.params.id));
  });
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
    await revokeHost(pool, machine);
    res.sendStatus(204);
  });
  owner.post('/requests', async (req, res) => { res.json(await current(service => service.submit(req.body))); });
  owner.get('/requests/:id', async (req, res) => { res.json(await hostCommandStatus(pool, req.params.id)); });
  owner.use(mapError);
  return [
    { path: '/api/host-pilot', router: host, mount: 'public' },
    { path: '/api/host-pilot', router: owner, mount: 'session' },
  ];
};
