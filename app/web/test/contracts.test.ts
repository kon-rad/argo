import { describe, expect, it } from 'vitest';
import { BoardCardsResponseSchema, BoardContractSchema } from '@secondbrain/contracts/board';
import { TrackerReportSchema } from '@secondbrain/contracts/projects';
import { SearchResponseSchema } from '@secondbrain/contracts/search';

const counts = { idea: 0, designing: 0, building: 0, testing: 0, live: 0, parked: 0, done: 0 };

describe('shared browser contracts', () => {
  it('parses a search response', () => {
    const response = SearchResponseSchema.parse({
      q: 'example', mode: 'keyword', total: 1, has_more: false,
      results: [{ source_kind: 'vault', ref_id: '1', ref_path: 'Projects/example.md', title: 'Example', snippet: '<b>example</b>', rank: 1, occurred_at: '2026-01-01T00:00:00.000Z' }],
    });
    expect(response.results[0]?.ref_path).toBe('Projects/example.md');
  });

  it('parses a board response', () => {
    expect(BoardCardsResponseSchema.parse({ cards: [] })).toEqual({ cards: [] });
  });

  it('retains a Cybazaar source job in the board contract without adding one to plain cards', () => {
    expect(BoardContractSchema.parse({ objective: 'Create reel', cybazaarJobId: 'market-job-42', deskJobRef: 'arkiv:test/job-42' })).toEqual({ objective: 'Create reel', cybazaarJobId: 'market-job-42', deskJobRef: 'arkiv:test/job-42' });
    expect(BoardContractSchema.parse({ objective: 'Internal work' })).toEqual({ objective: 'Internal work' });
  });

  it('parses a projects report response', () => {
    const response = TrackerReportSchema.parse({
      as_of: null, generated_at: '2026-01-01T00:00:00.000Z', totals: { areas: { active: 0, parked: 0 }, projects: counts }, needs_owner: [],
      divisions: [], teams: [], goals: [], gaps: { goals_uncovered: [], unverified_shipped: [], failing: [], testing_unverified: [], stale: [], overdue: [], no_team: [], no_division: [], no_projects: [] },
      oldest: [], backlog: { total: 0, by_area: [] }, moved_7d: [], shipped_7d: [], verified_7d: { pass: 0, fail: 0 }, areas: [],
    });
    expect(response.areas).toEqual([]);
  });
});
