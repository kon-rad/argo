import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cardInTheme, fetchCards, GENERATED_MARKER, mayOverwrite, parseCards, renderRoadmap, RoadmapError, type RoadmapSettings } from '../src/roadmap.js';
import type { Board } from '../src/projects.js';
import { parseSettings } from '../src/settings.js';

const rs: RoadmapSettings = parseSettings({
  roadmap: {
    boards: ['exo'],
    themes: [
      { id: 'engine', title: 'Open-source engine', projects: ['secondbrain-app'], keywords: ['public engine'] },
      { id: 'agents', title: 'Agent collaboration', features: ['agent-company/board'], cards: ['t_3'] },
    ],
  },
}).roadmap;

const feature = (slug: string, days: number) =>
  ({ slug, title: `Feature ${slug}`, stage: 'building', days_in_stage: days, needs_owner: null }) as never;

const board = {
  as_of: '2026-10-21T00:00:00Z',
  projects: [
    { slug: 'secondbrain-app', features: [feature('public-engine', 7), feature('calendar', 1)] },
    { slug: 'agent-company', features: [feature('board', 3), feature('dispatcher', 3)] },
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
  it('matches cards by keyword, id and [theme:id] tag', () => {
    expect(cards.filter((c) => cardInTheme(c, rs.themes[0]!)).map((c) => c.id).sort()).toEqual(['t_1', 't_4']);
    expect(cards.filter((c) => cardInTheme(c, rs.themes[1]!)).map((c) => c.id)).toEqual(['t_3']);
  });

  it('renders one section per theme, newest ticket first, with counts', () => {
    const { text, counts } = renderRoadmap(cards, board, rs, new Date('2026-10-21T12:00:00Z'));
    expect(counts).toEqual([
      { id: 'engine', cards: 2, features: 2 },
      { id: 'agents', cards: 1, features: 1 },
    ]);
    expect(text).toContain(GENERATED_MARKER);
    expect(text).toContain('**Generated at:** 2026-10-21T12:00:00.000Z');
    expect(text.indexOf('t_4')).toBeLessThan(text.indexOf('t_1'));
    expect(text).not.toContain('Unrelated');
    expect(text).not.toContain('—');
  });

  it('fails instead of returning an empty list when the kanban is unreachable or not JSON', async () => {
    await expect(fetchCards({ ...rs, hermesBin: '/nonexistent/hermes' })).rejects.toThrow(RoadmapError);
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
