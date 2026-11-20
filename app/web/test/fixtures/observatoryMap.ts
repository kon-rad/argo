import type { ReplayWindow } from '@secondbrain/contracts/observatory';
import type { MapGraph } from '../../src/lib/mapData.js';
import { demoWindow } from '../../src/routes/observatory/demo.js';
export const mapGraph: MapGraph = { version: 7, builtAt: '2026-11-01T00:00:00Z', nodes: [{ id: 'note:1', kind: 'note', ref: 'Projects/demo.md', label: 'Demo', parent: null, color: null, size: 1, x: 3, y: 4, z: 5, meta: {} }], edges: [] };
const call = demoWindow.events.find(e => e.id === 'call')!;
export const mapWindow: ReplayWindow = { ...demoWindow, events: [
  { ...call, id: 'read', target: { path: '/srv/vault/Projects/demo.md', vaultPath: 'Projects/demo.md', operation: 'read' } },
  { ...call, id: 'write', target: { path: '/srv/vault/Projects/demo.md', vaultPath: 'Projects/demo.md', operation: 'write' }, session: 'archive:13', execution: 'run:lab:parallel' },
  { ...call, id: 'gone', target: { path: '/srv/vault/Projects/gone.md', vaultPath: 'Projects/gone.md', operation: 'edit' } },
  { ...call, id: 'repo', target: { path: 'src/demo.ts', operation: 'read' } },
] };
