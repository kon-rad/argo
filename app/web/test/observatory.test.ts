import { describe, it, expect } from 'vitest';
import { readState, writeState, sceneAt, originStyle, eventLink, stepCursor } from '../src/routes/observatory/model.js';
import { demoWindow } from '../src/routes/observatory/demo.js';
describe('Observatory workspace evidence', () => {
  it('restores range, cursor, filters and selection from URL', () => {
    const state = readState(new URLSearchParams('from=1000&to=9000&cursor=2000&host=lab&session=12&ticket=demo&runtime=codex&persona=builder&model=demo-model&origin=human&event=call&demo=1'), 9999);
    expect(readState(writeState(state), 9999)).toEqual(state);
    expect(readState(new URLSearchParams('from=NaN&to=-1&cursor=Infinity'), 9999).cursor).toBe(9998);
  });
  it('encodes provenance with color and shape, never prompt role', () => {
    expect(originStyle('human')).toEqual({ color: '#fbbf24', shape: 'diamond', glyph: '◆ H' });
    expect(originStyle('agent').color).toBe('#22d3ee');
    expect(originStyle('automation').shape).toBe('box');
    expect(originStyle('unknown').shape).toBe('hollow');
    expect(sceneAt(demoWindow, demoWindow.from + 1100, {}).events.find(e => e.id === 'scheduler')?.actor.kind).toBe('automation');
  });
  it('removes execution and edges exactly at end and hides idle gaps', () => {
    const t = demoWindow.from;
    const before = sceneAt(demoWindow, t + 4999, {});
    expect(before.active).toHaveLength(2);
    const ended = sceneAt(demoWindow, t + 5000, {});
    expect(ended.active.map(i => i.id)).toEqual(['run:lab:parallel']);
    expect(ended.links.every(l => l.source !== 'run:lab:first' && l.target !== 'run:lab:first')).toBe(true);
    expect(sceneAt(demoWindow, t + 7000, {}).active).toEqual([]);
    expect(sceneAt(demoWindow, t + 12000, {}).active.map(i => i.id)).toEqual(['run:lab:resumed']);
    expect(sceneAt(demoWindow, t + 4999, {})).toEqual(before);
  });
  it('cuts results off at cursor and preserves truth under filters', () => {
    const t = demoWindow.from;
    expect(sceneAt(demoWindow, t + 2000, {}).tools.call).toBe('pending');
    expect(sceneAt(demoWindow, t + 2000, {}).events.some(e => e.id === 'result')).toBe(false);
    expect(sceneAt(demoWindow, t + 4000, {}).tools.call).toBe('success');
    expect(sceneAt(demoWindow, t + 2000, { origin: 'human' }).events.every(e => e.actor.kind === 'human')).toBe(true);
    expect(stepCursor(demoWindow, t + 2000, 1)).toBe(t + 4000);
    expect(stepCursor(demoWindow, t + 4000, -1)).toBe(t + 2000);
  });
  it('links recorded source and exact part', () => {
    expect(eventLink(demoWindow.events.find(e => e.id === 'call')!)).toBe('/usage/session/lab/demo-session?source=codex&part=2%3Acall');
    expect(eventLink(demoWindow.events.find(e => e.id === 'human')!)).toBeNull();
  });
});

it('seeks the full synthetic human, execution, ticket, write, commit and gate trace in both directions', () => {
  const t = demoWindow.from;
  const before = sceneAt(demoWindow, t + 12000, {});
  expect(before.events.find(e => e.id === 'write-call')?.parent).toBe('human');
  expect(before.active.find(i => i.id === 'run:lab:resumed')?.ticket).toBe('demo-ticket');
  expect(before.events.find(e => e.id === 'write-result')).toBeUndefined();
  const captured = sceneAt(demoWindow, t + 12500, {});
  expect(captured.events.find(e => e.id === 'write-result')?.change?.path).toBe('notes/demo.md');
  expect(captured.nodes.some(n => n.kind === 'file' && n.label.includes('captured-diff'))).toBe(true);
  expect(captured.events.some(e => e.change?.commit)).toBe(false);
  expect(sceneAt(demoWindow, t + 14000, {}).events.find(e => e.id === 'commit-result')?.change?.commit?.authorship).toBe('unknown');
  expect(sceneAt(demoWindow, t + 18500, {}).events.at(-1)?.artifact?.stage).toBe('merge-verified');
  expect(sceneAt(demoWindow, t + 18500, {}).active).toEqual([]);
  expect(sceneAt(demoWindow, t + 12000, {})).toEqual(before);
});

it('separates identically named files in two recorded worktrees', () => {
  const result = demoWindow.events.find(e => e.id === 'write-result')!;
  const w = { ...demoWindow, events: [...demoWindow.events, { ...result, id: 'peer-result', change: { ...result.change!, worktree: '9'.repeat(64) } }] };
  const files = sceneAt(w, demoWindow.from + 12500, {}).nodes.filter(n => n.kind === 'file' && n.label.includes('captured-diff'));
  expect(new Set(files.map(n => n.id)).size).toBe(2);
});

it.each([{ ticket: 'demo-ticket' }, { persona: 'builder' }, { model: 'fixture-model' }])('retains historical events after end under %j', filters => {
  const w = structuredClone(demoWindow);
  w.events.push({ ...w.events[2]!, id: 'usage', kind: 'usage', at: w.from + 1500, usage: { model: 'fixture-model', input: 0, output: 0, reasoning: 0 } });
  for (const offset of [4999, 7000]) {
    const scene = sceneAt(w, w.from + offset, filters);
    expect(scene.events.some(e => e.id === 'call')).toBe(true);
    if (offset === 7000) { expect(scene.active).toEqual([]); expect(scene.links).toEqual([]); }
  }
});

import { activityWindow } from '../src/routes/usage/activity.js';
it('opens later session evidence and uses recorded steps when start is missing', () => {
  const start = '2026-01-01T00:00:00Z', end = '2026-01-01T03:00:00Z';
  for (const started_at of [start, null]) {
    const link = activityWindow({ id: 12, host: 'lab', started_at, ended_at: null }, [{ ts: end }])!;
    const state = readState(new URLSearchParams(link.split('?')[1]), 9999);
    expect(state.cursor).toBe(Date.parse(end)); expect(state.to).toBeGreaterThan(Date.parse(end));
    expect(state.to - state.from).toBeLessThanOrEqual(86400000);
    const evidence = { ...demoWindow.events[2]!, at: Date.parse(end) };
    expect(sceneAt({ ...demoWindow, from: state.from, to: state.to, events: [evidence] }, state.cursor, { session: state.session }).events).toEqual([evidence]);
  }
  expect(activityWindow({ id: 12, host: 'lab', started_at: null, ended_at: null }, [])).toBeNull();
});

it('namespaces opaque local worktree identities by recorded host', () => {
  const result = demoWindow.events.find(e => e.id === 'write-result')!;
  const peer = { ...result, id: 'other-host-result', execution: 'run:other:resumed', context: { ...result.context!, host: 'other' } };
  const interval = { ...demoWindow.intervals.find(i => i.id === 'run:lab:resumed')!, id: peer.execution, host: 'other' };
  const w = { ...demoWindow, intervals: [...demoWindow.intervals, interval], events: [...demoWindow.events, peer] };
  expect(sceneAt(w, w.from + 12500, {}).nodes.filter(n => n.kind === 'file' && n.label.includes('captured-diff'))).toHaveLength(2);
});
