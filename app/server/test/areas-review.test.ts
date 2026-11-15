import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { runAreasCli } from '../src/cli-areas.js';
import {
  buildWeeklyReview, isoWeekOf, mergeReview, recordKpi, renderReviewBlock, resolveWeek, REVIEW_END, REVIEW_START, setProjectArchived, upsertArea, upsertProject, weekMonday,
} from '../src/projects.js';
import { resetSettings } from '../src/settings.js';
import { truncateAll } from './helpers.js';
import { at, finishedCard, indexed, note } from './helpers/tracker.js';

/**
 * The weekly review (`cli-areas review`): one file per ISO week, a generated block between
 * two markers, and everything outside the markers left to the owner.
 *
 * The fixture week is 2026-W46: Monday 2026-11-09 to Sunday 2026-11-15.
 */

const WEEK = '2026-W46';
/** The Sunday timer's moment, and a day well after the week. */
const SUNDAY_EVENING = new Date('2026-11-15T20:00:00Z');
const LATER = new Date('2026-11-20T12:00:00Z');
const unverified = 'shipped before the tracker';

const vault = (): string => {
  resetSettings();
  return mkdtempSync(join(tmpdir(), 'sb-review-'));
};
const review = async (root: string, now: Date, ...argv: string[]): Promise<string> => {
  const out: string[] = [];
  expect(await runAreasCli(['review', ...argv], { out: (l) => out.push(l), err: () => {}, now, vaultRoot: root })).toBe(0);
  return out.join('\n');
};
const area = async (r: Awaited<ReturnType<typeof buildWeeklyReview>>, slug: string) => r.areas.find((a) => a.slug === slug)!;

describe('ISO weeks', () => {
  it('names the week of a day, and the Monday of a week', () => {
    expect(isoWeekOf('2026-11-09')).toBe('2026-W46');
    expect(isoWeekOf('2026-11-15')).toBe('2026-W46');
    expect(isoWeekOf('2026-11-16')).toBe('2026-W47');
    // A week belongs to the year its Thursday is in.
    expect(isoWeekOf('2027-01-03')).toBe('2026-W53');
    expect(isoWeekOf('2024-12-30')).toBe('2025-W01');
    expect(weekMonday('2026-W46')).toBe('2026-11-09');
    expect(weekMonday('2025-W01')).toBe('2024-12-30');
    expect(() => weekMonday('2025-W53')).toThrow(/not an ISO week/);
    expect(() => weekMonday('2026-46')).toThrow(/not an ISO week/);
  });

  it('resolves the week of a run in the vault time zone, and "ending" to the week that is ending or just ended', () => {
    expect(resolveWeek(undefined, SUNDAY_EVENING, 'UTC')).toBe('2026-W46');
    // Sunday 20:00 UTC is already Monday in Tokyo.
    expect(resolveWeek(undefined, SUNDAY_EVENING, 'Asia/Tokyo')).toBe('2026-W47');
    expect(resolveWeek('ending', SUNDAY_EVENING, 'UTC')).toBe('2026-W46');
    // A run the timer missed on Sunday and caught up on Monday morning still writes the week that ended.
    expect(resolveWeek('ending', new Date('2026-11-16T06:00:00Z'), 'UTC')).toBe('2026-W46');
    expect(resolveWeek('ending', new Date('2026-11-22T20:00:00Z'), 'UTC')).toBe('2026-W47');
    expect(resolveWeek('2026-W40', SUNDAY_EVENING, 'UTC')).toBe('2026-W40');
    expect(() => resolveWeek('last', SUNDAY_EVENING, 'UTC')).toThrow(/not an ISO week/);
  });
});

