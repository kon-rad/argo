import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { AreaIndexResponseSchema, AreaPageSchema, ProjectPageSchema } from '@secondbrain/contracts/projects';
import { createApp } from '../src/app.js';
import { scanVault } from '../src/connectors/vault/scan.js';
import { firstSection, kpiDefs, linkGroups } from '../src/features/projects/service/pages.js';
import { addVerification, recordKpi, setAreaArchived, upsertArea, upsertDivision, upsertProject, upsertTeam } from '../src/projects.js';
import { ALL_MODULES, truncateAll, vaultSourceId } from './helpers.js';

/** What the /areas, /areas/<slug> and /projects/<area>/<project> pages read. All data here is made up. */

const HOME = `---
area: journal
kind: area
description: A private journal
goals: [Reach 100 paying users]
links:
  websites: [https://journal.example.com]
  repos: [example-org/journal]
  socials: Areas/journal/social-channels.md
style:
  guide: Areas/journal/brand/style-guide.md
  assets: Areas/journal/brand/assets/
  system: Newsreader on ink
kpis:
  - {key: paying-users, name: Paying users, unit: users, target: 100, by: 2027-03-31}
  - {key: response-ms, name: Response time, unit: ms, target: 200, direction: down}
  - {key: posts, name: Posts}
---

# Journal

The journal is where the day gets written down.

It is private by default.

## Standards

Not part of the excerpt.
`;

