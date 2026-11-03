import { describe, expect, it } from 'vitest';
import { parseSettings } from '../src/settings.js';
import { readNextAction, renderCatalog } from '../src/garden/catalog.js';
import type { RuleContext } from '../src/garden/rules.js';
import { defaultMeta, type Shelf } from '../src/garden/shelves.js';
import { vault } from './helpers/garden.js';

const TODAY = '2026-11-03';
function shelf(dir: string, kind: Shelf['meta']['kind'], project = 'none'): Shelf {
  return { dir, readme: `${dir}/README.md`, exists: true, meta: { ...defaultMeta(dir, kind, TODAY), project }, body: '', foreign: {} };
}

describe('garden catalog', () => {
  it('renders one table per root, newest first', () => {
    const touched: Record<string, string> = { 'Projects/a': '2026-11-01', 'Projects/b': '2026-10-01', 'Areas/x': '2026-09-01' };
    const ctx: RuleContext = { today: TODAY, quarter: '2026Q4', lastTouched: (d) => touched[d] ?? null, trackerStage: () => null, settings: parseSettings({}).garden };
    const out = renderCatalog([shelf('Projects/b', 'project'), shelf('Areas/x', 'area'), shelf('Projects/a', 'project', 'argo-exo')], ctx, {
      noteCount: (d) => (d === 'Projects/a' ? 3 : 1),
      nextAction: (d) => (d === 'Projects/a' ? 'Ship it' : null),
    });
    expect(out).toContain('## Projects');
    expect(out).toContain('## Areas');
    expect(out).not.toContain('## Research');
    expect(out.indexOf('## Projects')).toBeLessThan(out.indexOf('## Areas'));
    expect(out).toContain('| Projects/a | active | argo-exo | 3 | 2026-11-01 | 2026-11-03 | Ship it |');
    expect(out.indexOf('| Projects/a |')).toBeLessThan(out.indexOf('| Projects/b |'));
    expect(out).toContain('| Areas/x | active | none | 1 | 2026-09-01 | 2026-11-03 |  |');
  });

  it('readNextAction reads the Resume block', async () => {
    const root = await vault({
      'Projects/a/dev-log/README.md': '# A\n\n## Resume\n- **Task:** x\n- **Next action:** Ship the thing  \n',
      'Projects/b/README.md': '# B\n',
    });
    expect(await readNextAction(root, 'Projects/a')).toBe('Ship the thing');
    expect(await readNextAction(root, 'Projects/b')).toBeNull();
  });
});
