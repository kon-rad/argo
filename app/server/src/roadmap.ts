import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import type { Board, FeatureView } from './projects.js';
import type { SecondBrainSettings } from './settings.js';

/**
 * The roadmap view: kanban cards and tracker features joined by theme.
 * Themes come from `roadmap.themes` in secondbrain.json, so the engine knows
 * none of them. The file is generated and carries a marker line; a file
 * without the marker is somebody's notes and is never overwritten.
 * No em-dashes, by house style.
 */

export const GENERATED_MARKER = '<!-- generated: cli-projects roadmap; do not edit by hand -->';

export type RoadmapSettings = SecondBrainSettings['roadmap'];
type Theme = RoadmapSettings['themes'][number];

export interface Card {
  id: string;
  title: string;
  body?: string | null;
  status: string;
  assignee: string | null;
  created_at?: number | null;
  started_at?: number | null;
  completed_at?: number | null;
  board: string;
}

export class RoadmapError extends Error {}

const run = promisify(execFile);

/** Cards from `hermes kanban --board B list --json`. Throws when the board is unreachable or unreadable, so no empty file is written. */
export async function fetchCards(s: RoadmapSettings): Promise<Card[]> {
  const out: Card[] = [];
  for (const board of s.boards) {
    let stdout: string;
    try {
      ({ stdout } = await run(s.hermesBin, ['kanban', '--board', board, 'list', '--json'], { maxBuffer: 64 * 1024 * 1024, timeout: 30_000 }));
    } catch (err) {
      throw new RoadmapError(`kanban board "${board}" unreachable: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    }
    out.push(...parseCards(stdout, board));
  }
  return out;
}

export function parseCards(json: string, board: string): Card[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new RoadmapError(`kanban board "${board}" did not return JSON`);
  }
  if (!Array.isArray(raw)) throw new RoadmapError(`kanban board "${board}" did not return a list`);
  return raw.map((c: Record<string, unknown>) => ({
    id: String(c.id),
    title: String(c.title ?? ''),
    body: typeof c.body === 'string' ? c.body : null,
    status: String(c.status ?? ''),
    assignee: typeof c.assignee === 'string' ? c.assignee : null,
    created_at: typeof c.created_at === 'number' ? c.created_at : null,
    started_at: typeof c.started_at === 'number' ? c.started_at : null,
    completed_at: typeof c.completed_at === 'number' ? c.completed_at : null,
    board,
  }));
}

const lastChange = (c: Card): number => Math.max(c.completed_at ?? 0, c.started_at ?? 0, c.created_at ?? 0);

export function cardInTheme(c: Card, t: Theme): boolean {
  if (t.cards.includes(c.id)) return true;
  const tag = `[theme:${t.id}]`.toLowerCase();
  const title = c.title.toLowerCase();
  if (title.includes(tag) || (c.body ?? '').toLowerCase().includes(tag)) return true;
  return t.keywords.some((k) => k && title.includes(k.toLowerCase()));
}

export function featureInTheme(project: string, f: FeatureView, t: Theme): boolean {
  return t.projects.includes(project) || t.features.includes(`${project}/${f.slug}`);
}

const cell = (s: string | null | undefined): string => (s ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
const date = (sec: number): string => (sec ? new Date(sec * 1000).toISOString().slice(0, 10) : '');

export interface ThemeCounts {
  id: string;
  cards: number;
  features: number;
}

export function renderRoadmap(
  cards: Card[],
  board: Board,
  s: RoadmapSettings,
  now = new Date(),
): { text: string; counts: ThemeCounts[] } {
  const out: string[] = [
    '# Roadmap',
    '### Kanban cards and tracker features by theme',
    '',
    GENERATED_MARKER,
    `**Generated at:** ${now.toISOString()} · **Tracker data as of:** ${board.as_of ?? 'no data'} · **Boards:** ${s.boards.join(', ')}`,
    '',
  ];
  const counts: ThemeCounts[] = [];
  for (const t of s.themes) {
    const tc = cards.filter((c) => cardInTheme(c, t)).sort((a, b) => lastChange(b) - lastChange(a));
    const tf: { p: string; f: FeatureView }[] = [];
    for (const p of board.projects) for (const f of p.features) if (featureInTheme(p.slug, f, t)) tf.push({ p: p.slug, f });
    tf.sort((a, b) => a.f.days_in_stage - b.f.days_in_stage);
    counts.push({ id: t.id, cards: tc.length, features: tf.length });

    out.push('---', '', `## ${t.title}`, '', `${tf.length} features, ${tc.length} tickets.`, '', '### Features', '');
    if (tf.length) {
      out.push('| Project | Feature | Stage | Days in stage | Needs you |', '|---|---|---|---|---|');
      for (const { p, f } of tf) out.push(`| ${p} | ${cell(f.title)} | ${f.stage} | ${f.days_in_stage} | ${cell(f.needs_owner)} |`);
    } else out.push('None.');
    out.push('', '### Tickets (newest change first)', '');
    if (tc.length) {
      out.push('| Id | Status | Assignee | Title | Board | Changed |', '|---|---|---|---|---|---|');
      for (const c of tc) out.push(`| ${c.id} | ${c.status} | ${c.assignee ?? ''} | ${cell(c.title)} | ${c.board} | ${date(lastChange(c))} |`);
    } else out.push('None.');
    out.push('');
  }
  if (!s.themes.length) out.push('No themes are configured: add `roadmap.themes` to secondbrain.json.', '');
  return { text: out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n', counts };
}

/** True when `path` does not exist or is a previously generated roadmap. */
export function mayOverwrite(path: string): boolean {
  try {
    return readFileSync(path, 'utf8').includes(GENERATED_MARKER);
  } catch {
    return true;
  }
}