async function vault(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'sb-area-pages-'));
  mkdirSync(join(root, 'Areas/journal/brand/assets'), { recursive: true });
  mkdirSync(join(root, 'Areas/journal/projects/sync'), { recursive: true });
  mkdirSync(join(root, 'Areas/plain'), { recursive: true });
  writeFileSync(join(root, 'Areas/journal/README.md'), HOME);
  writeFileSync(join(root, 'Areas/journal/brand/style-guide.md'), '# Style guide\n\nUse the serif for headings.\n');
  writeFileSync(join(root, 'Areas/journal/brand/assets/logo.png'), 'not really a png');
  writeFileSync(join(root, 'Areas/journal/brand/assets/mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(root, 'Areas/journal/brand/assets/notes.txt'), 'not an image');
  writeFileSync(join(root, 'Areas/journal/projects/sync/README.md'), '---\nkind: project\narea: journal\nproject: sync\n---\n\n# Sync\n\nTwo devices show the same entries.\n\n## Plan\n\nLater.\n');
  writeFileSync(join(root, 'Areas/plain/README.md'), '# Plain\n');
  await scanVault({ root, sourceId: await vaultSourceId() });
  return root;
}

async function seed(): Promise<void> {
  await upsertDivision('product', { name: 'Product' });
  await upsertTeam('apps', { name: 'Apps', lead: 'ada', members: ['ada', 'lin'] });
  await upsertArea('journal', { title: 'Journal', division: 'product', team: 'apps', health: 'green', home_path: 'Areas/journal' }, 'seed', { create: true });
  await upsertArea('plain', { title: 'Plain', home_path: 'Areas/plain' }, 'seed', { create: true });
  await upsertArea('bare', { title: 'Bare', status: 'parked' }, 'seed', { create: true });
  await upsertProject('journal', 'sync', { title: 'Sync', outcome: 'Two devices show the same entries', stage: 'building', due: '2026-12-20', next_action: 'write the merge test' }, 'seed', { create: true });
  await upsertProject('journal', 'export', { title: 'Export', stage: 'idea', due: '2026-12-01' }, 'seed', { create: true });
  await upsertProject('journal', 'later', { title: 'Later', stage: 'idea' }, 'seed', { create: true });
  await upsertProject('journal', 'shelved', { title: 'Shelved', stage: 'parked' }, 'seed', { create: true });
}

describe('the pieces of a home note', () => {
  it('takes the first section of the body, without the title', () => {
    expect(firstSection('# Journal\n\nOne.\n\nTwo.\n\n## Standards\n\nThree.\n')).toBe('One.\n\nTwo.');
    expect(firstSection('# Only a title\n')).toBeNull();
    expect(firstSection('x'.repeat(50), 10)).toBe(`${'x'.repeat(10)}…`);
  });

  it('reads kpis as a list or a map, with a default name and direction', () => {
    expect(kpiDefs({ kpis: [{ key: 'mrr', target: '250' }, 'posts'] })).toEqual([
      { key: 'mrr', name: 'mrr', unit: null, target: 250, by: null, direction: 'up' },
      { key: 'posts', name: 'posts', unit: null, target: null, by: null, direction: 'up' },
    ]);
    expect(kpiDefs({ kpis: { cost: { name: 'Cost', unit: 'usd', target: 10, direction: 'down' } } })).toEqual([
      { key: 'cost', name: 'Cost', unit: 'usd', target: 10, by: null, direction: 'down' },
    ]);
    expect(kpiDefs({})).toEqual([]);
  });

  it('turns links into URLs, vault paths or plain text, as given', () => {
    expect(linkGroups({
      websites: ['https://journal.example.com/', 'journal.example.com/app'],
      repos: ['example-org/journal'],
      socials: 'Areas/journal/social-channels.md',
      store: { label: 'App store', url: 'https://store.example.com/journal' },
      motto: 'Write it down',
      escape: '../../etc/passwd',
      empty: [],
    })).toEqual([
      { group: 'websites', items: [
        { text: 'journal.example.com', href: 'https://journal.example.com/', path: null },
        { text: 'journal.example.com/app', href: 'https://journal.example.com/app', path: null },
      ] },
      { group: 'repos', items: [{ text: 'example-org/journal', href: 'https://github.com/example-org/journal', path: null }] },
      { group: 'socials', items: [{ text: 'Areas/journal/social-channels.md', href: null, path: 'Areas/journal/social-channels.md' }] },
      { group: 'store', items: [{ text: 'App store', href: 'https://store.example.com/journal', path: null }] },
      { group: 'motto', items: [{ text: 'Write it down', href: null, path: null }] },
      // A path that would leave the vault is shown as text and never linked.
      { group: 'escape', items: [{ text: '../../etc/passwd', href: null, path: null }] },
    ]);
  });
});

describe('GET /api/areas/:area (the area page)', () => {
  beforeEach(truncateAll);

  it('an area with KPIs and assets: header, links, style guide, images, goals, KPI trend, roadmap and recent history', async () => {
    const root = await vault();
    await seed();
    await recordKpi(root, 'journal', { key: 'paying-users', value: 40, at: '2026-11-01' }, 'ada');
    await recordKpi(root, 'journal', { key: 'paying-users', value: 120, at: '2026-11-10' }, 'ada');
    await recordKpi(root, 'journal', { key: 'response-ms', value: 350 }, 'ada');
    const app = createApp({ modules: ALL_MODULES, vaultRoot: root });
    const res = await request(app).get('/api/areas/journal').expect(200);
    const page = AreaPageSchema.parse(res.body);

    expect(page.area).toMatchObject({ slug: 'journal', title: 'Journal', division_name: 'Product', team_name: 'Apps', owner: 'ada', members: ['ada', 'lin'], archived_at: null });
    expect(page.home).toEqual({ path: 'Areas/journal/README.md', description: 'A private journal', excerpt: 'The journal is where the day gets written down.\n\nIt is private by default.' });
    expect(page.links.map((g) => g.group)).toEqual(['websites', 'repos', 'socials']);
    expect(page.style?.guide).toEqual({ path: 'Areas/journal/brand/style-guide.md', markdown: expect.stringContaining('Use the serif for headings.'), truncated: false });
    // Only images, and only what the index holds.
    expect(page.style?.assets).toEqual({
      path: 'Areas/journal/brand/assets/',
      images: [{ path: 'Areas/journal/brand/assets/logo.png', name: 'logo.png' }, { path: 'Areas/journal/brand/assets/mark.svg', name: 'mark.svg' }],
      more: 0,
    });
    expect(page.style?.other).toEqual([{ group: 'system', items: [{ text: 'Newsreader on ink', href: null, path: null }] }]);
    expect(page.goals).toEqual([{ code: null, text: 'Reach 100 paying users' }]);

    const [users, ms, posts] = page.kpis;
    expect(users).toMatchObject({ key: 'paying-users', name: 'Paying users', unit: 'users', target: 100, by: '2027-03-31', on_target: true });
    expect(users!.readings.map((r) => r.value)).toEqual([40, 120]); // oldest first, for the trend
    expect(users!.latest?.value).toBe(120);
    expect(ms).toMatchObject({ key: 'response-ms', direction: 'down', on_target: false }); // 350 ms against a target of 200, lower is better
    expect(posts).toMatchObject({ key: 'posts', target: null, latest: null, on_target: null, readings: [] });

    // The roadmap is the open projects by due date; a parked one is not on it.
    expect(page.roadmap.map((p) => [p.slug, p.stage, p.due])).toEqual([['export', 'idea', '2026-12-01'], ['sync', 'building', '2026-12-20'], ['later', 'idea', null]]);
    expect(page.roadmap[1]).toMatchObject({ outcome: 'Two devices show the same entries', next_action: 'write the merge test' });

    // Recent: newest first, from the change history. A created row carries no values.
    expect(page.recent[0]).toMatchObject({ kind: 'kpi_reading', field: 'response-ms', to: 350, actor: 'ada', project: null });
    const created = page.recent.find((e) => e.kind === 'created' && e.project === 'sync');
    expect(created).toMatchObject({ project_title: 'Sync', from: null, to: null });
  });

  it('an area with neither KPIs nor assets has empty sections, and one with no home note has no home', async () => {
    const root = await vault();
    await seed();
    const app = createApp({ modules: ALL_MODULES, vaultRoot: root });
    const plain = AreaPageSchema.parse((await request(app).get('/api/areas/plain').expect(200)).body);
    expect(plain).toMatchObject({ home: { path: 'Areas/plain/README.md', description: null, excerpt: null }, links: [], style: null, goals: [], kpis: [], roadmap: [] });
    expect(plain.area).toMatchObject({ owner: null, team: null, division: null });
    const bare = AreaPageSchema.parse((await request(app).get('/api/areas/bare').expect(200)).body);
    expect(bare).toMatchObject({ home: null, links: [], style: null, kpis: [] });
  });

  it('never reads a style guide that is not an indexed note, and 404s for an area that is not there', async () => {
    const root = await vault();
    await seed();
    writeFileSync(join(root, 'secret.env'), 'TOKEN=not-for-the-page');
    writeFileSync(join(root, 'Areas/plain/README.md'), '---\narea: plain\nkind: area\nstyle:\n  guide: secret.env\n  assets: ../outside/\n---\n# Plain\n');
    const app = createApp({ modules: ALL_MODULES, vaultRoot: root });
    const res = await request(app).get('/api/areas/plain').expect(200);
    expect(res.body.style).toEqual({ guide: { path: 'secret.env', markdown: null, truncated: false }, assets: null, other: [] });
    expect(JSON.stringify(res.body)).not.toContain('not-for-the-page');
    await request(app).get('/api/areas/nope').expect(404);
    await request(app).get('/api/areas/Not_A_Slug').expect(400);
  });

  it('still shows an archived area, with its roadmap', async () => {
    const root = await vault();
    await seed();
    await setAreaArchived('journal', true, 'ada', 'wound down');
    const app = createApp({ modules: ALL_MODULES, vaultRoot: root });
    const page = AreaPageSchema.parse((await request(app).get('/api/areas/journal').expect(200)).body);
    expect(page.area.archived_at).not.toBeNull();
    expect(page.roadmap.map((p) => p.slug)).toEqual(['export', 'sync', 'later']);
    expect(page.recent[0]).toMatchObject({ kind: 'archived', note: 'wound down', actor: 'ada' });
  });
});

describe('GET /api/areas?view=index (the /areas page)', () => {
  beforeEach(truncateAll);

  it('lists every area with its division, owner, open project count and KPI health when it has KPIs', async () => {
    const root = await vault();
    await seed();
    await recordKpi(root, 'journal', { key: 'paying-users', value: 120 }, 'ada');
    await recordKpi(root, 'journal', { key: 'response-ms', value: 350 }, 'ada');
    await setAreaArchived('plain', true, 'ada', 'done with it');
    const app = createApp({ modules: ALL_MODULES, vaultRoot: root });
    const { areas } = AreaIndexResponseSchema.parse((await request(app).get('/api/areas?view=index').expect(200)).body);
    const by = Object.fromEntries(areas.map((a) => [a.slug, a]));
    expect(by.journal).toMatchObject({
      title: 'Journal', status: 'active', division: 'product', division_name: 'Product', owner: 'ada', health: 'green', description: 'A private journal',
      active_projects: 3, // sync, export, later: the parked one is not open
      kpis: { total: 3, with_target: 2, on_target: 1 },
      archived_at: null,
    });
    expect(by.bare).toMatchObject({ status: 'parked', kpis: null, active_projects: 0, owner: null, description: null });
    // Archived areas are in the list too; the page hides them behind a toggle.
    expect(by.plain!.archived_at).not.toBeNull();
    expect(by.plain!.kpis).toBeNull();
    // The board, the default view of this path, is unchanged.
    const board = await request(app).get('/api/areas').expect(200);
    expect(board.body.areas.map((a: { slug: string }) => a.slug).sort()).toEqual(['bare', 'journal']);
  });
});

describe('GET /api/projects/:area/:project (the project page)', () => {
  beforeEach(truncateAll);

  it('returns the outcome, the stage history, the verifications, the next action and the README excerpt', async () => {
    const root = await vault();
    await seed();
    await upsertProject('journal', 'sync', { stage: 'testing', note: 'merge works' }, 'ada');
    await addVerification('journal', 'sync', { kind: 'test', check: 'npm test', result: 'pass', evidence: '12 passed' }, 'ada');
    await upsertProject('journal', 'sync', { notes_path: 'Areas/journal/projects/sync/README.md' }, 'ada');
    const app = createApp({ modules: ALL_MODULES, vaultRoot: root });
    const page = ProjectPageSchema.parse((await request(app).get('/api/projects/journal/sync').expect(200)).body);
    expect(page.project).toMatchObject({
      area: 'journal', area_title: 'Journal', slug: 'sync', title: 'Sync', outcome: 'Two devices show the same entries', stage: 'testing', due: '2026-12-20',
      next_action: 'write the merge test', archived_at: null, area_archived: false,
    });
    expect(page.stages.map((s) => [s.from, s.to, s.by, s.note])).toEqual([['building', 'testing', 'ada', 'merge works'], [null, 'building', 'seed', 'added']]);
    expect(page.verifications).toEqual([{ kind: 'test', check: 'npm test', result: 'pass', evidence: '12 passed', at: expect.any(String), by: 'ada' }]);
    expect(page.readme).toEqual({ path: 'Areas/journal/projects/sync/README.md', excerpt: 'Two devices show the same entries.' });
  });

  it('finds the README in the area home when the project has no notes_path, has none when there is no file, and 404s for a missing project', async () => {
    const root = await vault();
    await seed();
    const app = createApp({ modules: ALL_MODULES, vaultRoot: root });
    expect((await request(app).get('/api/projects/journal/sync').expect(200)).body.readme).toEqual({ path: 'Areas/journal/projects/sync/README.md', excerpt: 'Two devices show the same entries.' });
    expect((await request(app).get('/api/projects/journal/export').expect(200)).body.readme).toBeNull();
    await request(app).get('/api/projects/journal/nope').expect(404);
    await request(app).get('/api/projects/nope/sync').expect(404);
    // The list across areas still answers at the root, and the old report path still redirects.
    expect((await request(app).get('/api/projects?area=journal&stage=building').expect(200)).body.projects.map((p: { slug: string }) => p.slug)).toEqual(['sync']);
    await request(app).get('/api/projects/report').expect(308);
  });
});
