import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import Workspace from '../src/routes/observatory/Workspace.js';
import { demoWindow } from '../src/routes/observatory/demo.js';
import { sceneAt } from '../src/routes/observatory/model.js';
const graph = vi.hoisted(() => {
  const g: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const key of ['backgroundColor', 'showNavInfo', 'cooldownTicks', 'warmupTicks', 'enableNodeDrag', 'nodeLabel', 'onNodeClick', 'nodeThreeObject', 'linkColor', 'linkDirectionalArrowLength', 'cameraPosition', 'width', 'height', 'resumeAnimation', 'pauseAnimation', 'graphData', '_destructor']) g[key] = vi.fn(() => g);
  g.renderer = vi.fn(() => ({ setPixelRatio: vi.fn() }));
  return g;
});
vi.mock('3d-force-graph', () => ({ default: class { constructor() { return graph; } } }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
it('pins layout, preserves renderer on seek, pauses when idle and destroys on unmount', () => {
  vi.useFakeTimers();
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect = disconnect; });
  const first = sceneAt(demoWindow, demoWindow.from + 2000, {}), second = sceneAt(demoWindow, demoWindow.from + 7000, {});
  const props = { onSelect: vi.fn(), nodes: first.nodes, links: first.links };
  const view = render(<Workspace {...props} />);
  expect(graph.cooldownTicks).toHaveBeenCalledWith(0);
  expect(graph.warmupTicks).toHaveBeenCalledWith(0);
  const lookAt = graph.cameraPosition!.mock.calls[0]![1] as { x: number; y: number; z: number };
  expect(lookAt.x).toBeGreaterThanOrEqual(Math.min(...first.nodes.map(n => n.fx)));
  expect(lookAt.x).toBeLessThanOrEqual(Math.max(...first.nodes.map(n => n.fx)));
  expect(lookAt.z).toBeGreaterThanOrEqual(Math.min(...first.nodes.map(n => n.fz)));
  expect(lookAt.z).toBeLessThanOrEqual(Math.max(...first.nodes.map(n => n.fz)));
  vi.advanceTimersByTime(1200);
  expect(graph.pauseAnimation).toHaveBeenCalled();
  view.rerender(<Workspace {...props} nodes={second.nodes} links={second.links} />);
  expect(graph.cameraPosition).toHaveBeenCalledTimes(1);
  expect(graph.graphData).toHaveBeenLastCalledWith({ nodes: [], links: [] });
  view.unmount();
  expect(graph._destructor).toHaveBeenCalledTimes(1);
  expect(disconnect).toHaveBeenCalledTimes(1);
  const pauses = graph.pauseAnimation!.mock.calls.length;
  vi.advanceTimersByTime(2000);
  expect(graph.pauseAnimation!.mock.calls.length).toBe(pauses);
});

it('hides the retained canvas when WebGL context is lost so HTML inspection stays usable', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const first = sceneAt(demoWindow, demoWindow.from + 2000, {});
  const view = render(<Workspace nodes={first.nodes} links={first.links} onSelect={() => {}} />);
  const host = view.getByLabelText('3D execution workspace');
  const canvas = document.createElement('canvas');
  canvas.style.height = '420px'; host.appendChild(canvas);
  fireEvent(canvas, new Event('webglcontextlost', { bubbles: true, cancelable: true }));
  expect(host.style.display).toBe('none');
  expect(view.getByRole('status').textContent).toContain('3D unavailable');
  expect(graph.pauseAnimation).toHaveBeenCalled();
});

it('does not rebuild an identical scene on a timeline-only seek', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const scene = sceneAt(demoWindow, demoWindow.from + 2000, {});
  const props = { nodes: scene.nodes, links: scene.links, onSelect: vi.fn() };
  const view = render(<Workspace {...props} />);
  const calls = graph.graphData!.mock.calls.length;
  view.rerender(<Workspace {...props} nodes={scene.nodes.map(n => ({ ...n }))} links={scene.links.map(l => ({ ...l }))} />);
  expect(graph.graphData).toHaveBeenCalledTimes(calls);
});

it('retains data identity when surviving markers move', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const scene = sceneAt(demoWindow, demoWindow.from + 2000, {});
  const props = { nodes: scene.nodes, links: scene.links, onSelect: vi.fn() };
  const view = render(<Workspace {...props} />);
  const first = graph.graphData!.mock.calls.at(-1)![0];
  view.rerender(<Workspace {...props} nodes={scene.nodes.map(n => ({ ...n, fx: n.fx + 1 }))} />);
  const next = graph.graphData!.mock.calls.at(-1)![0];
  expect(next.nodes[0]).toBe(first.nodes[0]);
  expect(next.links[0]).toBe(first.links[0]);
});

it('shares visual resources across markers and releases them on unmount', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const scene = sceneAt(demoWindow, demoWindow.from + 2000, {});
  const view = render(<Workspace nodes={scene.nodes} links={scene.links} onSelect={() => {}} />);
  const make = graph.nodeThreeObject!.mock.calls.at(-1)![0] as (node: typeof scene.nodes[number]) => import('three').Mesh;
  const node = scene.nodes.find(n => n.kind === 'execution')!;
  const first = make(node), second = make({ ...node, id: 'synthetic:other' });
  expect(second.geometry).toBe(first.geometry); expect(second.material).toBe(first.material);
  const geometryDispose = vi.spyOn(first.geometry, 'dispose');
  const materialDispose = vi.spyOn(first.material as import('three').MeshBasicMaterial, 'dispose');
  view.unmount();
  expect(geometryDispose).toHaveBeenCalledTimes(1); expect(materialDispose).toHaveBeenCalledTimes(1);
});

it('frames the first nonempty scene after an empty cursor and only refits later on request', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const first = sceneAt(demoWindow, demoWindow.from + 2000, {});
  const view = render(<Workspace nodes={[]} links={[]} onSelect={() => {}} />);
  expect(graph.cameraPosition).not.toHaveBeenCalled();
  view.rerender(<Workspace nodes={first.nodes} links={first.links} onSelect={() => {}} />);
  expect(graph.cameraPosition).toHaveBeenCalledTimes(1);
  view.rerender(<Workspace nodes={[]} links={[]} onSelect={() => {}} />);
  view.rerender(<Workspace nodes={first.nodes} links={first.links} onSelect={() => {}} />);
  expect(graph.cameraPosition).toHaveBeenCalledTimes(1);
  fireEvent.click(view.getByRole('button', { name: 'Fit active workspace' }));
  expect(graph.cameraPosition).toHaveBeenCalledTimes(2);
});
