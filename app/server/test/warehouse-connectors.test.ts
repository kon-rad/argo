import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isDue, lastScheduledAt, loadConnectors, nextScheduledAt, parseEvery } from '../src/addons/warehouse/connectors.js';

function dataDir(entries: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'data-conn-'));
  for (const [name, json] of Object.entries(entries)) {
    mkdirSync(join(d, 'connectors', name), { recursive: true });
    writeFileSync(join(d, 'connectors', name, 'connector.json'), json);
  }
  return d;
}

describe('loadConnectors', () => {
  it('loads good definitions and lists broken ones without throwing', () => {
    const d = dataDir({
      good: JSON.stringify({ name: 'good', command: ['node', 'run.mjs'], schedule: { every: '1d', at: '03:10' }, tables: ['t'] }),
      broken: '{ not json',
      wrongname: JSON.stringify({ name: 'other', command: ['x'] }),
      badsched: JSON.stringify({ name: 'badsched', command: ['x'], schedule: { every: '1x' } }),
    });
    const { defs, errors } = loadConnectors(d);
    expect(defs.map((x) => x.name)).toEqual(['good']);
    expect(defs[0]).toMatchObject({ timeoutSec: 900, enabled: true, env: [], config: {} });
    expect(errors.map((e) => e.name).sort()).toEqual(['badsched', 'broken', 'wrongname']);
    expect(errors.find((e) => e.name === 'broken')!.error).toMatch(/connector.json/);
  });

  it('returns nothing for a vault without a data folder', () => {
    expect(loadConnectors('/nonexistent/x')).toEqual({ defs: [], errors: [] });
  });
});

describe('schedule', () => {
  it('parses intervals', () => {
    expect(parseEvery('15m')).toBe(900_000);
    expect(parseEvery('6h')).toBe(21_600_000);
    expect(() => parseEvery('1x')).toThrow(/bad schedule/);
  });

  it('daily at 03:10 UTC: before 03:10 the last slot is yesterday', () => {
    const s = { every: '1d', at: '03:10' };
    expect(lastScheduledAt(s, new Date('2026-11-17T03:00:00Z')).toISOString()).toBe('2026-11-16T03:10:00.000Z');
    expect(lastScheduledAt(s, new Date('2026-11-17T05:00:00Z')).toISOString()).toBe('2026-11-17T03:10:00.000Z');
    expect(nextScheduledAt(s, new Date('2026-11-17T05:00:00Z')).toISOString()).toBe('2026-11-18T03:10:00.000Z');
  });

  it('6h slots anchor at midnight UTC', () => {
    expect(lastScheduledAt({ every: '6h' }, new Date('2026-11-17T13:59:00Z')).toISOString()).toBe('2026-11-17T12:00:00.000Z');
  });

  it('is due when never run or not run since the last slot', () => {
    const s = { every: '1d', at: '03:10' };
    const now = new Date('2026-11-17T05:00:00Z');
    expect(isDue(s, null, now)).toBe(true);
    expect(isDue(s, new Date('2026-11-17T03:00:00Z'), now)).toBe(true);
    expect(isDue(s, new Date('2026-11-17T03:11:00Z'), now)).toBe(false);
    expect(isDue(undefined, null, now)).toBe(false);
  });
});
