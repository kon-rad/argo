// d3-force-3d ships no types; this is the slice used here.
// @ts-expect-error no declaration file
import { forceLink, forceManyBody, forceRadial, forceSimulation } from 'd3-force-3d';
import type { Graph, MapNode } from './graph.js';

/**
 * Positions for the brain map, computed once on the droplet and stored, so
 * the page never runs physics and the map doesn't reshuffle between loads.
 *
 * Anchors (mission, goals, divisions, projects, features, metrics) sit on
 * fixed rings. Notes start near their anchor (or in the outer shell when they
 * have none) from a seeded random, then settle under link, anchor and
 * repulsion forces. Same graph + same seed = same positions.
 */

export type Vec3 = [number, number, number];

export const RING = { goal: 110, division: 300, project: 440, outer: 700 } as const;

/** mulberry32: small, seeded, good enough for jitter. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function onSphere(rand: () => number, r: number): Vec3 {
  const u = rand() * 2 - 1;
  const th = rand() * Math.PI * 2;
  const s = Math.sqrt(1 - u * u);
  return [r * s * Math.cos(th), r * u * 0.6, r * s * Math.sin(th)];
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** Angle of each division on its ring; projects fan out inside that sector. */
export function divisionAngles(nodes: MapNode[]): Map<string, number> {
  const divs = nodes.filter((n) => n.kind === 'division');
  return new Map(divs.map((d, i) => [d.id, (2 * Math.PI * i) / Math.max(1, divs.length)]));
}

export function anchorPositions(graph: Graph): Map<string, Vec3> {
  const pos = new Map<string, Vec3>();
  const byKind = (k: MapNode['kind']) => graph.nodes.filter((n) => n.kind === k);
  pos.set('mission', [0, 0, 0]);

  const goals = byKind('goal');
  goals.forEach((g, i) => {
    const a = (2 * Math.PI * i) / goals.length + Math.PI / goals.length;
    pos.set(g.id, [RING.goal * Math.cos(a), g.label.startsWith('Y') ? 30 : -20, RING.goal * Math.sin(a)]);
  });

  const angles = divisionAngles(graph.nodes);
  const sector = (2 * Math.PI) / Math.max(1, angles.size);
  for (const [id, a] of angles) pos.set(id, [RING.division * Math.cos(a), 0, RING.division * Math.sin(a)]);

  const projects = byKind('project');
  const byParent = new Map<string, MapNode[]>();
  for (const p of projects) byParent.set(p.parent!, [...(byParent.get(p.parent!) ?? []), p]);
  for (const [parent, list] of byParent) {
    const base = angles.get(parent);
    list.forEach((p, j) => {
      if (base === undefined) {
        // No division: a small ring above the mission.
        const a = (2 * Math.PI * j) / list.length;
        pos.set(p.id, [160 * Math.cos(a), 140, 160 * Math.sin(a)]);
        return;
      }
      const spread = list.length === 1 ? 0 : (j / (list.length - 1) - 0.5) * sector * 0.8;
      const r = RING.project + (j % 2) * 60;
      pos.set(p.id, [r * Math.cos(base + spread), ((j % 3) - 1) * 45, r * Math.sin(base + spread)]);
    });
  }

  // Features: a small golden-angle shell around their project.
  const feats = new Map<string, MapNode[]>();
  for (const f of byKind('feature')) feats.set(f.parent!, [...(feats.get(f.parent!) ?? []), f]);
  for (const [parent, list] of feats) {
    const c = pos.get(parent) ?? [0, 0, 0];
    list.forEach((f, i) => {
      const y = 1 - (2 * (i + 0.5)) / list.length;
      const r = Math.sqrt(1 - y * y);
      const th = i * 2.399963;
      pos.set(f.id, add(c, [22 * r * Math.cos(th), 22 * y, 22 * r * Math.sin(th)]));
    });
  }

  // Metrics: a ring floating above whatever they hang off.
  const mets = new Map<string, MapNode[]>();
  for (const m of byKind('metric')) mets.set(m.parent!, [...(mets.get(m.parent!) ?? []), m]);
  for (const [parent, list] of mets) {
    const c = pos.get(parent) ?? [0, 0, 0];
    list.forEach((m, i) => {
      const a = (2 * Math.PI * i) / list.length;
      const r = list.length === 1 ? 0 : 40;
      pos.set(m.id, add(c, [r * Math.cos(a), 55, r * Math.sin(a)]));
    });
  }
  return pos;
}

interface SimNode { id: string; x: number; y: number; z: number; fx?: number; fy?: number; fz?: number; anchored: boolean }

export function layout(graph: Graph, opts: { seed?: number; ticks?: number } = {}): Map<string, Vec3> {
  const rand = rng(opts.seed ?? 42);
  const anchors = anchorPositions(graph);
  const simNodes: SimNode[] = [];
  const index = new Map<string, SimNode>();

  for (const n of graph.nodes) {
    const fixed = anchors.get(n.id);
    let sn: SimNode;
    if (fixed) {
      sn = { id: n.id, x: fixed[0], y: fixed[1], z: fixed[2], fx: fixed[0], fy: fixed[1], fz: fixed[2], anchored: true };
    } else {
      const parent = n.parent ? anchors.get(n.parent) : undefined;
      const start = parent ? add(parent, onSphere(rand, 30 + rand() * 30)) : onSphere(rand, RING.outer + rand() * 120);
      sn = { id: n.id, x: start[0], y: start[1], z: start[2], anchored: Boolean(parent) };
    }
    simNodes.push(sn);
    index.set(n.id, sn);
  }

  const kindOf = new Map(graph.nodes.map((n) => [n.id, n.kind]));
  const simLinks = graph.edges
    .filter((e) => kindOf.get(e.source) === 'note' || kindOf.get(e.target) === 'note')
    .map((e) => ({ source: e.source, target: e.target, kind: e.kind, targetKind: kindOf.get(e.target) }));

  const floating = simNodes.filter((n) => !n.anchored && n.fx === undefined).map((n) => n.id);
  const floatingSet = new Set(floating);

  const sim = forceSimulation(simNodes, 3)
    .force('link', forceLink(simLinks).id((d: SimNode) => d.id)
      .distance((l: { kind: string; targetKind?: string }) => (l.kind === 'link' ? 35 : l.targetKind === 'project' ? 45 : l.targetKind === 'division' ? 80 : 130))
      .strength((l: { kind: string }) => (l.kind === 'link' ? 0.03 : 0.12)))
    .force('charge', forceManyBody().strength(-14).distanceMax(160))
    .force('outer', forceRadial(RING.outer, 0, 0, 0).strength((d: SimNode) => (floatingSet.has(d.id) ? 0.06 : 0)))
    .stop();

  const ticks = opts.ticks ?? 200;
  for (let i = 0; i < ticks; i++) sim.tick();

  const out = new Map<string, Vec3>();
  for (const n of simNodes) out.set(n.id, [round(n.x), round(n.y), round(n.z)]);
  return out;
}

const round = (v: number): number => Math.round(v * 100) / 100;
