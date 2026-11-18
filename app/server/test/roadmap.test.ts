import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cardInTheme, fetchCards, GENERATED_MARKER, mayOverwrite, parseCards, renderRoadmap, RoadmapError, type RoadmapSettings } from '../src/roadmap.js';
import type { Board } from '../src/projects.js';
import { query } from '../src/db.js';
import { parseSettings } from '../src/settings.js';

const rs: RoadmapSettings = parseSettings({
  roadmap: {
    boards: ['exo'],
    themes: [
      { id: 'engine', title: 'Open-source engine', areas: ['secondbrain-app'], keywords: ['public engine'] },
      { id: 'agents', title: 'Agent collaboration', projects: ['agent-company/board'], cards: ['t_3'] },
    ],
  },
}).roadmap;

const feature = (slug: string, days: number) =>
  ({ slug, title: `Feature ${slug}`, stage: 'building', days_in_stage: days, needs_owner: null }) as never;

const board = {
  as_of: '2026-10-21T00:00:00Z',
  areas: [
    { slug: 'secondbrain-app', projects: [feature('public-engine', 7), feature('calendar', 1)] },
    { slug: 'agent-company', projects: [feature('board', 3), feature('dispatcher', 3)] },
  ],
} as unknown as Board;

const cards = parseCards(
  JSON.stringify([
    { id: 't_1', title: 'Publish the Public Engine docs', status: 'done', assignee: 'rune', created_at: 100, completed_at: 300 },
    { id: 't_2', title: 'Unrelated', status: 'ready', assignee: 'sable', created_at: 200 },
    { id: 't_3', title: 'Reviewer loop', status: 'running', assignee: 'vera', created_at: 400 },
    { id: 't_4', title: 'Tagged [theme:engine]', status: 'ready', assignee: null, created_at: 500 },
  ]),
  'exo',
);

describe('roadmap', () => {
  it('reads all cards from the configured master board and preserves change timestamps', async () => {
    await query(`INSERT INTO org_agents(name, runtime, role, org_version) VALUES ('roadmap-owner', 'human', 'owner', 'test')`);
    await query(`INSERT INTO boards(slug, name) VALUES ('roadmap-test', 'Roadmap fixture')`);
    await query(`INSERT INTO cards(id, board_slug, title, status, created_by, created_at)
      VALUES ('t_abc12345', 'roadmap-test', 'Ship the roadmap', 'todo', 'roadmap-owner', '2026-10-21T00:00:00Z')`);
    const got = await fetchCards({ ...rs, boards: ['roadmap-test'] });
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ id: 't_abc12345', board: 'roadmap-test', created_at: Date.parse('2026-10-21T00:00:00Z') / 1000 });
  });
  it('matches cards by keyword, id and [theme:id] tag', () => {
    expect(cards.filter((c) => cardInTheme(c, rs.themes[0]!)).map((c) => c.id).sort()).toEqual(['t_1', 't_4']);
    expect(cards.filter((c) => cardInTheme(c, rs.themes[1]!)).map((c) => c.id)).toEqual(['t_3']);
  });

  it('renders one section per theme, newest ticket first, with counts', () => {
    const { text, counts } = renderRoadmap(cards, board, rs, new Date('2026-10-21T12:00:00Z'));
    expect(counts).toEqual([
      { id: 'engine', cards: 2, projects: 2 },
      { id: 'agents', cards: 1, projects: 1 },
    ]);
    expect(text).toContain(GENERATED_MARKER);
    expect(text).toContain('**Generated at:** 2026-10-21T12:00:00.000Z');
    expect(text.indexOf('t_4')).toBeLessThan(text.indexOf('t_1'));
    expect(text).not.toContain('Unrelated');
    expect(text).not.toContain('—');
  });

  it('fails instead of returning an empty list when the kanban is unreachable or not JSON', async () => {
    await expect(fetchCards({ ...rs, boards: ['does-not-exist'] })).rejects.toThrow(RoadmapError);
    expect(() => parseCards('not json', 'exo')).toThrow(RoadmapError);
  });

  it('never overwrites a hand-written file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roadmap-'));
    const mine = join(dir, 'roadmap.md');
    writeFileSync(mine, '# My roadmap\n');
    expect(mayOverwrite(mine)).toBe(false);
    const gen = join(dir, 'gen.md');
    writeFileSync(gen, renderRoadmap(cards, board, rs).text);
    expect(mayOverwrite(gen)).toBe(true);
    expect(mayOverwrite(join(dir, 'missing.md'))).toBe(true);
  });
});
