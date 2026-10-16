import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool, query } from '../db.js';
import { parseGoals } from '../projects.js';
import { metrics } from '../metrics/registry.js';
import { settings } from '../settings.js';
import { buildGraph, type GraphInput } from './graph.js';
import { layout } from './layout.js';

/** Old layouts kept for a rollback; the rest are deleted (their nodes cascade). */
const KEEP_VERSIONS = 3;

export async function loadGraphInput(vaultRoot: string): Promise<GraphInput> {
  const [notes, links, divisions, projects, features] = await Promise.all([
    query<{ id: number; path: string; title: string | null; mtime: string }>(
      `SELECT id, path, title, mtime::text AS mtime FROM vault_files WHERE is_markdown AND path NOT LIKE 'Archives/%'`),
    query<{ from: number; to: number }>(
      `SELECT DISTINCT l.from_file_id AS "from", l.target_file_id AS "to"
         FROM vault_links l JOIN vault_files t ON t.id = l.target_file_id
        WHERE l.target_file_id IS NOT NULL AND l.from_file_id <> l.target_file_id AND t.is_markdown`),
    query<{ slug: string; name: string }>(`SELECT slug, name FROM divisions ORDER BY sort, slug`),
    query<GraphInput['projects'][number]>(
      `SELECT slug, title, division_slug, stage, goals, paths, design_path, devlog_path FROM projects
        WHERE stage <> 'done' ORDER BY division_slug NULLS LAST, priority NULLS LAST, slug`),
    query<{ id: number; project_slug: string; title: string; stage: string }>(
      `SELECT id::int AS id, project_slug, title, stage FROM features WHERE stage NOT IN ('done') ORDER BY project_slug, sort, id`),
  ]);
  // Division folders place notes outside every project folder; the mission
  // folders hang off the mission itself (both from secondbrain.json "map").
  const { goalsFile, missionFile, map: { divisionFolders, missionFolders } } = settings(vaultRoot);
  let goalsText = '';
  if (goalsFile) try { goalsText = readFileSync(join(vaultRoot, goalsFile), 'utf8'); } catch { /* no goals ring */ }
  return {
    notes: notes.rows,
    links: links.rows,
    divisions: divisions.rows,
    projects: projects.rows,
    features: features.rows,
    goals: parseGoals(goalsText),
    divisionFolders,
    missionFolders,
    metrics: metrics(),
    missionFile: missionFile ?? null,
  };
}

export interface BuildResult { version: number; nodes: number; edges: number; ms: number }

export async function buildMap(vaultRoot: string): Promise<BuildResult> {
  const started = Date.now();
  const graph = buildGraph(await loadGraphInput(vaultRoot));
  // Notes only link to notes that are on the map (archives are left out).
  const ids = new Set(graph.nodes.map((n) => n.id));
  graph.edges = graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  const pos = layout(graph);
  const ms = Date.now() - started;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ v: number }>(`SELECT COALESCE(MAX(version), 0) + 1 AS v FROM map_layouts`);
    const version = rows[0]!.v;
    await client.query(`INSERT INTO map_layouts (version, nodes, edges, ms) VALUES ($1, $2, $3, $4)`, [version, graph.nodes.length, graph.edges.length, ms]);
    await client.query(
      `INSERT INTO map_nodes (version, id, kind, label, ref, parent, color_key, size, x, y, z, meta)
       SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::real[], $9::real[], $10::real[], $11::real[], $12::jsonb[])`,
      [version,
        graph.nodes.map((n) => n.id), graph.nodes.map((n) => n.kind), graph.nodes.map((n) => n.label),
        graph.nodes.map((n) => n.ref), graph.nodes.map((n) => n.parent), graph.nodes.map((n) => n.colorKey),
        graph.nodes.map((n) => n.size),
        graph.nodes.map((n) => pos.get(n.id)![0]), graph.nodes.map((n) => pos.get(n.id)![1]), graph.nodes.map((n) => pos.get(n.id)![2]),
        graph.nodes.map((n) => JSON.stringify(n.meta))],
    );
    // Wikilinks can repeat in both directions; the primary key keeps one of each.
    await client.query(
      `INSERT INTO map_edges (version, source, target, kind)
       SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[]) ON CONFLICT DO NOTHING`,
      [version, graph.edges.map((e) => e.source), graph.edges.map((e) => e.target), graph.edges.map((e) => e.kind)],
    );
    await client.query(`DELETE FROM map_layouts WHERE version <= $1`, [version - KEEP_VERSIONS]);
    await client.query('COMMIT');
    return { version, nodes: graph.nodes.length, edges: graph.edges.length, ms };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
