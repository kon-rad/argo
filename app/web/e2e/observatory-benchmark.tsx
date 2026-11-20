// Coordinator-only Vite harness. Not an application route or production evidence.
import { useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import Workspace from '../src/routes/observatory/Workspace.js';
import type { SceneNode, SceneLink } from '../src/routes/observatory/model.js';
const nodes: SceneNode[] = Array.from({ length: 500 }, (_, i) => ({ id: `synthetic:${i}`, label: `Synthetic ${i}`, kind: 'execution', origin: (['human', 'agent', 'automation', 'unknown'] as const)[i % 4]!, fx: (i % 25) * 24, fy: Math.floor(i / 25) * 24, fz: i % 3 * 20 }));
const links: SceneLink[] = Array.from({ length: 1500 }, (_, i) => ({ source: nodes[i % 500]!.id, target: nodes[(i + 1 + Math.floor(i / 500)) % 500]!.id, result: i % 7 === 0 }));
function Benchmark() {
  const [tick, setTick] = useState(0);
  useLayoutEffect(() => { document.body.dataset.ready = String(tick); }, [tick]);
  // Alternate recorded-looking target positions to force scene replacement, retaining identities.
  const scene = nodes.map(n => ({ ...n, fz: n.fz + tick % 2 * 5 }));
  Object.assign(window, { syntheticSeek: (n: number) => flushSync(() => setTick(n)) });
  return <><p>SYNTHETIC: 500 nodes / 1500 edges. Renderer stress only, not production coverage.</p><Workspace nodes={scene} links={links} onSelect={() => {}} /></>;
}
createRoot(document.getElementById('root')!).render(<Benchmark />);
