import { useCallback, useEffect, useRef, useState } from 'react';
import ForceGraph3D, { type ForceGraph3DInstance } from '3d-force-graph';
import { BoxGeometry, Mesh, MeshBasicMaterial, OctahedronGeometry, SphereGeometry, type BufferGeometry } from 'three';
import { originStyle, type SceneNode, type SceneLink } from './model.js';

export default function Workspace({ nodes, links, onSelect }: { nodes: SceneNode[]; links: SceneLink[]; onSelect: (id: string) => void }) {
  const host = useRef<HTMLDivElement>(null), graph = useRef<ForceGraph3DInstance | null>(null);
  const resources = useRef(new Map<string, { geometry: BufferGeometry; material: MeshBasicMaterial }>()), meshes = useRef(new Map<string, Mesh>()), previous = useRef(''), wake = useRef(() => {}), select = useRef(onSelect);
  const nodeData = useRef(new Map<string, SceneNode & { x: number; y: number; z: number }>()), linkData = useRef(new Map<string, SceneLink>());
  const framed = useRef(false);
  select.current = onSelect;
  const [failed, setFailed] = useState(false);
  const release = () => { for (const resource of resources.current.values()) { resource.geometry.dispose(); resource.material.dispose(); } resources.current.clear(); meshes.current.clear(); nodeData.current.clear(); linkData.current.clear(); previous.current = ''; };
  const fit = useCallback((items: SceneNode[]) => {
    const g = graph.current;
    if (!g || !items.length) return;
    const axis = (key: 'fx' | 'fy' | 'fz') => [Math.min(...items.map(n => n[key])), Math.max(...items.map(n => n[key]))];
    const [minX, maxX] = axis('fx'), [minY, maxY] = axis('fy'), [minZ, maxZ] = axis('fz');
    const center = { x: (minX! + maxX!) / 2, y: (minY! + maxY!) / 2, z: (minZ! + maxZ!) / 2 };
    const span = Math.max(180, maxX! - minX!, maxY! - minY!, maxZ! - minZ!);
    g.cameraPosition({ x: center.x, y: center.y + span * 1.2, z: center.z + span * 1.8 }, center);
    framed.current = true; wake.current();
  }, []);
  useEffect(() => {
    const el = host.current!;
    let cleanup = () => {};
    try {
      const g = new ForceGraph3D(el, { controlType: 'orbit', rendererConfig: { antialias: false } }).backgroundColor('#080e18').showNavInfo(false)
        .cooldownTicks(0).warmupTicks(0).enableNodeDrag(false)
        // No untrusted text in the library's HTML tooltips. Labels live in accessible HTML.
        .nodeLabel(() => '').onNodeClick(n => select.current((n as SceneNode).id))
        .nodeThreeObject(raw => {
          const n = raw as SceneNode, style = originStyle(n.origin);
          const meshKey = `${n.id}:${n.kind}:${n.origin}`;
          const existing = meshes.current.get(meshKey);
          if (existing) return existing;
          const key = `${n.kind}:${n.origin}`;
          let resource = resources.current.get(key);
          if (!resource) {
            const geometry = n.kind === 'machine' ? new BoxGeometry(150, 4, 150) : n.kind === 'ticket' || n.kind === 'file' ? new BoxGeometry(12, 8, 6) :
              style.shape === 'diamond' || style.shape === 'hollow' ? new OctahedronGeometry(6) : style.shape === 'box' ? new BoxGeometry(9, 9, 9) : new SphereGeometry(n.kind === 'execution' ? 9 : 4, 8, 6);
            resource = { geometry, material: new MeshBasicMaterial({ color: style.color, wireframe: style.shape === 'hollow' }) };
            resources.current.set(key, resource);
          }
          const mesh = new Mesh(resource.geometry, resource.material);
          meshes.current.set(meshKey, mesh); return mesh;
        }).linkColor(l => (l as SceneLink).result ? '#22d3ee' : '#64748b').linkDirectionalArrowLength(l => (l as SceneLink).result ? 4 : 0);
      graph.current = g;
      g.renderer().setPixelRatio(1);
      let timer: ReturnType<typeof setTimeout>;
      wake.current = () => { if (document.hidden) return; g.resumeAnimation(); clearTimeout(timer); timer = setTimeout(() => g.pauseAnimation(), 1200); };
      const interaction = () => wake.current();
      const resize = new ResizeObserver(() => { g.width(el.clientWidth).height(420); interaction(); });
      resize.observe(el);
      for (const type of ['pointerdown', 'pointermove', 'wheel', 'keydown']) el.addEventListener(type, interaction);
      const lost = (e: Event) => { e.preventDefault(); g.pauseAnimation(); setFailed(true); };
      el.addEventListener('webglcontextlost', lost, true);
      const visibility = () => { if (document.hidden) g.pauseAnimation(); else interaction(); };
      document.addEventListener('visibilitychange', visibility);
      interaction();
      cleanup = () => {
        clearTimeout(timer); resize.disconnect(); document.removeEventListener('visibilitychange', visibility);
        for (const type of ['pointerdown', 'pointermove', 'wheel', 'keydown']) el.removeEventListener(type, interaction);
        el.removeEventListener('webglcontextlost', lost, true);
        g.pauseAnimation(); g._destructor(); release(); graph.current = null; wake.current = () => {}; el.replaceChildren();
      };
    } catch { graph.current?.pauseAnimation(); graph.current?._destructor(); graph.current = null; release(); el.replaceChildren(); setFailed(true); }
    return () => cleanup();
  }, []);
  useEffect(() => {
    const g = graph.current;
    if (!g || failed) return;
    // Many cursor changes alter only timeline state. Preserve the identical scene and GPU objects.
    const signature = JSON.stringify([nodes, links]);
    if (signature === previous.current) return;
    previous.current = signature;
    g.pauseAnimation();
    const visible = new Set(nodes.map(n => `${n.id}:${n.kind}:${n.origin}`));
    for (const id of meshes.current.keys()) if (!visible.has(id)) meshes.current.delete(id);
    for (const id of nodeData.current.keys()) if (!visible.has(id)) nodeData.current.delete(id);
    const nextNodes = nodes.map(n => {
      const key = `${n.id}:${n.kind}:${n.origin}`;
      const data = Object.assign(nodeData.current.get(key) ?? {}, n, { x: n.fx, y: n.fy, z: n.fz });
      nodeData.current.set(key, data); return data;
    });
    const linkKeys = new Set<string>();
    const nextLinks = links.map((l, i) => {
      const key = JSON.stringify([i, l.source, l.target, l.result]); linkKeys.add(key);
      const data = Object.assign(linkData.current.get(key) ?? {}, l);
      linkData.current.set(key, data); return data;
    });
    for (const id of linkData.current.keys()) if (!linkKeys.has(id)) linkData.current.delete(id);
    // The library binds scene objects by data-object identity, so retain surviving records.
    g.graphData({ nodes: nextNodes, links: nextLinks });
    if (!framed.current && nodes.length) fit(nodes);
    wake.current();
  }, [nodes, links, failed, fit]);
  return <><div ref={host} style={{ height: 420, display: failed ? 'none' : undefined }} aria-label="3D execution workspace" tabIndex={failed ? -1 : 0} />
    <button type="button" disabled={failed || !nodes.length} onClick={() => fit(nodes)}>Fit active workspace</button>
    {failed && <p role="status">3D unavailable. Use the execution list and event timeline below.</p>}</>;
}
