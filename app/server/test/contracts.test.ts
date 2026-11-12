import { describe, expect, it } from 'vitest';
import { BoardBoardsResponseSchema } from '@secondbrain/contracts/board';
import { TrackerReportSchema } from '@secondbrain/contracts/projects';
import { GlobalSearchResponseSchema } from '@secondbrain/contracts/search';

const counts = { idea: 0, designing: 0, building: 0, testing: 0, live: 0, parked: 0, done: 0 };

describe('route response contracts', () => {
  it('accepts the search route response shape', () => {
    expect(GlobalSearchResponseSchema.parse({ q: 'example', mode: 'hybrid', available: ['notes'], notes: { results: [], total: 0, has_more: false } }).available).toEqual(['notes']);
  });

  it('accepts the board route response shape', () => {
    expect(BoardBoardsResponseSchema.parse({ boards: [{ slug: 'example', name: 'Example', team_slug: null, created_at: '2026-01-01T00:00:00.000Z', open: 0 }] }).boards).toHaveLength(1);
  });

  it('accepts the projects route response shape', () => {
    const response = { as_of: null, generated_at: '2026-01-01T00:00:00.000Z', totals: { projects: counts, features: counts }, needs_owner: [], divisions: [], teams: [], goals: [], gaps: { goals_uncovered: [], unverified_shipped: [], failing: [], testing_unverified: [], stale: [], overdue: [], no_team: [], no_division: [], no_features: [] }, oldest: [], backlog: { total: 0, by_project: [] }, moved_7d: [], shipped_7d: [], verified_7d: { pass: 0, fail: 0 }, projects: [] };
    expect(TrackerReportSchema.parse(response).generated_at).toBe(response.generated_at);
  });
});
