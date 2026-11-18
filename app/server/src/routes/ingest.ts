import express, { Router, type Request } from 'express';
import { BatchError, batchSchema, ingestBatch } from '../ingest/batch.js';
import { findDevice } from '../ingest/devices.js';
import type { WireBatch } from '../ledger/types.js';
import { HttpError, wrap } from './http.js';

/**
 * POST /api/ingest/batch: a machine's agent ledger posts its rows here (gzip JSON,
 * bearer device token). Mounted before the session gate, like the kiosk feed: the
 * token is the only credential, and it decides the host. 422 means "this batch is
 * malformed, split it"; 401 "this token is not live"; anything else is retried.
 */
export function ingestRouter(): Router {
  const router = Router();
  router.post(
    '/batch',
    // The token first: nobody without one gets a 64 MB (decompressed) body parsed.
    wrap(async (req, res) => {
      const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
      const device = m ? await findDevice(m[1]!) : null;
      if (!device) throw new HttpError(401, 'bad, revoked or missing device token');
      res.locals.device = device;
    }, true),
    express.json({ limit: '64mb' }),
    wrap(async (req: Request, res) => {
      const device = res.locals.device as { id: number; host: string };
      const parsed = batchSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(422, `invalid batch: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
      }
      try {
        res.json(await ingestBatch(device, parsed.data as WireBatch));
      } catch (err) {
        if (err instanceof BatchError) throw new HttpError(422, err.message);
        // Postgres data exceptions (22xxx) and constraint violations (23xxx) are about the rows, not the server.
        const code = (err as { code?: unknown })?.code;
        if (typeof code === 'string' && /^2[23]/.test(code)) throw new HttpError(422, `rejected by the database (SQLSTATE ${code})`);
        throw err;
      }
    }),
  );
  return router;
}
