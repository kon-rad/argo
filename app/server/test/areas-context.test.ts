import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { AreaContextSchema } from '@secondbrain/contracts/projects';
import { createApp } from '../src/app.js';
import { runAreasCli } from '../src/cli-areas.js';
import { buildAreaContext, firstSection, recordKpi, renderContextText, setProjectArchived, TEXT_BUDGET, upsertArea, upsertProject } from '../src/projects.js';
import { ALL_MODULES, truncateAll } from './helpers.js';
import { at, finishedCard, indexed, note } from './helpers/tracker.js';

/**
 * The context pack (`cli-areas show`, `GET /api/areas/:slug/context`): what an agent reads
 * before it works on an area. The text and the JSON of two fixture areas, one with KPIs and
 * one without, are kept as files under fixtures/areas-context.
 */

const NOW = new Date('2026-11-20T00:00:00Z');
const fixture = (name: string): string => resolve(import.meta.dirname, 'fixtures/areas-context', name);

const HOME = `---
area: lifeos
kind: area
description: A private journal that answers questions about your own life
links:
  websites: [https://lifeos.example.com]
  repos: [example/lifeos]
  socials: Areas/lifeos/social-channels.md
style:
  guide: Areas/lifeos/brand/style-guide.md
  assets: Areas/lifeos/brand/assets/
goals:
  - A hundred people pay for it
  - Every answer cites the entry it came from
kpis:
  - {key: paying-users, name: Paying users, unit: users, target: 100, by: 2027-03-31}
  - {key: mrr, name: MRR, unit: usd}
---

# LifeOS

The journal is the product. Everything else here serves it:
the apps, the brand and the server.

Entries stay encrypted on the device.

## Standards

Not part of the first section.
`;

/** An area with a home note, KPIs, a roadmap and two weeks of history; and one with a bare home note and nothing else. */
async function seed(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'sb-context-'));
  note(root, 'Areas/lifeos/README.md', HOME);
  note(root, 'Areas/lifeos/projects/core/README.md', '---\nkind: project\narea: lifeos\nproject: core\n---\n\n# Core\n\nThe answer engine: retrieval, then one cited answer.\n\n## Log\n\nNot in the excerpt.\n');
  note(root, 'Areas/reading/README.md', '---\narea: reading\nkind: area\ndescription: Books and papers worth keeping\n---\n\n# Reading\n\nOne note per book.\n');

  await at('2026-10-01T09:00:00Z', async () => {
    await upsertArea('lifeos', { title: 'LifeOS', home_path: 'Areas/lifeos', goals: ['Q1'], repos: ['example/lifeos'], design_path: 'Areas/lifeos/design.md' }, 'ada', { create: true });
    await upsertArea('reading', { title: 'Reading', home_path: 'Areas/reading/README.md' }, 'ada', { create: true });
    await upsertProject('lifeos', 'core', { title: 'Core', outcome: 'A question gets one cited answer', stage: 'building', due: '2026-12-01', owner: 'builder', notes_path: 'Areas/lifeos/projects/core/README.md' }, 'ada', {
      create: true,
      evidence: [{ kind: 'test', check: 'npm test (212 passed)', result: 'pass', at: '2026-11-12T10:00:00Z' }],
    });
    await upsertProject('lifeos', 'onboarding', { title: 'Onboarding', outcome: 'A new user writes a first entry in two minutes', stage: 'designing', due: '2026-11-25' }, 'ada', { create: true });
    await upsertProject('lifeos', 'voice', { title: 'Voice entries', stage: 'idea' }, 'ada', { create: true });
    await upsertProject('lifeos', 'landing', { title: 'Landing page', stage: 'live', unverified: 'shipped before the tracker' }, 'ada', { create: true });
    await upsertProject('lifeos', 'old-sync', { title: 'Old sync', stage: 'building' }, 'ada', { create: true });
  });
  // Before the 14 days: in the log, not in the pack.
  await at('2026-11-01T09:00:00Z', () => upsertProject('lifeos', 'core', { next_action: 'draft the retrieval query' }, 'builder'));
  await at('2026-11-10T09:00:00Z', () => recordKpi(root, 'lifeos', { key: 'paying-users', value: 12, at: '2026-11-10T09:00:00Z' }, 'ada'));
  await at('2026-11-12T09:00:00Z', () => upsertProject('lifeos', 'core', { stage: 'testing', next_action: 'run the golden questions', note: 'endpoints done' }, 'builder'));
  await at('2026-11-14T09:00:00Z', () => setProjectArchived('lifeos', 'old-sync', true, 'ada', 'superseded by core'));
  await at('2026-11-17T09:00:00Z', () => recordKpi(root, 'lifeos', { key: 'paying-users', value: 17, at: '2026-11-17T09:00:00Z' }, 'ada'));

  await finishedCard('t_aaaaaa', 'Retrieval: rank by recency', '2026-11-13T12:00:00Z', 'lifeos', 'core');
  await finishedCard('t_bbbbbb', 'Fix the footer link', '2026-11-18T12:00:00Z', 'lifeos');
  await finishedCard('t_cccccc', 'Long ago', '2026-10-20T12:00:00Z', 'lifeos');
  await indexed('Areas/lifeos/README.md', '2026-11-16T08:00:00Z');
  await indexed('Areas/lifeos/brand/assets/logo.svg', '2026-11-15T08:00:00Z');
  await indexed('Areas/lifeos/old.md', '2026-10-01T08:00:00Z');
  await indexed('Areas/lifeos-archive/elsewhere.md', '2026-11-16T08:00:00Z');
  return root;
}

