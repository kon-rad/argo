import { describe, expect, it } from 'vitest';
import { parseSettings } from '../src/settings.js';
import { kebab, planLoose, planShelves, quarterOf, type RuleContext } from '../src/garden/rules.js';
import { defaultMeta, type Shelf, type ShelfKind } from '../src/garden/shelves.js';

const TODAY = '2026-11-03';

function shelf(dir: string, over: Partial<Shelf['meta']> = {}): Shelf {
  const kind: ShelfKind = dir.startsWith('Projects/') ? 'project' : dir.startsWith('Areas/') ? 'area' : 'resource';
  return { dir, readme: `${dir}/README.md`, exists: true, meta: { ...defaultMeta(dir, kind, TODAY), ...over }, body: '', foreign: {} };
}

function daysAgo(n: number): string {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function ctx(over: Partial<RuleContext> = {}, settings: Record<string, unknown> = {}): RuleContext {
  return {
    today: TODAY,
    quarter: '2026Q4',
    lastTouched: () => TODAY,
    trackerStage: () => null,
    settings: parseSettings({ garden: settings }).garden,
    ...over,
  };
}

describe('garden rules', () => {
  it('archives a project untouched 91 days, keeps one untouched 89 days', () => {
    const touched: Record<string, string> = { 'Projects/old': daysAgo(91), 'Projects/fresh': daysAgo(89) };
    const out = planShelves([shelf('Projects/old'), shelf('Projects/fresh')], ctx({ lastTouched: (d) => touched[d] ?? null }));
    expect(out).toEqual([{ type: 'archive', from: 'Projects/old', to: 'Archives/2026Q4/projects/old', reason: 'untouched 91d' }]);
  });

  it('archives a project with no history', () => {
    const out = planShelves([shelf('Projects/ghost')], ctx({ lastTouched: () => null }));
    expect(out[0]).toMatchObject({ type: 'archive', reason: 'no history' });
  });

  it('parked project archives even if touched', () => {
    const out = planShelves([shelf('Projects/x', { project: 'lifeos' })], ctx({ trackerStage: (s) => (s === 'lifeos' ? 'parked' : null) }));
    expect(out).toEqual([{ type: 'archive', from: 'Projects/x', to: 'Archives/2026Q4/projects/x', reason: 'tracker: parked' }]);
  });

  it('pin stops archive, and so does status archived or a settings pin', () => {
    const c = ctx({ lastTouched: () => null }, { pinned: ['Projects/c'] });
    const out = planShelves([shelf('Projects/a', { pin: true }), shelf('Projects/b', { status: 'archived' }), shelf('Projects/c')], c);
    expect(out).toEqual([]);
  });

  it('default archive_after follows the settings', () => {
    const out = planShelves([shelf('Projects/p')], ctx({ lastTouched: () => daysAgo(50) }, { projectArchiveAfterDays: 45 }));
    expect(out[0]).toMatchObject({ type: 'archive', reason: 'untouched 50d' });
  });

  it('honours archive_after on the shelf', () => {
    const out = planShelves([shelf('Projects/slow', { archive_after: '400d' }), shelf('Projects/never', { archive_after: 'never' })], ctx({ lastTouched: () => daysAgo(200) }));
    expect(out).toEqual([]);
  });

  it('area is proposed not moved', () => {
    const out = planShelves([shelf('Areas/quiet'), shelf('Areas/owned', { project: 'argo-exo' })], ctx({ lastTouched: () => daysAgo(200) }));
    expect(out).toEqual([{ type: 'propose-archive', dir: 'Areas/quiet', reason: 'untouched 200d' }]);
  });

  it('resource is never archived by age', () => {
    expect(planShelves([shelf('Research/ai')], ctx({ lastTouched: () => null }))).toEqual([]);
  });

  it('renames non-kebab folders up to the cap', () => {
    const bad = ['Areas/GOALS', 'Areas/Models Research', 'Areas/GLOBAL_BUILDERS_CLUB', 'Areas/SELF', 'Projects/SecondBrain', 'Projects/Fence4U', 'Areas/HEALTH'];
    const out = planShelves(bad.map((d) => shelf(d)), ctx());
    expect(out.filter((a) => a.type === 'rename')).toHaveLength(5);
    expect(out.filter((a) => a.type === 'report')).toHaveLength(2);
    expect(out[0]).toEqual({ type: 'rename', from: 'Areas/GOALS', to: 'Areas/goals', reason: 'name not kebab-case' });
    expect(out.find((a) => a.type === 'rename' && a.from === 'Areas/Models Research')).toMatchObject({ to: 'Areas/models-research' });
  });

  it('caps moves', () => {
    const shelves = Array.from({ length: 30 }, (_, i) => shelf(`Projects/p${i}`));
    const out = planShelves(shelves, ctx({ lastTouched: () => null }));
    expect(out.filter((a) => a.type === 'archive')).toHaveLength(25);
    expect(out.filter((a) => a.type === 'report' && a.reason === 'over cap')).toHaveLength(5);
  });

  it('planLoose reports root-level notes', () => {
    expect(planLoose(['Research/loose.md', 'stray.md'], ctx())).toEqual([
      { type: 'report', path: 'Research/loose.md', reason: 'loose note, file it into a shelf' },
      { type: 'report', path: 'stray.md', reason: 'loose note, file it into a shelf' },
    ]);
  });

  it('kebab and quarterOf', () => {
    expect(kebab('Models Research')).toBe('models-research');
    expect(kebab('GLOBAL_BUILDERS_CLUB')).toBe('global-builders-club');
    expect(kebab('Fence4U')).toBe('fence4u');
    expect(kebab('SecondBrain')).toBe('second-brain');
    expect(kebab('dj-mixing-producing')).toBe('dj-mixing-producing');
    expect(quarterOf('2026-11-03')).toBe('2026Q4');
    expect(quarterOf('2026-01-15')).toBe('2026Q1');
  });
});
