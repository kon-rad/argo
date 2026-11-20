import { forwardRef, useEffect, useLayoutEffect, useImperativeHandle, useRef } from 'react';
import { operationStyle, type NoteActivity } from '../../routes/observatory/mapActivity.js';
import ForceGraph3D, { type ForceGraph3DInstance } from '3d-force-graph';
import { Group, Mesh, MeshBasicMaterial, SphereGeometry, TorusGeometry, ConeGeometry, Vector2, type BufferGeometry } from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { LABELLED, labelSprite, metricLabel, nodeColor, recency, type MapGraph, type MapMetric, type MapNodeData } from '../../lib/mapData.js';

/**
 * The brain map in a desktop browser: 3d-force-graph with the stored
 * positions pinned (fx/fy/fz, cooldownTicks 0), so nothing simulates here.
 * Anchors get a sphere and a label, notes the library's default point.
 * Clicking highlights a node's neighbours and dims the rest.
 */

export interface Layers { notes: boolean; links: boolean; structure: boolean; metrics: boolean }

export interface FullMapHandle { focus: (id: string) => void }

type GNode = MapNodeData & { fx: number; fy: number; fz: number };
type GLink = { source: string | GNode; target: string | GNode; kind: string };

interface Props {
  activity?: NoteActivity[];
  renderOnDemand?: boolean;
  graph: MapGraph;
  metrics: MapMetric[];
  layers: Layers;
  selected: string | null;
  onSelect: (id: string | null) => void;
}

const idOf = (v: string | GNode): string => (typeof v === 'string' ? v : v.id);

