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

import { mapGraph } from './fixtures/observatoryMap.js';
it('replays the synthetic captured write on the exact pinned note and removes it on reverse seek', () => {
  const at = (offset: number) => mapActivity(mapGraph, sceneAt(demoWindow, demoWindow.from + offset, { note: 'Projects/demo.md' }).events);
  expect(at(12500).find(a => a.event.id === 'write-result')).toMatchObject({ node: { id: 'note:1', ref: 'Projects/demo.md' }, event: { change: { level: 'captured-diff' } } });
  expect(at(12499).some(a => a.event.change)).toBe(false);
  expect(at(11999)).toEqual([]);
  expect(at(12500).find(a => a.event.id === 'write-result')?.node?.id).toBe('note:1');
});

it('shows paired reported-success without capture, including inherited targets, and reverses honestly', () => {
  const call = demoWindow.events.find(e => e.id === 'write-call')!;
  const result = { ...demoWindow.events.find(e => e.id === 'write-result')!, change: undefined };
  const window = { ...demoWindow, events: [call, result] };
  const at = (offset: number) => mapActivity(mapGraph, sceneAt(window, window.from + offset, {}).events);
  expect(at(12499).map(a => a.event.id)).toEqual([call.id]);
  expect(at(12500).find(a => a.event.id === result.id)).toMatchObject({ node: { id: 'note:1' }, event: { writeEvidence: 'tool-reported-success' } });
  expect(at(12500).every(a => !a.event.change)).toBe(true);
  expect(at(12499).map(a => a.event.id)).toEqual([call.id]);
  const inherited = mapActivity(mapGraph, [call, { ...result, target: undefined }]);
  expect(inherited.find(a => a.event.id === result.id)?.node?.id).toBe('note:1');
  for (const bad of [{ ...result, outcome: 'error' as const }, { ...result, parent: undefined }, { ...result, parent: 'unrecorded-call' }])
    expect(mapActivity(mapGraph, [call, bad]).map(a => a.event.id)).toEqual([call.id]);
});

it('retains only exact prior capture scope for the real commit target fallback', () => {
  const call = demoWindow.events.find(e => e.id === 'write-call')!;
  const result = demoWindow.events.find(e => e.id === 'write-result')!;
  const inspect = demoWindow.events.find(e => e.id === 'commit-call')!;
  const commit = { ...demoWindow.events.find(e => e.id === 'commit-result')!, target: { path: result.change!.path, operation: 'edit' as const } };
  const events = [call, result, inspect, commit];
  expect(mapActivity(mapGraph, events).find(a => a.event.id === commit.id)?.node?.id).toBe('note:1');
  for (const changed of [
    { ...commit, change: { ...commit.change!, id: 'unrelated-capture' } },
    { ...commit, change: { ...commit.change!, worktree: '9'.repeat(64) } },
    { ...commit, context: { ...commit.context!, host: 'other-host' } },
    { ...commit, target: { path: 'Projects/other.md', operation: 'edit' as const } },
  ]) expect(mapActivity(mapGraph, [call, result, inspect, changed]).find(a => a.event.id === commit.id)?.node).toBeUndefined();
  // The earlier cursor cannot borrow the scope of a later captured write result.
  expect(mapActivity(mapGraph, [inspect, commit]).find(a => a.event.id === commit.id)?.node).toBeUndefined();
  expect(mapActivity(mapGraph, [call, result, inspect]).some(a => a.event.id === commit.id)).toBe(false);
});

it('keeps validated causal context for a note-filtered commit without displaying unrelated parents', () => {
  const scene = sceneAt(demoWindow, demoWindow.from + 14000, { note: 'Projects/demo.md' });
  expect(scene.events.some(e => e.id === 'commit-call')).toBe(false);
  const activity = mapActivity(mapGraph, scene.events, scene.contextEvents);
  expect(activity.find(a => a.event.id === 'commit-result')).toMatchObject({ node: { id: 'note:1' }, event: { change: { level: 'commit' } } });
  const before = sceneAt(demoWindow, demoWindow.from + 13999, { note: 'Projects/demo.md' });
  expect(mapActivity(mapGraph, before.events, before.contextEvents).some(a => a.event.id === 'commit-result')).toBe(false);
});

it('preserves an authoritative paired result whose call precedes the requested window', () => {
  const original = demoWindow.events.find(e => e.id === 'write-call')!;
  const parent = `${original.source.table}:${original.source.id}:${original.source.part}`;
  const result = { ...demoWindow.events.find(e => e.id === 'write-result')!, parent, occurrence: parent, change: undefined };
  const boundary = { tickets: {}, tools: { [parent]: 'pending' }, provenance: { [`tool:${parent}`]: { event: parent, source: original.source, at: original.at } } };
  const window = { ...demoWindow, from: demoWindow.from + 12100, boundary, events: [result] };
  const before = sceneAt(window, demoWindow.from + 12499, {});
  expect(before.tools[parent]).toBe('pending');
  expect(mapActivity(mapGraph, before.events, before.contextEvents, before.evidenceContext)).toEqual([]);
  const after = sceneAt(window, result.at!, {});
  expect(after.nodes.find(n => n.kind === 'file')?.label).toContain('(tool-reported-success)');
  expect(mapActivity(mapGraph, after.events, after.contextEvents, after.evidenceContext)[0]?.node?.id).toBe('note:1');
  const reversed = sceneAt(window, demoWindow.from + 12499, {});
  expect(reversed.tools[parent]).toBe('pending');
  expect(reversed.nodes.some(n => n.kind === 'file')).toBe(false);
  for (const badBoundary of [
    { ...boundary, provenance: {} },
    { ...boundary, tools: {} },
    { ...boundary, provenance: { [`tool:${parent}`]: { event: 'different-call', source: original.source, at: original.at } } },
  ]) {
    const bad = sceneAt({ ...window, boundary: badBoundary }, result.at!, {});
    expect(bad.nodes.some(n => n.label.includes('tool-reported-success'))).toBe(false);
    expect(mapActivity(mapGraph, bad.events, bad.contextEvents, bad.evidenceContext)).toEqual([]);
  }
});
