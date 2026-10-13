import { Router } from 'express';
import { z } from 'zod';
import type { ConnectorRegistry } from '../connectors/index.js';
import { query } from '../db.js';
import { invalidateEmbeddingProvider, loadEmbeddingConfig } from '../embeddings/factory.js';
import * as queue from '../queue.js';
import { createRun, runConnector, type SourceRow } from '../runner.js';
import { HttpError, intParam, parseOr400, wrap } from './http.js';

const PatchBody = z
  .object({
    config: z.record(z.string(), z.unknown()).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

interface SourceListRow extends SourceRow {
  created_at: string;
  last_run: unknown;
}

async function getSource(id: number): Promise<SourceRow> {
  const { rows } = await query<SourceRow>(
    `SELECT id, kind, name, config, enabled FROM sources WHERE id = $1`,
    [id],
  );
  if (!rows[0]) throw new HttpError(404, `no source ${id}`);
  return rows[0];
}

export function sourcesRouter(connectors: ConnectorRegistry): Router {
  const router = Router();

  router.get(
    '/',
    wrap(async (_req, res) => {
      const { rows } = await query<SourceListRow>(
        `SELECT s.id, s.kind, s.name, s.config, s.enabled, s.created_at,
                to_jsonb(r) AS last_run
         FROM sources s
         LEFT JOIN LATERAL (
           SELECT id, source_id, status, started_at, finished_at, stats, progress, error
           FROM ingest_runs WHERE source_id = s.id
           ORDER BY started_at DESC, id DESC LIMIT 1
         ) r ON true
         ORDER BY s.id`,
      );
      const activeIds = new Set(queue.activeSourceIds());
      res.json({
        sources: rows.map((s) => ({ ...s, running: activeIds.has(s.id) })),
      });
    }),
  );

  router.patch(
    '/:id',
    wrap(async (req, res) => {
      const id = intParam(req.params.id, 'source id');
      const body = parseOr400(PatchBody, req.body);
      await getSource(id);

      const { rows } = await query<SourceRow>(
        `UPDATE sources
         SET config  = coalesce($2::jsonb, config),
             enabled = coalesce($3::boolean, enabled)
         WHERE id = $1
         RETURNING id, kind, name, config, enabled, created_at`,
        [id, body.config ? JSON.stringify(body.config) : null, body.enabled ?? null],
      );
      // The provider is cached off this config; a model or provider change has
      // to reach the next search, not the next restart.
      if (rows[0]?.kind === 'embeddings') {
        invalidateEmbeddingProvider();
        await loadEmbeddingConfig().catch(() => {});
      }
      res.json({ source: rows[0] });
    }),
  );

  router.post(
    '/:id/sync',
    wrap(async (req, res) => {
      const id = intParam(req.params.id, 'source id');
      const source = await getSource(id);
      if (!source.enabled) throw new HttpError(409, `source ${id} is disabled`);

      const connector = connectors[source.kind];
      if (!connector) throw new HttpError(400, `no connector for kind '${source.kind}'`);

      // Claim first and await nothing in between: this is the only atomic
      // point in the handler, and it is what makes the 409 rule true.
      const claim = queue.claim(id);
      if (!claim) {
        // run_id sits at the top level, not under `error`: a client polling a
        // sync it lost the race for wants the id it should watch, and having
        // to look for it in two different shapes is a trap.
        const running = queue.activeRun(id);
        const runId = running ? await running.runId : null;
        res.status(409).json({ run_id: runId, status: 'running', error: { message: `source ${id} is already syncing` } });
        return;
      }

      let runId: number;
      try {
        runId = await createRun(id);
      } catch (err) {
        claim.abandon(err);
        throw err;
      }

      claim.start(runId, (rid, signal) => runConnector(connector, source, rid, signal));
      res.status(202).json({ run_id: runId, status: 'queued' });
    }),
  );

  return router;
}
