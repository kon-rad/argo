import { describe, expect, it } from 'vitest';
import { parseSettings } from '../src/settings.js';

describe('garden settings', () => {
  it('garden defaults', () => {
    const s = parseSettings({});
    expect(s.garden.roots).toEqual(['Projects', 'Areas', 'Research']);
    expect(s.garden.archiveDir).toBe('Archives');
    expect(s.garden.catalogFile).toBe('CURRENT/catalog.md');
    expect(s.garden.reportDir).toBe('garden/reports');
    expect(s.garden.shelfFile).toBe('README.md');
    expect(s.garden.projectArchiveAfterDays).toBe(90);
    expect(s.garden.areaProposeAfterDays).toBe(180);
    expect(s.garden.maxMoves).toBe(25);
    expect(s.garden.maxRenames).toBe(5);
    expect(s.garden.pinned).toEqual([]);
    expect(s.garden.apply).toBe(false);
  });

  it('garden overrides', () => {
    const s = parseSettings({ garden: { maxMoves: 3, pinned: ['Areas/x'], apply: true } });
    expect(s.garden.maxMoves).toBe(3);
    expect(s.garden.pinned).toEqual(['Areas/x']);
    expect(s.garden.apply).toBe(true);
    expect(s.garden.roots).toEqual(['Projects', 'Areas', 'Research']);
  });
});
