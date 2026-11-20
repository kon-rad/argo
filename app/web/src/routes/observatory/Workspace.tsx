import { useEffect, useRef, useState } from 'react';
import ForceGraph3D, { type ForceGraph3DInstance } from '3d-force-graph';
import { BoxGeometry, Mesh, MeshBasicMaterial, OctahedronGeometry, SphereGeometry } from 'three';
import { originStyle, type SceneNode, type SceneLink } from './model.js';

export default function Workspace({ nodes, links, onSelect }: { nodes: SceneNode[]; links: SceneLink[]; onSelect: (id: string) => void }) {
  const host = useRef<HTMLDivElement>(null), graph = useRef<ForceGraph3DInstance | null>(null);
  const resources = useRef<Mesh[]>([]), wake = useRef(() => {}), select = useRef(onSelect);
  select.current = onSelect;
  const [failed, setFailed] = useState(false);
  const release = () => { for (const mesh of resources.current) { mesh.geometry.dispose(); (mesh.material as MeshBasicMaterial).dispose(); } resources.current = []; };
  useEffect(() => {
    const el = host.current!;
    let cleanup = () => {};
    try {
      const g = new ForceGraph3D(el, { controlType: 'orbit' }).backgroundColor('#080e18').showNavInfo(false)
        .cooldownTicks(0).warmupTicks(0).enableNodeDrag(false)
        // No untrusted text in the library's HTML tooltips. Labels live in accessible HTML.
        .nodeLabel(() => '').onNodeClick(n => select.current((n as SceneNode).id))
        .nodeThreeObject(raw => {
          const n = raw as SceneNode, style = originStyle(n.origin);
          const geometry = n.kind === 'machine' ? new BoxGeometry(150, 4, 150) : n.kind === 'ticket' || n.kind === 'file' ? new BoxGeometry(12, 8, 6) :
            style.shape === 'diamond' || style.shape === 'hollow' ? new OctahedronGeometry(6) : style.shape === 'box' ? new BoxGeometry(9, 9, 9) : new SphereGeometry(n.kind === 'execution' ? 9 : 4, 10, 8);
          const mesh = new Mesh(geometry, new MeshBasicMaterial({ color: style.color, wireframe: style.shape === 'hollow' }));
          resources.current.push(mesh); return mesh;
        }).linkColor(l => (l as SceneLink).result ? '#22d3ee' : '#64748b').linkDirectionalArrowLength(l => (l as SceneLink).result ? 4 : 0);
      graph.current = g;
      // Frame the first evidenced scene once; scrubbing preserves the viewer's camera.
      const axes = (key: 'fx' | 'fy' | 'fz') => nodes.length ? [Math.min(...nodes.map(n => n[key])), Math.max(...nodes.map(n => n[key]))] : [0, 0];
      const [minX, maxX] = axes('fx'), [minY, maxY] = axes('fy'), [minZ, maxZ] = axes('fz');
      const center = { x: (minX! + maxX!) / 2, y: (minY! + maxY!) / 2, z: (minZ! + maxZ!) / 2 };
      const span = Math.max(180, maxX! - minX!, maxY! - minY!, maxZ! - minZ!);
      g.cameraPosition({ x: center.x, y: center.y + span * 1.2, z: center.z + span * 1.8 }, center);
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
    g.pauseAnimation(); release();
    g.graphData({ nodes: nodes.map(n => ({ ...n, x: n.fx, y: n.fy, z: n.fz })), links: links.map(l => ({ ...l })) });
    wake.current();
  }, [nodes, links, failed]);
  return <><div ref={host} style={{ height: failed ? 0 : 420 }} aria-label="3D execution workspace" tabIndex={failed ? -1 : 0} />
    {failed && <p role="status">3D unavailable. Use the execution list and event timeline below.</p>}</>;
}