function hexDim(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (s: number) => Math.round(((n >> s) & 255) * k).toString(16).padStart(2, '0');
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

export const FullMap = forwardRef<FullMapHandle, Props>(function FullMap({ graph, metrics, layers, selected, onSelect, activity, renderOnDemand }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const fg = useRef<ForceGraph3DInstance | null>(null);
  const select = useRef(onSelect); select.current = onSelect;
  const nodesById = useRef(new Map<string, GNode>());
  const neighbours = useRef(new Set<string>());
  const wake = useRef((_duration = 1200) => {});
  const activityGroup = useRef<Group | null>(null);
  const activityMeshes = useRef(new Map<string, Mesh>());
  const activityResources = useRef(new Map<string, { geometry: BufferGeometry; material: MeshBasicMaterial }>());

  useImperativeHandle(ref, () => ({
    focus(id) {
      const n = nodesById.current.get(id);
      if (!n || !fg.current) return;
      const d = Math.hypot(n.x, n.y, n.z) || 1;
      const k = 1 + 160 / d;
      wake.current(2000);
      fg.current.cameraPosition({ x: n.x * k, y: n.y * k + 40, z: n.z * k }, { x: n.x, y: n.y, z: n.z }, 1500);
    },
  }));

  // Dispose controls before DOM detachment so their document listeners use the original root.
  useLayoutEffect(() => {
    const el = host.current!;
    const g = new ForceGraph3D(el, { controlType: 'orbit' })
      .backgroundColor('#04060c')
      .showNavInfo(false)
      .cooldownTicks(0)
      .warmupTicks(0)
      .enableNodeDrag(false)
      .nodeRelSize(2.2)
      .nodeResolution(6)
      .linkOpacity(0.35)
      .nodeLabel((n) => (n as GNode).label.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!));
    g.width(el.clientWidth).height(el.clientHeight);
    g.cameraPosition({ x: 0, y: 650, z: 1250 }, { x: 0, y: 0, z: 0 });
    g.postProcessingComposer().addPass(new UnrealBloomPass(new Vector2(el.clientWidth, el.clientHeight), 0.9, 0.5, 0.15));
    fg.current = g;
    let stopIdle = () => {};
    if (renderOnDemand) {
      let timer: ReturnType<typeof setTimeout>;
      wake.current = (duration = 1200) => {
        clearTimeout(timer);
        if (document.hidden) { g.pauseAnimation(); return; }
        g.resumeAnimation(); timer = setTimeout(() => g.pauseAnimation(), duration);
      };
      const interaction = () => wake.current();
      for (const type of ['pointerdown', 'pointermove', 'wheel', 'keydown']) el.addEventListener(type, interaction);
      document.addEventListener('visibilitychange', interaction);
      stopIdle = () => {
        clearTimeout(timer);
        for (const type of ['pointerdown', 'pointermove', 'wheel', 'keydown']) el.removeEventListener(type, interaction);
        document.removeEventListener('visibilitychange', interaction);
        g.pauseAnimation(); wake.current = () => {};
      };
      wake.current();
    }
    const onResize = () => { g.width(el.clientWidth).height(el.clientHeight); wake.current(); };
    const ro = new ResizeObserver(onResize);
    ro.observe(el);
    return () => {
      ro.disconnect();
      stopIdle();
      activityGroup.current?.parent?.remove(activityGroup.current);
      activityGroup.current?.clear(); activityGroup.current = null;
      activityMeshes.current.clear();
      for (const resource of activityResources.current.values()) { resource.geometry.dispose(); resource.material.dispose(); }
      activityResources.current.clear();
      g._destructor();
      fg.current = null;
      el.innerHTML = '';
    };
  }, []);

  // Data: pinned positions; anchors get their own objects.
  useEffect(() => {
    const g = fg.current;
    if (!g) return;
    const metricByKey = new Map(metrics.map((m) => [m.key, m]));
    const nodes: GNode[] = graph.nodes.map((n) => ({ ...n, fx: n.x, fy: n.y, fz: n.z }));
    nodesById.current = new Map(nodes.map((n) => [n.id, n]));
    const links: GLink[] = graph.edges.map((e) => ({ source: e.source, target: e.target, kind: e.kind }));
    g.nodeThreeObject((raw) => {
      const n = raw as GNode;
      if (n.kind === 'note') return null as unknown as Group; // library default
      const grp = new Group();
      const r = n.kind === 'mission' ? 14 : n.size * 1.5;
      grp.add(new Mesh(new SphereGeometry(r, 16, 12), new MeshBasicMaterial({ color: nodeColor(n) })));
      if (LABELLED.has(n.kind)) {
        const metric = n.kind === 'metric' ? metricByKey.get(n.ref ?? '') : undefined;
        const text = metric ? metricLabel(metric) : n.kind === 'mission' ? 'Mission' : n.label;
        const size = n.kind === 'mission' ? 26 : n.kind === 'division' ? 22 : n.kind === 'metric' ? 13 : n.kind === 'goal' ? 11 : 9;
        const sp = labelSprite(text, { size, bg: n.kind === 'metric', color: n.kind === 'metric' ? '#fff' : nodeColor(n) });
        sp.position.set(0, r + size * 0.6, 0);
        grp.add(sp);
      }
      return grp;
    });
    g.graphData({ nodes, links });
  }, [graph, metrics]);

  // Reconcile glyphs beside the pinned graph; share the bounded shape/origin resources.
  useEffect(() => {
    const g = fg.current;
    if (!g || !activity) return;
    if (!activityGroup.current) { activityGroup.current = new Group(); g.scene().add(activityGroup.current); }
    const group = activityGroup.current, seen = new Set<string>();
    group.visible = layers.notes;
    for (const item of activity) {
      if (!item.node || !item.event.target) continue;
      const read = item.event.target.operation === 'read', key = `${item.node.id}:${read}:${item.event.actor.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let mesh = activityMeshes.current.get(key);
      if (!mesh) {
        const resourceKey = `${read}:${item.event.actor.kind}`;
        let resource = activityResources.current.get(resourceKey);
        if (!resource) {
          resource = { geometry: read ? new TorusGeometry(5, 1, 6, 12) : new ConeGeometry(5, 8, 3),
            material: new MeshBasicMaterial({ color: operationStyle(item.event.target.operation, item.event.actor.kind).color, depthTest: false }) };
          activityResources.current.set(resourceKey, resource);
        }
        mesh = new Mesh(resource.geometry, resource.material); mesh.renderOrder = 10;
        activityMeshes.current.set(key, mesh); group.add(mesh);
      }
      mesh.position.set(item.node.x + (read ? -7 : 7), item.node.y + 10, item.node.z);
    }
    for (const [key, mesh] of activityMeshes.current) if (!seen.has(key)) { group.remove(mesh); activityMeshes.current.delete(key); }
    wake.current();
  }, [activity, layers.notes]);

  // Highlight, visibility.
  useEffect(() => {
    const g = fg.current;
    if (!g) return;
    const nb = new Set<string>();
    if (selected) {
      nb.add(selected);
      for (const e of graph.edges) {
        if (e.source === selected) nb.add(e.target);
        if (e.target === selected) nb.add(e.source);
      }
    }
    neighbours.current = nb;
    const now = Date.now();
    g.nodeColor((raw) => {
      const n = raw as GNode;
      const base = nodeColor(n);
      if (selected && !nb.has(n.id)) return hexDim(base, 0.15);
      return n.kind === 'note' ? hexDim(base, recency(n, now)) : base;
    })
      .nodeVisibility((raw) => {
        const n = raw as GNode;
        if (n.kind === 'note') return layers.notes;
        if (n.kind === 'metric') return layers.metrics;
        return true;
      })
      .linkVisibility((raw) => {
        const l = raw as GLink;
        const s = nodesById.current.get(idOf(l.source));
        const t = nodesById.current.get(idOf(l.target));
        if (!s || !t) return false;
        if ((s.kind === 'note' || t.kind === 'note') && !layers.notes) return false;
        if ((s.kind === 'metric' || t.kind === 'metric') && !layers.metrics) return false;
        if (l.kind === 'link') return layers.links;
        // Note -> anchor springs drawn only for the selection: 2,000 of them is fog.
        if (s.kind === 'note' || t.kind === 'note') return Boolean(selected) && (nb.has(s.id) && nb.has(t.id));
        return layers.structure;
      })
      .linkColor((raw) => {
        const l = raw as GLink;
        const hit = selected && (idOf(l.source) === selected || idOf(l.target) === selected);
        if (hit) return '#ffffff';
        return l.kind === 'link' ? '#6f7ea3' : l.kind === 'goal' ? '#ffd27a' : '#9aa3b5';
      })
      .onNodeClick((raw) => select.current((raw as GNode).id))
      .onBackgroundClick(() => select.current(null));
    wake.current();
  }, [graph, layers, selected]);

  return <div ref={host} className="h-full w-full" data-testid="map-full" />;
});
