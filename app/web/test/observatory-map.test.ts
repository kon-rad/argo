import { expect, it } from 'vitest';
import { demoWindow } from '../src/routes/observatory/demo.js';
import { mapActivity, operationStyle } from '../src/routes/observatory/mapActivity.js';
import { readState, replayHref, writeState } from '../src/routes/observatory/model.js';
import type { MapGraph, MapNodeData } from '../src/lib/mapData.js';
const note = (id: string, ref: string): MapNodeData => ({ id, ref, kind: 'note', label: ref, parent: null, color: null, size: 1, x: 3, y: 4, z: 5, meta: {} });
export const graph: MapGraph = { version: 7, builtAt: '2026-11-01T00:00:00Z', nodes: [note('note:1', 'Projects/demo.md'), note('note:2', 'Areas/demo.md')], edges: [] };
const call = demoWindow.events.find(e => e.id === 'call')!;
const events = [
  { ...call, id: 'read', target: { path: '/srv/vault/Projects/demo.md', vaultPath: 'Projects/demo.md', operation: 'read' as const } },
  { ...call, id: 'write', target: { path: '/srv/vault/Areas/demo.md', vaultPath: 'Areas/demo.md', operation: 'edit' as const } },
  { ...call, id: 'deleted', target: { path: 'Projects/old.md', vaultPath: 'Projects/old.md', operation: 'write' as const } },
  { ...call, id: 'repo', target: { path: 'Projects/demo.md', operation: 'read' as const } },
];
it('resolves exact evidenced vault paths, retains unresolved and separate repository targets', () => {
  const activity = mapActivity(graph, events);
  expect(activity.map(a => a.node?.id)).toEqual(['note:1', 'note:2', undefined, undefined]);
  expect(activity[2]?.reason).toMatch(/missing|moved|deleted/);
  expect(activity[3]?.reason).toMatch(/scope unknown/);
  expect(activity[2]?.event.id).toBe('deleted');
  expect(mapActivity({ ...graph, nodes: [note('one', 'Projects/demo.md'), note('two', 'Projects/demo.md')] }, [events[0]!])[0]?.reason).toMatch(/ambiguous/);
  expect(mapActivity(graph, [{ ...events[0]!, target: { ...events[0]!.target, vaultPath: 'projects/demo.md' } }])[0]?.node).toBeUndefined();
});
it('uses distinct redundant read/write glyphs and preserves layout coordinates', () => {
  const before = structuredClone(graph);
  expect(operationStyle('read').glyph).toBe('○ R');
  expect(operationStyle('edit')).toEqual(operationStyle('write'));
  expect(operationStyle('read').glyph).not.toBe(operationStyle('write').glyph);
  mapActivity(graph, events);
  expect(graph).toEqual(before);
});
it('preserves cursor, selected event, note, session and pinned layout across views', () => {
  const state = { from: demoWindow.from, to: demoWindow.to, cursor: demoWindow.from + 2000, event: 'read', note: 'note:1', session: '12', layout: '7', host: 'lab' };
  const map = new URL(replayHref('map', state), 'http://localhost');
  expect(map.pathname).toBe('/map');
  expect(map.searchParams.get('activity')).toBe('1');
  expect(readState(map.searchParams, 0)).toEqual(state);
  expect(readState(new URL(replayHref('workspace', readState(map.searchParams, 0)), 'http://localhost').searchParams, 0)).toEqual(state);
  expect(writeState(state).get('layout')).toBe('7');
});

import { sceneAt } from '../src/routes/observatory/model.js';
it('filters recorded note calls and paired results without showing future activity or inferred touches', () => {
  const read = events[0]!;
  const window = { ...demoWindow, events: [read, ...demoWindow.events.filter(e => e.kind === 'tool_result').map(e => ({ ...e, parent: read.id })), events[3]!] };
  const before = sceneAt(window, window.from + 2000, { note: 'Projects/demo.md' });
  expect(before.events.map(e => e.id)).toEqual(['read']);
  expect(sceneAt(window, window.from + 4000, { note: 'Projects/demo.md' }).events.map(e => e.kind)).toEqual(['tool_call', 'tool_result']);
  expect(sceneAt(window, window.from + 1999, { note: 'Projects/demo.md' }).events).toEqual([]);
  expect(sceneAt(window, window.from + 2000, { note: 'Projects/demo.md' })).toEqual(before);
});

it('keeps origin colors consistent across read and write glyphs', () => {
  expect(operationStyle('write', 'agent').color).toBe(operationStyle('read', 'agent').color);
  expect(operationStyle('read', 'human').color).not.toBe(operationStyle('read', 'agent').color);
  expect(operationStyle('write', 'unknown').color).toBe(operationStyle('read', 'unknown').color);
});