describe('the weekly review', () => {
  beforeEach(truncateAll);

  /** One busy area, one quiet active area, one parked area, and work that names no area. */
  async function seed(root: string): Promise<void> {
    note(root, 'Areas/lifeos/README.md', '---\narea: lifeos\nkind: area\nkpis:\n  - {key: paying-users, name: Paying users, unit: users, target: 100, by: 2027-03-31}\n  - {key: mrr, name: MRR, unit: usd, target: 50}\n  - {key: unread, name: Never read}\n---\n\n# LifeOS\n');
    await at('2026-10-01T09:00:00Z', async () => {
      await upsertArea('lifeos', { title: 'LifeOS', home_path: 'Areas/lifeos', priority: 1 }, 'ada', { create: true });
      await upsertArea('reading', { title: 'Reading', priority: 2 }, 'ada', { create: true });
      await upsertArea('garden', { title: 'Garden', status: 'parked', priority: 3 }, 'ada', { create: true });
      await upsertProject('lifeos', 'core', { title: 'Core', stage: 'testing', due: '2026-11-20' }, 'ada', { create: true });
      await upsertProject('lifeos', 'onboarding', { title: 'Onboarding', stage: 'designing' }, 'ada', { create: true });
      await upsertProject('lifeos', 'old-sync', { title: 'Old sync', stage: 'building' }, 'ada', { create: true });
    });
    await at('2026-11-05T09:00:00Z', () => recordKpi(root, 'lifeos', { key: 'paying-users', value: 12, at: '2026-11-05T09:00:00Z' }, 'ada'));
    await at('2026-11-10T09:00:00Z', async () => {
      await upsertProject('lifeos', 'core', { stage: 'live', unverified, note: 'the golden questions pass' }, 'builder');
      await upsertProject('lifeos', 'onboarding', { stage: 'building', owner: 'builder' }, 'builder');
      await upsertProject('lifeos', 'voice', { title: 'Voice entries', stage: 'idea' }, 'ada', { create: true });
    });
    await at('2026-11-11T09:00:00Z', async () => {
      await setProjectArchived('lifeos', 'old-sync', true, 'ada', 'superseded by core');
      await recordKpi(root, 'lifeos', { key: 'mrr', value: 60, at: '2026-11-11T09:00:00Z' }, 'ada');
    });
    await at('2026-11-14T09:00:00Z', () => recordKpi(root, 'lifeos', { key: 'paying-users', value: 17, at: '2026-11-14T09:00:00Z' }, 'ada'));
    await finishedCard('t_aaaaaa', 'Retrieval: rank by recency', '2026-11-12T12:00:00Z', 'lifeos', 'core');
    await finishedCard('t_bbbbbb', 'Rotate the backup key', '2026-11-13T12:00:00Z');
    await finishedCard('t_cccccc', 'The week before', '2026-11-06T12:00:00Z', 'lifeos');
    await indexed('Areas/lifeos/notes/retrieval.md', '2026-11-12T08:00:00Z');
    await indexed('Areas/lifeos/brand/logo.svg', '2026-11-12T08:00:00Z');
    await indexed('Areas/lifeos/notes/older.md', '2026-11-02T08:00:00Z');
  }

  it('writes the block for the week: shipped, moved, new and dropped, KPIs, work, quiet areas on one line, unfiled work', async () => {
    const root = vault();
    await seed(root);
    expect(await review(root, SUNDAY_EVENING)).toBe(`wrote ${join(root, 'Areas/weekly-review/2026-W46.md')} (1 with changes, 1 quiet)`);
    await expect(readFileSync(join(root, 'Areas/weekly-review/2026-W46.md'), 'utf8')).toMatchFileSnapshot(resolve(import.meta.dirname, 'fixtures/areas-review/2026-W46.md'));

    const r = await buildWeeklyReview(root, WEEK, { now: SUNDAY_EVENING });
    expect(r).toMatchObject({ week: WEEK, from: '2026-11-09', to: '2026-11-15', timezone: 'UTC' });
    const a = await area(r, 'lifeos');
    expect(a.shipped).toEqual([`core: testing → live (UNVERIFIED: ${unverified} · the golden questions pass)`]);
    expect(a.moved).toEqual(['onboarding: designing → building']);
    expect(a.added).toEqual(['New: voice, Voice entries [idea]', 'Dropped: old-sync, archived (superseded by core)']);
    expect(a.kpis).toEqual([
      // Start of the week is the last reading before it; the distance is to the target in the home note.
      'Paying users (paying-users): 12 → 17 users (+5); 83 to the target of 100 by 2027-03-31',
      'MRR (mrr): 60 usd (first reading); target 50 reached',
    ]);
    expect(a.facts).toContain('onboarding, owner: none → builder');
    expect(a.cards).toEqual({ total: 1, rows: ['t_aaaaaa Retrieval: rank by recency (core)'] });
    // Notes changed are the markdown files under the area's home; the logo and the older note are not.
    expect(a.notes).toEqual({ total: 1, rows: ['Areas/lifeos/notes/retrieval.md'] });
    // The active area where nothing happened is one word on the Quiet line; the parked one is not listed at all.
    expect(r.areas.map((x) => x.slug)).toEqual(['lifeos']);
    expect(r.quiet).toEqual(['reading']);
    expect(r.unfiled).toEqual({ total: 1, rows: ['t_bbbbbb Rotate the backup key'] });
  });

  it('a re-run rewrites only the marked block: the Reflection and everything else outside the markers stay as written', async () => {
    const root = vault();
    await seed(root);
    const path = join(root, 'Areas/weekly-review/2026-W46.md');
    await review(root, SUNDAY_EVENING);
    const first = readFileSync(path, 'utf8');
    expect(first.startsWith('# Weekly review 2026-W46\n\n2026-11-09 to 2026-11-15\n\n## Reflection\n\n')).toBe(true);

    // The owner writes a reflection above the block and a note below it.
    const reflection = 'Core shipped. The onboarding is the next thing: it has no date yet, which is why it drifts.\n\n- decide the date on Monday\n';
    const below = '\n\n## Carried over\n\nAsk for the invoice.\n';
    const edited = first.replace('## Reflection\n\n', `## Reflection\n\n${reflection}`).trimEnd() + below;
    writeFileSync(path, edited);
    const outside = (text: string): [string, string] => [text.slice(0, text.indexOf(REVIEW_START)), text.slice(text.indexOf(REVIEW_END) + REVIEW_END.length)];
    const block = (text: string): string => text.slice(text.indexOf(REVIEW_START), text.indexOf(REVIEW_END) + REVIEW_END.length);

    // Nothing new in the tracker: the file is not written at all.
    expect(await review(root, SUNDAY_EVENING, '--week', WEEK)).toMatch(/^unchanged /);
    expect(readFileSync(path, 'utf8')).toBe(edited);

    // Something new in the week: the block changes, and not one character outside it.
    await at('2026-11-15T10:00:00Z', () => upsertProject('lifeos', 'voice', { stage: 'designing' }, 'builder'));
    expect(await review(root, SUNDAY_EVENING, '--week', WEEK)).toMatch(/^wrote /);
    const second = readFileSync(path, 'utf8');
    expect(outside(second)).toEqual(outside(edited));
    expect(second).toContain(reflection);
    expect(second).toContain('Ask for the invoice.');
    expect(block(second)).not.toBe(block(edited));
    expect(block(second)).toContain('- voice: idea → designing');
    expect(block(edited)).not.toContain('- voice: idea → designing');
    // One block, not two.
    expect(second.split(REVIEW_START)).toHaveLength(2);
    expect(second.split(REVIEW_END)).toHaveLength(2);
  });

  it('keeps a file the owner wrote first: the block goes at the end, then is replaced in place', () => {
    const r = { week: WEEK, from: '2026-11-09', to: '2026-11-15' };
    const mine = '# My week\n\n## Reflection\n\nWritten before any review ran.\n';
    const once = mergeReview(mine, `${REVIEW_START}\none\n${REVIEW_END}`, r);
    expect(once).toBe(`${mine}\n${REVIEW_START}\none\n${REVIEW_END}\n`);
    expect(mergeReview(once, `${REVIEW_START}\ntwo\n${REVIEW_END}`, r)).toBe(`${mine}\n${REVIEW_START}\ntwo\n${REVIEW_END}\n`);
  });

  it('detects slipped: a due date moved later, and a due date that passed while the project was open', async () => {
    const root = vault();
    await at('2026-10-01T09:00:00Z', async () => {
      await upsertArea('lifeos', { title: 'LifeOS' }, 'ada', { create: true });
      await upsertArea('reading', { title: 'Reading' }, 'ada', { create: true });
      const add = (slug: string, due: string | undefined, stage: 'building' | 'parked' = 'building') => upsertProject('lifeos', slug, { title: slug, stage, ...(due ? { due } : {}) }, 'ada', { create: true });
      await add('moved-later', '2026-11-10');
      await add('moved-earlier', '2026-11-30');
      await add('date-set', undefined);
      await add('passed-open', '2026-11-12');
      await add('passed-shipped', '2026-11-12');
      await add('passed-parked', '2026-11-12', 'parked');
      await add('passed-dropped', '2026-11-12');
      await add('shipped-the-week-after', '2026-11-13');
      await add('due-sunday', '2026-11-15');
      await add('due-next-week', '2026-11-18');
      await add('overdue-since-october', '2026-10-20');
      await upsertProject('reading', 'one-book', { title: 'One book', stage: 'building', due: '2026-11-11' }, 'ada', { create: true });
    });
    await at('2026-11-11T09:00:00Z', async () => {
      await upsertProject('lifeos', 'moved-later', { due: '2026-11-24', note: 'waiting on the review' }, 'builder');
      await upsertProject('lifeos', 'moved-earlier', { due: '2026-11-25' }, 'builder');
      await upsertProject('lifeos', 'date-set', { due: '2026-12-05' }, 'builder');
      await upsertProject('lifeos', 'passed-shipped', { stage: 'done', unverified }, 'builder');
      await setProjectArchived('lifeos', 'passed-dropped', true, 'ada');
    });
    // After the week: it does not change what was true at the end of it.
    await at('2026-11-17T09:00:00Z', async () => {
      await upsertProject('lifeos', 'shipped-the-week-after', { stage: 'done', unverified }, 'builder');
      await upsertProject('lifeos', 'passed-open', { due: '2026-11-30' }, 'builder');
    });

    // Read after the week is over: Sunday's due date has passed too.
    const after = await buildWeeklyReview(root, WEEK, { now: LATER });
    expect((await area(after, 'lifeos')).slipped).toEqual([
      'moved-later: due moved from 2026-11-10 to 2026-11-24 (waiting on the review)',
      'passed-open: due 2026-11-12 passed, still building',
      'shipped-the-week-after: due 2026-11-13 passed, still building',
      'due-sunday: due 2026-11-15 passed, still building',
    ]);
    // A slipped project alone makes its area worth a section, not a word on the Quiet line.
    expect((await area(after, 'reading')).slipped).toEqual(['one-book: due 2026-11-11 passed, still building']);
    expect(after.quiet).toEqual([]);

    // Read on the Sunday evening the timer runs: Sunday is not over, so its due date has not passed.
    const sunday = (await area(await buildWeeklyReview(root, WEEK, { now: SUNDAY_EVENING }), 'lifeos')).slipped;
    expect(sunday).toContain('passed-open: due 2026-11-12 passed, still building');
    expect(sunday).not.toContain('due-sunday: due 2026-11-15 passed, still building');

    // A date moved earlier or set for the first time is a changed fact, not a slip.
    const facts = (await area(after, 'lifeos')).facts;
    expect(facts).toContain('moved-earlier, due: 2026-11-30 → 2026-11-25');
    expect(facts).toContain('date-set, due: none → 2026-12-05');
    expect(renderReviewBlock(after)).toContain('**Slipped**\n\n- moved-later: due moved from 2026-11-10 to 2026-11-24 (waiting on the review)');

    // The week after: the slip of W46 is not repeated, and the date moved on Tuesday is this week's.
    const next = await buildWeeklyReview(root, '2026-W47', { now: new Date('2026-11-25T12:00:00Z') });
    expect((await area(next, 'lifeos')).slipped).toEqual([
      'passed-open: due moved from 2026-11-12 to 2026-11-30',
      'due-next-week: due 2026-11-18 passed, still building',
    ]);
  });

  it('cuts the week at midnight in the vault time zone, and writes where areas.reviewDir says', async () => {
    const root = vault();
    writeFileSync(join(root, 'secondbrain.json'), JSON.stringify({ timezone: 'Asia/Tokyo', areas: { reviewDir: 'reviews/weekly' } }));
    await at('2026-10-01T09:00:00Z', async () => {
      await upsertArea('lifeos', { title: 'LifeOS' }, 'ada', { create: true });
      await upsertProject('lifeos', 'core', { title: 'Core', stage: 'building' }, 'ada', { create: true });
    });
    // 15:30 UTC on Sunday is 00:30 on Monday in Tokyo: the next week there, this week in UTC.
    await at('2026-11-15T15:30:00Z', () => upsertProject('lifeos', 'core', { stage: 'testing' }, 'builder'));
    expect((await buildWeeklyReview(root, WEEK, { now: LATER, timezone: 'UTC' })).areas.map((a) => a.moved)).toEqual([['core: building → testing']]);
    expect((await buildWeeklyReview(root, WEEK, { now: LATER, timezone: 'Asia/Tokyo' })).areas).toEqual([]);
    expect((await buildWeeklyReview(root, '2026-W47', { now: LATER, timezone: 'Asia/Tokyo' })).areas.map((a) => a.moved)).toEqual([['core: building → testing']]);

    // The CLI reads both settings. Sunday 20:00 in Tokyo is 11:00 UTC: the timer's `--week ending` is W46.
    expect(await review(root, new Date('2026-11-15T11:00:00Z'), '--week', 'ending')).toBe(`wrote ${join(root, 'reviews/weekly/2026-W46.md')} (0 with changes, 1 quiet)`);
    const text = readFileSync(join(root, 'reviews/weekly/2026-W46.md'), 'utf8');
    expect(text).toContain('(2026-11-09 to 2026-11-15, Asia/Tokyo)');
    expect(text).toContain('Nothing changed in any area this week.');
    expect(text).toContain('**Quiet:** lifeos');
    expect(existsSync(join(root, 'Areas/weekly-review'))).toBe(false);

    // A folder outside the vault is refused.
    resetSettings();
    writeFileSync(join(root, 'secondbrain.json'), JSON.stringify({ areas: { reviewDir: '../elsewhere' } }));
    await expect(runAreasCli(['review'], { out: () => {}, err: () => {}, now: LATER, vaultRoot: root })).rejects.toThrow(/areas.reviewDir is a folder inside the vault/);
    resetSettings();
  });
});
