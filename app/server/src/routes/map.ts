import { Router } from 'express';
import { query } from '../db.js';
import { metricViews, type MetricView } from '../metrics/collect.js';
import { wrap } from './http.js';

/**
 * The brain map's data: the newest stored layout, the metrics, and one
 * node's detail. Layouts are written only by `secondbrain map-build`.
 */

interface NodeRow {
  id: string; kind: string; label: string; ref: string | null; parent: string | null;
  color_key: string | null; size: number; x: number; y: number; z: number; meta: Record<string, unknown> | null;
}

/** Kiosk payloads carry no money: the value goes, a share of a target stays. */
export function kioskSafe(m: MetricView): MetricView {
  if (!m.money) return m;
  return { ...m, value: null, series: [], target: null, currency: null };
}

export function mapRouter(): Router {
  const router = Router();

  router.get('/graph', wrap(async (req, res) => {
    const { rows: v } = await query<{ version: number; built_at: string }>(
      `SELECT version, built_at::text FROM map_layouts ORDER BY version DESC LIMIT 1`);
    if (!v[0]) {
      res.status(404).json({ error: 'no layout yet: run `secondbrain map-build` on the server' });
      return;
    }
    const version = v[0].version;
    const etag = `"map-${version}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'no-cache');
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    const [nodes, edges] = await Promise.all([
      query<NodeRow>(`SELECT id, kind, label, ref, parent, color_key, size, x, y, z, meta FROM map_nodes WHERE version = $1`, [version]),
      query<{ source: string; target: string; kind: string }>(`SELECT source, target, kind FROM map_edges WHERE version = $1`, [version]),
    ]);
    res.json({
      version,
      builtAt: v[0].built_at,
      nodes: nodes.rows.map((n) => ({
        id: n.id, kind: n.kind, label: n.label, ref: n.ref, parent: n.parent, color: n.color_key,
        size: n.size, x: n.x, y: n.y, z: n.z, meta: n.meta ?? {},
      })),
      edges: edges.rows,
    });
  }));

  router.get('/metrics', wrap(async (req, res) => {
    const all = await metricViews();
    res.setHeader('Cache-Control', 'no-cache');
    res.json({ metrics: req.query['kiosk'] === '1' ? all.map(kioskSafe) : all });
  }));

  router.get('/node/:id', wrap(async (req, res) => {
    const id = String(req.params['id']);
    const { rows: v } = await query<{ version: number }>(`SELECT MAX(version) AS version FROM map_layouts`);
    const version = v[0]?.version;
    if (!version) { res.status(404).json({ error: 'no layout yet' }); return; }
    const { rows } = await query<NodeRow>(
      `SELECT id, kind, label, ref, parent, color_key, size, x, y, z, meta FROM map_nodes WHERE version = $1 AND id = $2`, [version, id]);
    const node = rows[0];
    if (!node) { res.status(404).json({ error: `no node ${id}` }); return; }

    const { rows: nbrs } = await query<{ id: string; kind: string; label: string; ref: string | null; edge: string }>(
      `SELECT n.id, n.kind, n.label, n.ref, e.kind AS edge
         FROM map_edges e JOIN map_nodes n ON n.version = e.version AND n.id = CASE WHEN e.source = $2 THEN e.target ELSE e.source END
        WHERE e.version = $1 AND (e.source = $2 OR e.target = $2)
        ORDER BY (n.kind = 'note'), n.label LIMIT 60`,
      [version, id]);

    let preview: string | null = null;
    if (node.kind === 'note' && node.ref) {
      const { rows: f } = await query<{ body: string | null }>(`SELECT left(body, 1500) AS body FROM vault_files WHERE path = $1`, [node.ref]);
      preview = f[0]?.body ?? null;
    } else if ((node.kind === 'project' || node.kind === 'mission') && node.ref) {
      const path = node.kind === 'mission' ? node.ref : (node.meta?.['design'] as string | undefined);
      if (path) {
        const { rows: f } = await query<{ body: string | null }>(`SELECT left(body, 1500) AS body FROM vault_files WHERE path = $1`, [path]);
        preview = f[0]?.body ?? null;
      }
    }
    res.json({
      node: { id: node.id, kind: node.kind, label: node.label, ref: node.ref, parent: node.parent, color: node.color_key, meta: node.meta ?? {} },
      neighbours: nbrs,
      preview,
    });
  }));

  return router;
}
