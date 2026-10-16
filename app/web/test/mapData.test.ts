import { describe, expect, it } from 'vitest';
import { ageDays, formatValue, metricLabel, nodeColor, recency, type MapMetric, type MapNodeData } from '../src/lib/mapData.js';

const metric = (over: Partial<MapMetric>): MapMetric => ({
  key: 'k', label: 'Thing', unit: 'followers', currency: null, money: false, goal: null, target: null,
  value: null, sampledAt: null, source: null, placeholder: false, headline: false, series: [], ...over,
});
const node = (over: Partial<MapNodeData>): MapNodeData => ({
  id: 'n', kind: 'note', label: 'n', ref: null, parent: null, color: null, size: 1, x: 0, y: 0, z: 0, meta: {}, ...over,
});

describe('brain map labels', () => {
  it('says "no data" or "not tracked yet", never 0', () => {
    expect(formatValue(metric({}))).toBe('no data');
    expect(formatValue(metric({ placeholder: true }))).toBe('not tracked yet');
  });

  it('shows money with its currency, and progress toward a target', () => {
    expect(formatValue(metric({ unit: 'usd', currency: 'USD', money: true, value: 1234.5 }))).toBe('1,235 USD');
    expect(metricLabel(metric({ label: 'Argo followers', value: 79, target: 100_000 }))).toBe('Argo followers: 79 · 0.08% of 100,000');
  });

  it('a kiosk money metric (value stripped) shows only its name', () => {
    expect(metricLabel(metric({ label: 'Argo Fund Safe', unit: 'usd', money: true, value: null }))).toBe('Argo Fund Safe');
  });

  it('dims old notes and colours notes by division', () => {
    const now = Date.parse('2026-10-15T00:00:00Z');
    expect(recency(node({ meta: { mtime: '2026-10-15T00:00:00Z' } }), now)).toBeCloseTo(1);
    expect(recency(node({ meta: { mtime: '2026-01-01T00:00:00Z' } }), now)).toBeLessThan(0.4);
    // A division keeps the same hue on every render.
    expect(nodeColor(node({ color: 'hardware' }))).toBe(nodeColor(node({ color: 'hardware' })));
    expect(nodeColor(node({ color: 'hardware' }))).toMatch(/^#[0-9a-f]{6}$/);
    expect(nodeColor(node({ kind: 'feature', color: 'live' }))).toBe('#34d399');
  });

  it('ages readings in whole days', () => {
    expect(ageDays(metric({ sampledAt: '2026-10-12T00:00:00Z' }), Date.parse('2026-10-15T01:00:00Z'))).toBe(3);
  });
});
