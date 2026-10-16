import { describe, expect, it } from 'vitest';
import type { PlanCurrent } from '../src/lib/api.js';
import { chipPct, money } from '../src/routes/usage/format.js';

const NOW = Date.parse('2026-10-14T14:00:00Z');
const p = (over: Partial<PlanCurrent> = {}): PlanCurrent => ({
  used_pct: 41, left_pct: 59, resets_at: '2026-10-14T14:10:00Z', observed_at: '2026-10-14T13:59:00Z',
  host: 'droplet', origin: 'stream-json', reset_since_reading: false, last_pct: 41, ...over,
});

describe('chipPct', () => {
  it('shows the used percentage, rounded', () => expect(chipPct(p({ used_pct: 22.6 }), NOW)).toBe('23%'));
  it('shows a dash with no reading, or once the window has reset', () => {
    expect(chipPct(null, NOW)).toBe('-');
    expect(chipPct(p({ used_pct: null, reset_since_reading: true }), NOW)).toBe('-');
    expect(chipPct(p({ resets_at: '2026-10-14T13:00:00Z' }), NOW)).toBe('-');
  });
});

describe('money', () => {
  it('writes USD with a dollar sign and other currencies by code', () => {
    expect(money(7.9394, 'USD')).toBe('$7.94');
    expect(money(12, 'EUR')).toBe('12.00 EUR');
    expect(money(null, 'USD')).toBe('-');
  });
});
