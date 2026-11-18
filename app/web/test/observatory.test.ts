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