describe('the context pack of an area', () => {
  beforeEach(truncateAll);

  it('an area with KPIs: text and JSON match the fixtures', async () => {
    const root = await seed();
    const ctx = await buildAreaContext(root, 'lifeos', { now: NOW });
    expect(AreaContextSchema.parse(ctx)).toBeTruthy();
    await expect(`${JSON.stringify(ctx, null, 2)}\n`).toMatchFileSnapshot(fixture('with-kpis.json'));
    await expect(renderContextText(ctx)).toMatchFileSnapshot(fixture('with-kpis.txt'));

    // What the fixtures are there to prove, said out loud.
    expect(ctx.kpis).toEqual([
      { key: 'paying-users', name: 'Paying users', unit: 'users', target: 100, by: '2027-03-31', latest: { value: 17, at: '2026-11-17T09:00:00.000Z' } },
      { key: 'mrr', name: 'MRR', unit: 'usd', target: null, by: null, latest: null },
    ]);
    // The roadmap is the open projects by due date: not the live one, not the archived one.
    expect(ctx.roadmap.map((p) => [p.slug, p.stage, p.due, p.next_action])).toEqual([
      ['onboarding', 'designing', '2026-11-25', null],
      ['core', 'testing', '2026-12-01', 'run the golden questions'],
      ['voice', 'idea', null, null],
    ]);
    // 14 days: the change of 11-01 and the card of 10-20 are out; files are the ones under the home folder.
    expect(ctx.recent.events.every((e) => e.at >= '2026-11-06')).toBe(true);
    expect(ctx.recent.cards.map((c) => c.id)).toEqual(['t_bbbbbb', 't_aaaaaa']);
    expect(ctx.recent.files.map((f) => f.path)).toEqual(['Areas/lifeos/README.md', 'Areas/lifeos/brand/assets/logo.svg']);
    // Paths, never file contents: the style guide is named, and nothing of the home note past its first section is in the pack.
    expect(ctx.style).toEqual({ guide: 'Areas/lifeos/brand/style-guide.md', assets: 'Areas/lifeos/brand/assets/' });
    expect(JSON.stringify(ctx)).not.toContain('Not part of the first section');
  });

  it('an area without KPIs has no KPI key and no KPI section', async () => {
    const root = await seed();
    const ctx = await buildAreaContext(root, 'reading', { now: NOW });
    await expect(`${JSON.stringify(ctx, null, 2)}\n`).toMatchFileSnapshot(fixture('without-kpis.json'));
    const text = renderContextText(ctx);
    await expect(text).toMatchFileSnapshot(fixture('without-kpis.txt'));
    expect(ctx).not.toHaveProperty('kpis');
    expect(ctx).not.toHaveProperty('goals');
    expect(text).not.toMatch(/KPI/);
  });

  it('--project adds the project: its row, the first section of its README and its verifications', async () => {
    const root = await seed();
    const ctx = await buildAreaContext(root, 'lifeos', { project: 'core', now: NOW });
    await expect(renderContextText(ctx)).toMatchFileSnapshot(fixture('with-project.txt'));
    expect(ctx.project).toMatchObject({
      slug: 'core', stage: 'testing', due: '2026-12-01', owner: 'builder', notes_path: 'Areas/lifeos/projects/core/README.md',
      excerpt: 'The answer engine: retrieval, then one cited answer.',
      verifications: [{ kind: 'test', check: 'npm test (212 passed)', result: 'pass' }],
      verifications_total: 1,
    });
  });

  it('cli-areas show prints the text by default and the JSON with --format json, and the API returns the same JSON', async () => {
    const root = await seed();
    const run = async (...argv: string[]): Promise<string> => {
      const out: string[] = [];
      expect(await runAreasCli(['show', ...argv], { out: (l) => out.push(l), err: () => {}, now: NOW, vaultRoot: root })).toBe(0);
      return out.join('\n');
    };
    const ctx = await buildAreaContext(root, 'lifeos', { project: 'core', now: NOW });
    expect(`${await run('lifeos', '--project', 'core')}\n`).toBe(renderContextText(ctx));
    expect(JSON.parse(await run('lifeos', '--project', 'core', '--format', 'json'))).toEqual(JSON.parse(JSON.stringify(ctx)));
    // `show <area>/<project>` is the same request.
    expect(await run('lifeos/core')).toBe(await run('lifeos', '--project', 'core'));

    // The API reads the clock, so its window differs from the fixture's; the shape and the timeless parts are the same.
    const app = createApp({ vaultRoot: root, modules: ALL_MODULES });
    const res = await request(app).get('/api/areas/lifeos/context?project=core').expect(200);
    const body = AreaContextSchema.parse(res.body);
    expect(body.area).toEqual(ctx.area);
    expect(body.kpis?.map((k) => [k.key, k.target])).toEqual([['paying-users', 100], ['mrr', null]]);
    expect(body.roadmap).toEqual(ctx.roadmap);
    expect(body.project).toEqual(ctx.project);
    expect((await request(app).get('/api/areas/reading/context').expect(200)).body).not.toHaveProperty('kpis');
    await request(app).get('/api/areas/nope/context').expect(404);
    await request(app).get('/api/areas/lifeos/context?project=nope').expect(404);
    await expect(runAreasCli(['show', 'nope'], { out: () => {}, err: () => {}, now: NOW, vaultRoot: root })).rejects.toThrow(/no area "nope"/);
  });

  it('a busy area stays inside the text budget, with every list cut and counted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sb-context-busy-'));
    const long = 'A sentence that goes on for a while so that a list of these would fill the pack on its own. '.repeat(4).trim();
    note(root, 'Areas/busy/README.md', `---\narea: busy\nkind: area\ndescription: ${long}\nlinks:\n${Array.from({ length: 30 }, (_, i) => `  site-${i}: https://example.com/${i}/${'x'.repeat(80)}`).join('\n')}\nkpis:\n${Array.from({ length: 20 }, (_, i) => `  - {key: kpi-${i}, name: KPI number ${i}, unit: things, target: ${i * 10}}`).join('\n')}\n---\n\n# Busy\n\n${long} ${long}\n`);
    await at('2026-11-10T09:00:00Z', async () => {
      await upsertArea('busy', { title: 'Busy', home_path: 'Areas/busy' }, 'ada', { create: true });
      for (let i = 0; i < 40; i++) {
        await upsertProject('busy', `project-${i}`, { title: `Project ${i}`, outcome: long, next_action: long, stage: 'building', due: `2026-12-${String((i % 28) + 1).padStart(2, '0')}` }, 'ada', { create: true });
      }
    });
    await at('2026-11-15T09:00:00Z', async () => {
      for (let i = 0; i < 40; i++) await upsertProject('busy', `project-${i}`, { stage: 'testing', note: long }, 'builder');
    });
    for (let i = 0; i < 30; i++) await finishedCard(`t_${String(i).padStart(6, '0')}`, `Card ${i}: ${long}`.slice(0, 190), '2026-11-16T12:00:00Z', 'busy', `project-${i}`);
    for (let i = 0; i < 60; i++) await indexed(`Areas/busy/notes/a-rather-long-folder-name/note-number-${i}.md`, '2026-11-16T08:00:00Z');

    const ctx = await buildAreaContext(root, 'busy', { project: 'project-0', now: NOW });
    const text = renderContextText(ctx);
    expect(text.length).toBeLessThanOrEqual(TEXT_BUDGET);
    expect(ctx.roadmap_total).toBe(40);
    expect(ctx.recent).toMatchObject({ events_total: 81, cards_total: 30, files_total: 60 });
    // Each list says how much it left out, and the last section is still there: nothing was cut off the end.
    expect(text).toMatch(/## Roadmap \(40 open projects, by due date\)[\s\S]*?- \.\.\. and \d+ more/);
    expect(text).toMatch(/Changes \(81\):[\s\S]*?- \.\.\. and \d+ more/);
    expect(text).toMatch(/Finished cards \(30\):[\s\S]*?- \.\.\. and \d+ more/);
    expect(text).toMatch(/Files changed \(60\):[\s\S]*?- \.\.\. and \d+ more/);
    expect(text).toContain('## Project: Project 0 (busy/project-0)');
    expect(text).not.toContain('cut to fit');
  });

  it('reads the first section of a note: the prose under the title, up to the next heading', () => {
    expect(firstSection('# Title\n\nOne line\nwrapped.\n\nSecond paragraph.\n\n## Next\n\nNo.\n')).toBe('One line wrapped.\n\nSecond paragraph.');
    expect(firstSection('# Only a title\n\n## Then a heading\n\nBody of the second section.\n')).toBe('Body of the second section.');
    expect(firstSection('')).toBeNull();
    expect(firstSection('x'.repeat(700))).toHaveLength(600);
  });
});
