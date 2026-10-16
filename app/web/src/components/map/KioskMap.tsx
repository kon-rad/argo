import { useEffect, useRef, useState } from 'react';
import {
  BufferAttribute, BufferGeometry, Color, Group, InstancedMesh, LineBasicMaterial, LineSegments, Matrix4,
  MeshBasicMaterial, PerspectiveCamera, Points, PointsMaterial, Scene, SphereGeometry, Vector3, WebGLRenderer,
} from 'three';
import { LABELLED, labelSprite, mapApi, metricLabel, nodeColor, recency, type MapGraph, type MapMetric, type MapNodeData } from '../../lib/mapData.js';

/**
 * The brain map for the Pi 4 TV (`/map?kiosk=1`). Plain three.js, batched:
 * every note is one Points draw, every edge one of two LineSegments draws,
 * every anchor one InstancedMesh draw; only the ~60 anchor labels are
 * separate sprites. Pixel ratio 1, no antialias, capped at 30 fps, and a slow
 * scripted tour. Notes carry no labels and money never arrives (the API
 * strips it for kiosk=1). Why not 3d-force-graph here: it draws one mesh per
 * node and one line per link, thousands of draw calls a frame on a Pi's CPU.
 */

const FPS_CAP = 30;
const DIVISION_DWELL_MS = 8_000;
const OVERVIEW_MS = 20_000;
const GRAPH_POLL_MS = 10 * 60_000;
const METRIC_POLL_MS = 5 * 60_000;

interface Built { group: Group; labels: Map<string, ReturnType<typeof labelSprite>>; divisions: MapNodeData[] }

function buildScene(graph: MapGraph, metrics: MapMetric[]): Built {
  const group = new Group();
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const now = Date.now();

  const notes = graph.nodes.filter((n) => n.kind === 'note');
  const pos = new Float32Array(notes.length * 3);
  const col = new Float32Array(notes.length * 3);
  const c = new Color();
  notes.forEach((n, i) => {
    pos.set([n.x, n.y, n.z], i * 3);
    c.set(nodeColor(n)).multiplyScalar(recency(n, now));
    col.set([c.r, c.g, c.b], i * 3);
  });
  const pg = new BufferGeometry();
  pg.setAttribute('position', new BufferAttribute(pos, 3));
  pg.setAttribute('color', new BufferAttribute(col, 3));
  group.add(new Points(pg, new PointsMaterial({ size: 3.2, vertexColors: true, sizeAttenuation: true })));

  // Two batches: note-to-note links faint, structure (belongs, goal) brighter. Note->anchor springs are left out: noise on a TV.
  const segs = (filter: (s: MapNodeData, t: MapNodeData, kind: string) => boolean, color: string, opacity: number) => {
    const pts: number[] = [];
    for (const e of graph.edges) {
      const s = byId.get(e.source);
      const t = byId.get(e.target);
      if (s && t && filter(s, t, e.kind)) pts.push(s.x, s.y, s.z, t.x, t.y, t.z);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(pts), 3));
    return new LineSegments(g, new LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
  };
  group.add(segs((_s, _t, k) => k === 'link', '#7f8fb0', 0.18));
  group.add(segs((s, t, k) => k !== 'link' && s.kind !== 'note' && t.kind !== 'note', '#d8dde8', 0.35));

  const anchors = graph.nodes.filter((n) => n.kind !== 'note');
  const mesh = new InstancedMesh(new SphereGeometry(1, 12, 8), new MeshBasicMaterial(), anchors.length);
  const m4 = new Matrix4();
  anchors.forEach((n, i) => {
    const s = n.kind === 'mission' ? 14 : n.size * 1.4;
    m4.makeScale(s, s, s).setPosition(n.x, n.y, n.z);
    mesh.setMatrixAt(i, m4);
    mesh.setColorAt(i, c.set(nodeColor(n)));
  });
  group.add(mesh);

  const labels = new Map<string, ReturnType<typeof labelSprite>>();
  const metricByKey = new Map(metrics.map((m) => [m.key, m]));
  for (const n of anchors) {
    if (!LABELLED.has(n.kind)) continue;
    if (n.kind === 'goal' && !n.label.startsWith('Y')) continue; // year goals only; the week's are too many for a TV
    const metric = n.kind === 'metric' ? metricByKey.get(n.ref ?? '') : undefined;
    const text = metric ? metricLabel(metric) : n.kind === 'mission' ? 'Mission' : n.label;
    // Sized for a 40-inch TV across a room: the camera sits ~1,100 units out.
    const size = n.kind === 'mission' ? 40 : n.kind === 'division' ? 34 : n.kind === 'metric' ? 22 : n.kind === 'goal' ? 18 : 13;
    const sp = labelSprite(text, { size, bg: n.kind === 'metric', color: n.kind === 'metric' ? '#ffffff' : nodeColor(n) });
    sp.position.set(n.x, n.y + size * 0.7 + n.size * 1.4, n.z);
    group.add(sp);
    labels.set(n.id, sp);
  }
  return { group, labels, divisions: graph.nodes.filter((n) => n.kind === 'division') };
}

export default function KioskMap() {
  const host = useRef<HTMLDivElement>(null);
  const [fps, setFps] = useState(0);
  const [status, setStatus] = useState('loading the map...');
  const [caption, setCaption] = useState('');

  useEffect(() => {
    const el = host.current!;
    const renderer = new WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(1);
    renderer.setSize(el.clientWidth, el.clientHeight);
    renderer.setClearColor('#03050a');
    el.appendChild(renderer.domElement);
    const scene = new Scene();
    const camera = new PerspectiveCamera(55, el.clientWidth / el.clientHeight, 1, 5000);
    camera.position.set(0, 520, 1100);

    let built: Built | null = null;
    let version = -1;
    let stopped = false;

    // Frees the old batch: on a TV that runs for days, leaked buffers and label textures add up.
    const dispose = (g: Group) => g.traverse((o) => {
      const obj = o as unknown as { geometry?: BufferGeometry; material?: { dispose(): void; map?: { dispose(): void } } };
      obj.geometry?.dispose();
      obj.material?.map?.dispose();
      obj.material?.dispose();
    });
    // Labels are baked into textures, so new metric values mean a rebuild; cheap at this size.
    const load = async (force = false) => {
      try {
        const [graph, { metrics }] = await Promise.all([mapApi.graph(), mapApi.metrics(true)]);
        if (!force && graph.version === version && built) return;
        const next = buildScene(graph, metrics);
        if (built) { scene.remove(built.group); dispose(built.group); }
        built = next;
        version = graph.version;
        scene.add(built.group);
        setStatus('');
      } catch (err) {
        if (!built) setStatus(`map unavailable: ${(err as Error).message}`);
      }
    };
    void load();
    const gTimer = setInterval(() => void load(), GRAPH_POLL_MS);
    const mTimer = setInterval(() => void load(true), METRIC_POLL_MS);

    // Tour: orbit the whole map, then visit each division in turn.
    const target = new Vector3();
    const camGoal = new Vector3(0, 520, 1100);
    const lookGoal = new Vector3();
    const tourStart = performance.now();
    const tour = (t: number) => {
      const divs = built?.divisions ?? [];
      const cycle = OVERVIEW_MS + divs.length * DIVISION_DWELL_MS;
      const k = (t - tourStart) % Math.max(cycle, 1);
      if (k < OVERVIEW_MS || divs.length === 0) {
        const a = (k / OVERVIEW_MS) * Math.PI * 2;
        camGoal.set(1150 * Math.cos(a), 480, 1150 * Math.sin(a));
        lookGoal.set(0, 0, 0);
        return 'Argo: the whole map';
      }
      const d = divs[Math.floor((k - OVERVIEW_MS) / DIVISION_DWELL_MS)]!;
      const out = new Vector3(d.x, 0, d.z).normalize();
      const drift = ((k - OVERVIEW_MS) % DIVISION_DWELL_MS) / DIVISION_DWELL_MS;
      camGoal.set(d.x + out.x * 420 - out.z * 120 * (drift - 0.5), 260, d.z + out.z * 420 + out.x * 120 * (drift - 0.5));
      lookGoal.set(d.x * 1.2, 0, d.z * 1.2);
      return d.label;
    };

    let last = 0;
    let frames = 0;
    let fpsAt = performance.now();
    let raf = 0;
    const frame = (t: number) => {
      raf = requestAnimationFrame(frame);
      if (stopped || t - last < 1000 / FPS_CAP - 1) return;
      last = t;
      const cap = tour(t);
      camera.position.lerp(camGoal, 0.02);
      target.lerp(lookGoal, 0.03);
      camera.lookAt(target);
      renderer.render(scene, camera);
      frames++;
      if (t - fpsAt >= 1000) {
        setFps(Math.round((frames * 1000) / (t - fpsAt)));
        setCaption(cap);
        frames = 0;
        fpsAt = t;
      }
    };
    raf = requestAnimationFrame(frame);

    const onResize = () => {
      renderer.setSize(el.clientWidth, el.clientHeight);
      camera.aspect = el.clientWidth / el.clientHeight;
      camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', onResize);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      clearInterval(gTimer);
      clearInterval(mTimer);
      window.removeEventListener('resize', onResize);
      renderer.dispose();
      el.removeChild(renderer.domElement);
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 bg-black" data-testid="map-kiosk">
      <div ref={host} className="h-full w-full" />
      <div className="pointer-events-none absolute left-6 top-5 text-2xl font-semibold text-white/90">{caption}</div>
      <div className="pointer-events-none absolute bottom-3 right-4 font-mono text-xs text-white/60" data-testid="fps">{fps} fps</div>
      {status && <div className="absolute inset-0 grid place-items-center text-lg text-white/70">{status}</div>}
    </div>
  );
}
