import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { patchFrom, parseArgs, writeIfChanged } from '../src/cli-projects.js';
import { AREA_FIELDS } from '../src/features/projects/cli-shared.js';
import { query } from '../src/db.js';
import {
  addVerification,
  buildReport,
  getBoard,
  importSeed,
  kioskSummary,
  listProjects,
  removeArea,
  removeProject,
  nextActionFrom,
  parseGoals,
  setAreaArchived,
  setProjectArchived,
  upsertArea,
  upsertProject,
  upsertDivision,
  upsertTeam,
} from '../src/projects.js';
import { renderMarkdown, renderStandup, renderTelegram } from '../src/projects-report.js';
import { ALL_MODULES, truncateAll } from './helpers.js';

const GOALS = `# Goals Master

## This week (2026-10-12 – 2026-10-18)

| # | Goal | Measure | Due | Status |
|---|---|---|---|---|
| W1 | Wearable computing prototype finished | Mic works | 2026-10-18 | open |
| W2 | Livestream to create video | not set | 2026-10-18 | open |

## This month (October 2026)

| # | Goal | Measure | Due | Status |
|---|---|---|---|---|
| M1 | Goa outcome settled | Edge City | 2026-10-10 | cancelled (owner) |

## Ten years (2026 – 2036)

| # | Goal |
|---|---|
| T1 | Build a unicorn startup |
`;

const README = `# Lifeos dev log

## Resume
- **Task:** build the core
- **Next action:** write \`/v1/days\` and its test

---
`;

function fixtureVault(): string {
  const root = mkdtempSync(join(tmpdir(), 'sb-projects-'));
  mkdirSync(join(root, 'CURRENT'), { recursive: true });
  mkdirSync(join(root, 'Areas', 'lifeos', 'dev-log'), { recursive: true });
  writeFileSync(join(root, 'CURRENT', 'goals-master.md'), GOALS);
  writeFileSync(join(root, 'secondbrain.json'), JSON.stringify({ goalsFile: 'CURRENT/goals-master.md' }));
  writeFileSync(join(root, 'Areas', 'lifeos', 'dev-log', 'README.md'), README);
  return root;
}

const vault = fixtureVault();

async function seedBasic(): Promise<void> {
  await upsertDivision('lifeos-div', { name: 'LifeOS', head: 'owner' });
  await upsertTeam('platform', { name: 'Platform', lead: 'claude-code', members: ['claude-code', 'hermes'] });
  await upsertArea(
    'lifeos',
    { title: 'argo-lifeos', team: 'platform', division: 'lifeos-div', priority: 2, goals: ['W1'], devlog_path: 'Areas/lifeos/dev-log/README.md' },
    'test',
    { create: true },
  );
  await upsertProject('lifeos', 'core', { title: 'Headless core', outcome: 'The core answers /v1/days', stage: 'building', owner: 'claude-code' }, 'test', { create: true });
  await upsertProject('lifeos', 'mcp', { title: 'MCP server' }, 'test', { create: true });
}

describe('parsers', () => {
  it('reads goal codes, horizons and statuses from goals-master.md', () => {
    const g = parseGoals(GOALS);
    expect(g.map((x) => x.code)).toEqual(['W1', 'W2', 'M1', 'T1']);
    expect(g[0]).toEqual({ code: 'W1', horizon: 'This week', goal: 'Wearable computing prototype finished', due: '2026-10-18', status: 'open' });
    expect(g[2]!.status).toMatch(/^cancelled/);
    expect(g[3]).toMatchObject({ horizon: 'Ten years', status: 'long-term', due: null });
  });

  it('takes the Next action line from the Resume block only', () => {
    expect(nextActionFrom(README)).toBe('write `/v1/days` and its test');
    expect(nextActionFrom('# x\n\n- **Next action:** outside any resume block\n')).toBeNull();
  });

  it('turns CLI flags into a patch; "none" clears', () => {
    const { pos, opts } = parseArgs(['lifeos/core', '--stage', 'testing', '--needs', 'none', '--goals', 'W1, M2', '--priority', '3', '--paths', 'none']);
    expect(pos).toEqual(['lifeos/core']);
    // A project has no priority and no paths: those are an area's fields, and each CLI reads only its own.
    expect(patchFrom(opts)).toEqual({ stage: 'testing', needs_owner: null, goals: ['W1', 'M2'] });
    expect(patchFrom(opts, AREA_FIELDS)).toEqual({ needs_owner: null, goals: ['W1', 'M2'], priority: 3, paths: [] });
  });

  it('writes the rendered file only when it changed', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'sb-render-')), 'CURRENT', 'projects.md');
    expect(writeIfChanged(p, 'a\n')).toBe(true);
    expect(writeIfChanged(p, 'a\n')).toBe(false);
    expect(readFileSync(p, 'utf8')).toBe('a\n');
  });
});

describe('writes and the verification gate', () => {
  beforeEach(truncateAll);

  it('purges an area with its projects, and a dry run removes nothing', async () => {
    await seedBasic();
    expect(await removeArea('lifeos', { dryRun: true })).toEqual({ projects: 2, facts: 0 });
    expect((await query(`SELECT 1 FROM areas WHERE slug = 'lifeos'`)).rowCount).toBe(1);
    expect(await removeArea('lifeos')).toEqual({ projects: 2, facts: 0 });
    expect((await query(`SELECT 1 FROM areas WHERE slug = 'lifeos'`)).rowCount).toBe(0);
    expect((await query(`SELECT 1 FROM projects WHERE area_slug = 'lifeos'`)).rowCount).toBe(0);
    await expect(removeArea('lifeos')).rejects.toThrow(/no area/);
  });

  it('purges one project with its history and leaves the area', async () => {
    await seedBasic();
    await addVerification('lifeos', 'core', { kind: 'test', check: 'npm test', result: 'pass' }, 't');
    expect(await removeProject('lifeos', 'core', { dryRun: true })).toEqual({ verifications: 1 });
    expect((await listProjects({ area: 'lifeos' })).map((p) => p.slug)).toEqual(['core', 'mcp']);
    await removeProject('lifeos', 'core');
    expect((await listProjects({ area: 'lifeos' })).map((p) => p.slug)).toEqual(['mcp']);
    expect((await query(`SELECT 1 FROM verifications`)).rowCount).toBe(0);
    await expect(removeProject('lifeos', 'core')).rejects.toThrow(/no project "lifeos\/core"/);
  });

  it('keeps memory facts when their area is purged: re-tagged with --into, else untagged', async () => {
    await seedBasic();
    await upsertArea('parent', { title: 'Parent' }, 'test', { create: true });
    await query(`INSERT INTO memory_facts (subject, claim, source, author, area_slug) VALUES ('a', 'b', 'c', 'lena', 'lifeos')`);
    await expect(removeArea('lifeos', { into: 'nope' })).rejects.toThrow(/no area "nope"/);
    expect((await removeArea('lifeos', { into: 'parent' })).facts).toBe(1);
    expect((await query(`SELECT area_slug FROM memory_facts`)).rows).toEqual([{ area_slug: 'parent' }]);
    await upsertArea('other', { title: 'Other' }, 'test', { create: true });
    await query(`UPDATE memory_facts SET area_slug = 'other'`);
    await removeArea('other');
    expect((await query(`SELECT area_slug FROM memory_facts`)).rows).toEqual([{ area_slug: null }]);
  });

  it('records every stage move with who and why', async () => {
    await seedBasic();
    await upsertProject('lifeos', 'core', { stage: 'testing', note: 'endpoints done' }, 'claude@mac');
    const { rows } = await query(
      `SELECT p.slug, s.from_stage, s.to_stage, s.by, s.note FROM stage_changes s LEFT JOIN projects p ON p.id = s.project_id ORDER BY s.id`,
    );
    expect(rows).toEqual([
      { slug: null, from_stage: null, to_stage: 'active', by: 'test', note: 'added' },
      { slug: 'core', from_stage: null, to_stage: 'building', by: 'test', note: 'added' },
      { slug: 'mcp', from_stage: null, to_stage: 'idea', by: 'test', note: 'added' },
      { slug: 'core', from_stage: 'building', to_stage: 'testing', by: 'claude@mac', note: 'endpoints done' },
    ]);
  });

  it('refuses live without a passing verification, then allows it once one passes', async () => {
    await seedBasic();
    await expect(upsertProject('lifeos', 'core', { stage: 'live' }, 't')).rejects.toThrow(/has no verification/);
    await addVerification('lifeos', 'core', { kind: 'test', check: 'npx vitest run', result: 'fail', evidence: '2 failed' }, 't');
    await expect(upsertProject('lifeos', 'core', { stage: 'live' }, 't')).rejects.toThrow(/newest verification failed/);
    await addVerification('lifeos', 'core', { kind: 'test', check: 'npx vitest run', result: 'pass', evidence: '40 passed' }, 't');
    const r = await upsertProject('lifeos', 'core', { stage: 'live' }, 't');
    expect(r.stage_changed).toBe(true);
    const { rows } = await query(`SELECT stage, shipped_at IS NOT NULL AS shipped FROM projects WHERE slug = 'core'`);
    expect(rows[0]).toEqual({ stage: 'live', shipped: true });
  });

  it('lets a project ship unverified only with a reason, kept in the history and flagged in the report', async () => {
    await seedBasic();
    await upsertProject('lifeos', 'mcp', { stage: 'done', unverified: 'shipped before the tracker' }, 't');
    const { rows } = await query(`SELECT note FROM stage_changes WHERE to_stage = 'done'`);
    expect(rows[0]!.note).toBe('UNVERIFIED: shipped before the tracker');
    const report = await buildReport(vault);
    expect(report.gaps.unverified_shipped).toEqual([{ area: 'lifeos', project: 'mcp', title: 'MCP server', detail: 'no verification' }]);
  });

  it('rejects unknown areas, teams, bad stages and bad statuses', async () => {
    await expect(upsertArea('nope', { status: 'parked' }, 't')).rejects.toThrow(/no area "nope"/);
    await expect(upsertArea('x', { title: 'X', team: 'ghosts' }, 't', { create: true })).rejects.toThrow(/no team/);
    await expect(upsertArea('x', { title: 'X', division: 'ghosts' }, 't', { create: true })).rejects.toThrow(/no division/);
    // An area has a status, not a stage, and no due date: the old fields are refused, not ignored.
    await expect(upsertArea('x', { title: 'X', stage: 'building' } as never, 't', { create: true })).rejects.toThrow();
    await expect(upsertArea('x', { title: 'X', due: '2026-12-01' } as never, 't', { create: true })).rejects.toThrow();
    await expect(upsertArea('x', { title: 'X', status: 'building' as never }, 't', { create: true })).rejects.toThrow();
    await seedBasic();
    await expect(upsertProject('lifeos', 'core', { stage: 'shipping' as never }, 't')).rejects.toThrow();
    await expect(upsertProject('ghost-area', 'x', { title: 'X' }, 't', { create: true })).rejects.toThrow(/no area "ghost-area"/);
  });

  it('a new area starts active; parking it is a status change in the history', async () => {
    await seedBasic();
    expect((await getBoard(vault)).areas[0]).toMatchObject({ slug: 'lifeos', status: 'active', archived_at: null });
    expect(await upsertArea('lifeos', { status: 'parked', note: 'paused for the quarter' }, 't')).toEqual({ created: false, stage_changed: true });
    const { rows } = await query(`SELECT from_stage, to_stage, note FROM stage_changes WHERE project_id IS NULL ORDER BY id`);
    expect(rows).toEqual([
      { from_stage: null, to_stage: 'active', note: 'added' },
      { from_stage: 'active', to_stage: 'parked', note: 'paused for the quarter' },
    ]);
  });

  it('a project keeps an outcome and a next action; the outcome defaults to the title', async () => {
    await seedBasic();
    await upsertProject('lifeos', 'core', { next_action: 'write the /v1/days test' }, 't');
    const [core, mcp] = (await getBoard(vault)).areas[0]!.projects;
    expect(core).toMatchObject({ area: 'lifeos', slug: 'core', outcome: 'The core answers /v1/days', next_action: 'write the /v1/days test' });
    expect(mcp).toMatchObject({ slug: 'mcp', outcome: 'MCP server', next_action: null });
  });

  it('refuses a project named like an area, so a bare slug is never ambiguous', async () => {
    await seedBasic();
    await expect(upsertProject('lifeos', 'lifeos', { title: 'Same name' }, 't', { create: true })).rejects.toThrow(/is the name of an area/);
  });

  it('imports a seed idempotently', async () => {
    const seed = {
      teams: [{ slug: 'platform', name: 'Platform' }],
      areas: [
        {
          slug: 'lifeos', title: 'argo-lifeos', status: 'active', team: 'platform', home_path: 'Areas/lifeos/README.md',
          projects: [{ slug: 'core', title: 'Core', outcome: 'Core ships', stage: 'building' }, { slug: 'ui', title: 'UI' }],
        },
      ],
    };
    expect(await importSeed(seed, 'seed')).toEqual({ teams: 1, areas: 1, projects: 2 });
    await importSeed(seed, 'seed');
    // one row each for the area and its two projects, and nothing more on the second import
    const { rows } = await query(`SELECT count(*)::int AS n FROM stage_changes`);
    expect(rows[0]!.n).toBe(3);
    // Imports are not news: the report's "moved" list and "shipped this week" ignore them.
    const r = await buildReport(vault);
    expect(r.moved_7d).toEqual([]);
  });

  it('reads a seed file written before the rename: projects with features, a stage, a due date', async () => {
    const old = {
      projects: [
        { slug: 'lifeos', title: 'argo-lifeos', stage: 'building', due: '2026-12-01', features: [{ slug: 'core', title: 'Core', stage: 'building' }] },
        { slug: 'shelved', title: 'Shelved', stage: 'parked', features: [] },
      ],
    };
    expect(await importSeed(old, 'seed')).toEqual({ teams: 0, areas: 2, projects: 1 });
    expect((await query(`SELECT slug, status FROM areas ORDER BY slug`)).rows).toEqual([{ slug: 'lifeos', status: 'active' }, { slug: 'shelved', status: 'parked' }]);
    expect((await listProjects()).map((p) => `${p.area}/${p.slug}`)).toEqual(['lifeos/core']);
  });

  it('imports existing evidence with its real date, so a shipped project passes the gate', async () => {
    const seed = {
      areas: [
        {
          slug: 'lifeos', title: 'argo-lifeos',
          projects: [
            {
              slug: 'repo', title: 'Public repo', stage: 'done',
              verifications: [{ kind: 'deploy', check: 'GitHub Actions CI', result: 'pass', evidence: 'run 1 succeeded', at: '2026-10-12T10:00:00+08:00' }],
            },
          ],
        },
      ],
    };
    await importSeed(seed, 'seed');
    await importSeed(seed, 'seed');
    const { rows } = await query(`SELECT result, at FROM verifications`);
    expect(rows).toHaveLength(1);
    expect((rows[0]!.at as Date).toISOString()).toBe('2026-10-12T02:00:00.000Z');
    expect((await buildReport(vault)).gaps.unverified_shipped).toEqual([]);
  });
});

describe('the report', () => {
  beforeEach(truncateAll);

  it('rolls up stages, needs-you, teams, goal coverage and gaps', async () => {
    await seedBasic();
    await upsertArea('lifeos', { needs_owner: 'Write the README pitch' }, 't');
    await upsertProject('lifeos', 'core', { stage: 'testing' }, 't');
    // An old in-flight project: no activity for 10 days.
    await upsertProject('lifeos', 'mcp', { stage: 'designing' }, 't');
    await query(`UPDATE projects SET updated_at = now() - interval '10 days' WHERE slug = 'mcp'`);
    await query(`UPDATE stage_changes SET at = now() - interval '10 days' WHERE project_id = (SELECT id FROM projects WHERE slug = 'mcp')`);

    const r = await buildReport(vault);
    expect(r.totals.areas).toEqual({ active: 1, parked: 0 });
    expect(r.totals.projects).toMatchObject({ testing: 1, designing: 1 });
    expect(r.needs_owner).toEqual([{ area: 'lifeos', project: null, title: 'argo-lifeos', detail: 'Write the README pitch', priority: 2, due: null }]);
    expect(r.teams).toEqual([
      { slug: 'platform', name: 'Platform', lead: 'claude-code', areas: ['lifeos'], in_flight: 2, shipped_7d: 0, needs_owner: 1, statuses: { active: 1, parked: 0 } },
    ]);
    expect(r.divisions.map((d) => [d.slug, d.areas])).toEqual([['lifeos-div', ['lifeos']]]);
    expect(r.gaps.no_division).toEqual([]);
    expect(r.goals.find((g) => g.code === 'W1')!.areas).toEqual(['lifeos']);
    // W2 is open with nothing linked; M1 is cancelled and T1 is ten-year, so neither is a gap.
    expect(r.gaps.goals_uncovered.map((g) => g.code)).toEqual(['W2']);
    expect(r.gaps.testing_unverified.map((i) => i.project)).toEqual(['core']);
    expect(r.gaps.stale.map((i) => i.project)).toEqual(['mcp']);
    expect(r.areas[0]!.next_action).toBe('write `/v1/days` and its test');
    expect(r.areas[0]!.progress).toBe(0);
  });

  it('renders markdown, stand-up and Telegram text without em-dashes', async () => {
    await seedBasic();
    const r = await buildReport(vault);
    for (const text of [renderMarkdown(r), renderStandup(r), renderTelegram(r)]) {
      expect(text).not.toContain('\u2014');
      expect(text).toContain('argo-lifeos');
      expect(text).toContain('LifeOS');
    }
    expect(renderMarkdown(r)).toContain('| **W2** Livestream to create video | open | 2026-10-18 | **nothing linked** |');
    // Areas are the sections, projects are the rows.
    expect(renderMarkdown(r)).toContain('# Company Report - Areas, Projects, Goals');
    expect(renderMarkdown(r)).toContain('## Projects by area');
    expect(renderStandup(r)).toContain('Areas: 1 active. Projects: 1 backlog, 1 building.');
    expect(renderTelegram(r).length).toBeLessThan(3600);
    // The kiosk is a separate device: its feed keeps the keys it had before the rename.
    const k = kioskSummary(r);
    expect(k.projects[0]).toMatchObject({ slug: 'lifeos', stage: 'active', in_flight: [{ title: 'Headless core', stage: 'building' }] });
    expect(k.totals.features).toMatchObject({ building: 1, idea: 1 });
  });

  it('due dates come back as written, whatever the timezone', async () => {
    await seedBasic();
    await upsertProject('lifeos', 'core', { due: '2026-10-18' }, 't');
    expect((await getBoard(vault)).areas[0]!.projects[0]!.due).toBe('2026-10-18');
  });

  it('an empty tracker still reports', async () => {
    const r = await buildReport(vault);
    expect(r.areas).toEqual([]);
    expect(renderMarkdown(r)).toContain('Nothing is waiting on you.');
  });
});

describe('archive', () => {
  beforeEach(truncateAll);

  it('archiving a project hides it from the active views and keeps its stage; unarchiving brings it back', async () => {
    await seedBasic();
    expect(await setProjectArchived('lifeos', 'core', true, 't', 'superseded')).toEqual({ archived: true, changed: true });
    // Idempotent: a second archive changes nothing and writes no history.
    expect(await setProjectArchived('lifeos', 'core', true, 't')).toEqual({ archived: true, changed: false });
    expect((await getBoard(vault)).areas[0]!.projects.map((p) => p.slug)).toEqual(['mcp']);
    expect((await listProjects()).map((p) => p.slug)).toEqual(['mcp']);
    expect((await buildReport(vault)).totals.projects).toMatchObject({ building: 0, idea: 1 });
    const all = await listProjects({ archived: true });
    expect(all.map((p) => [p.slug, p.stage, p.archived_at !== null])).toEqual([['core', 'building', true], ['mcp', 'idea', false]]);
    expect((await getBoard(vault, new Date(), { archived: true })).areas[0]!.projects.map((p) => p.slug)).toEqual(['core', 'mcp']);

    expect(await setProjectArchived('lifeos', 'core', false, 't')).toEqual({ archived: false, changed: true });
    expect((await getBoard(vault)).areas[0]!.projects.find((p) => p.slug === 'core')).toMatchObject({ stage: 'building', archived_at: null });
    const { rows } = await query(`SELECT to_stage, note FROM stage_changes WHERE to_stage IN ('archived', 'unarchived') ORDER BY id`);
    expect(rows).toEqual([{ to_stage: 'archived', note: 'superseded' }, { to_stage: 'unarchived', note: null }]);
    await expect(setProjectArchived('lifeos', 'nope', true, 't')).rejects.toThrow(/no project/);
  });

  it('archiving an area hides its projects with it and does not change their stages', async () => {
    await seedBasic();
    await upsertArea('other', { title: 'Other' }, 't', { create: true });
    expect(await setAreaArchived('lifeos', true, 't', 'no longer run')).toEqual({ archived: true, changed: true });
    expect((await getBoard(vault)).areas.map((a) => a.slug)).toEqual(['other']);
    expect(await listProjects()).toEqual([]);
    expect((await buildReport(vault)).totals).toMatchObject({ areas: { active: 1, parked: 0 } });
    const hidden = await listProjects({ archived: true });
    expect(hidden.map((p) => [p.slug, p.stage, p.archived_at !== null])).toEqual([['core', 'building', true], ['mcp', 'idea', true]]);
    // The projects themselves were not touched: only the area carries the flag.
    expect((await query(`SELECT count(*)::int AS n FROM projects WHERE archived_at IS NOT NULL`)).rows[0]!.n).toBe(0);

    await setAreaArchived('lifeos', false, 't');
    const back = (await getBoard(vault)).areas.find((a) => a.slug === 'lifeos')!;
    expect(back).toMatchObject({ status: 'active', archived_at: null });
    expect(back.projects.map((p) => [p.slug, p.stage])).toEqual([['core', 'building'], ['mcp', 'idea']]);
    await expect(setAreaArchived('nope', true, 't')).rejects.toThrow(/no area/);
  });

  it('the API archives and unarchives areas and projects', async () => {
    await seedBasic();
    const app = createApp({ modules: ALL_MODULES, vaultRoot: vault });
    expect((await request(app).post('/api/projects/lifeos/core/archive').send({ note: 'done with it' }).expect(200)).body).toEqual({ archived: true, changed: true });
    expect(((await request(app).get('/api/projects').expect(200)).body.projects as { slug: string }[]).map((p) => p.slug)).toEqual(['mcp']);
    expect(((await request(app).get('/api/projects?archived=1').expect(200)).body.projects as { slug: string }[]).map((p) => p.slug)).toEqual(['core', 'mcp']);
    await request(app).post('/api/projects/lifeos/core/unarchive').send({}).expect(200);
    await request(app).post('/api/areas/lifeos/archive').send({}).expect(200);
    expect((await request(app).get('/api/areas').expect(200)).body.areas).toEqual([]);
    expect((await request(app).get('/api/areas?archived=1').expect(200)).body.areas).toHaveLength(1);
    await request(app).post('/api/areas/nope/archive').send({}).expect(404);
    await request(app).post('/api/areas/lifeos/archive').send({ bogus: 1 }).expect(400);
  });
});

describe('API', () => {
  beforeEach(truncateAll);
  const TOKEN = 'k'.repeat(40);
  const app = () => createApp({ modules: ALL_MODULES, vaultRoot: vault, projectsFeedToken: TOKEN });

  it('serves the board and the report', async () => {
    await seedBasic();
    const board = await request(app()).get('/api/areas').expect(200);
    expect(board.body.areas[0]).toMatchObject({ slug: 'lifeos', status: 'active', team: 'platform', counts: { building: 1, idea: 1 } });
    expect(board.body.goals).toHaveLength(4);
    const tg = await request(app()).get('/api/areas/report?format=telegram').expect(200);
    expect(tg.body.text).toContain('Needs you');
    await request(app()).get('/api/areas/report?format=pdf').expect(400);
  });

  it('the old report path answers 308 to the new one, query string and all', async () => {
    const r = await request(app()).get('/api/projects/report?format=telegram').expect(308);
    expect(r.headers['location']).toBe('/api/areas/report?format=telegram');
    expect((await request(app()).get('/api/projects/report').expect(308)).headers['location']).toBe('/api/areas/report');
    // Followed, it is the report.
    const followed = await request(app()).get('/api/projects/report?format=telegram').redirects(1).expect(200);
    expect(followed.body.text).toContain('Needs you');
  });

  it('lists projects across areas, by area, stage and due date', async () => {
    await seedBasic();
    await upsertArea('other', { title: 'Other' }, 't', { create: true });
    await upsertProject('other', 'site', { title: 'Site', stage: 'building', due: '2026-11-30' }, 't', { create: true });
    const slugs = async (q: string): Promise<string[]> =>
      ((await request(app()).get(`/api/projects${q}`).expect(200)).body.projects as { area: string; slug: string }[]).map((p) => `${p.area}/${p.slug}`).sort();
    expect(await slugs('')).toEqual(['lifeos/core', 'lifeos/mcp', 'other/site']);
    expect(await slugs('?area=lifeos')).toEqual(['lifeos/core', 'lifeos/mcp']);
    expect(await slugs('?stage=building')).toEqual(['lifeos/core', 'other/site']);
    expect(await slugs('?due_before=2026-12-01')).toEqual(['other/site']);
    expect(await slugs('?due_before=2026-11-30')).toEqual([]);
    expect((await request(app()).get('/api/areas/lifeos/projects').expect(200)).body.projects).toHaveLength(2);
    await request(app()).get('/api/projects?stage=shipping').expect(400);
  });

  it('updates, adds projects, records verifications and enforces the gate', async () => {
    await seedBasic();
    await request(app()).patch('/api/areas/lifeos').send({ health: 'yellow', needs_owner: 'Pick a name' }).expect(200);
    await request(app()).post('/api/areas/lifeos/projects').send({ slug: 'sdk', title: 'TS SDK' }).expect(201);
    const refused = await request(app()).patch('/api/projects/lifeos/sdk').send({ stage: 'live' }).expect(409);
    expect(refused.body.error.message).toMatch(/no verification/);
    await request(app())
      .post('/api/projects/lifeos/sdk/verifications')
      .send({ kind: 'test', check: 'npm test', result: 'pass' })
      .expect(201);
    await request(app()).patch('/api/projects/lifeos/sdk').send({ stage: 'live' }).expect(200);
    await request(app()).patch('/api/projects/lifeos/nope').send({ stage: 'live' }).expect(404);
    await request(app()).patch('/api/areas/lifeos').send({ bogus: 1 }).expect(400);
    // An old page still PATCHes an area at the old path, or sends an area a stage: both are refused, neither writes.
    await request(app()).patch('/api/projects/lifeos').send({ health: 'red' }).expect(404);
    await request(app()).patch('/api/areas/lifeos').send({ stage: 'building' }).expect(400);
    const board = (await getBoard(vault)).areas[0]!;
    expect(board).toMatchObject({ health: 'yellow', needs_owner: 'Pick a name' });
    expect(board.projects.find((f) => f.slug === 'sdk')).toMatchObject({ stage: 'live', verification: { result: 'pass' } });
  });

  it('the kiosk feed needs the bearer token and exists only when one is set', async () => {
    await seedBasic();
    await request(app()).get('/api/feed/projects').expect(401);
    await request(app()).get('/api/feed/projects').set('Authorization', 'Bearer wrong').expect(401);
    const ok = await request(app()).get('/api/feed/projects').set('Authorization', `Bearer ${TOKEN}`).expect(200);
    expect(ok.body.projects[0]).toMatchObject({ slug: 'lifeos', title: 'argo-lifeos' });
    expect(ok.headers['cache-control']).toBe('no-store');
    await request(createApp({ modules: ALL_MODULES, vaultRoot: vault })).get('/api/feed/projects').expect(404);
  });

  it('on the server, the board needs a session but the feed only the token', async () => {
    const server = createApp({
      modules: ALL_MODULES,
      vaultRoot: vault,
      projectsFeedToken: TOKEN,
      deployment: 'server',
      auth: { passwordHash: 'x', totpSecret: 'JBSWY3DPEHPK3PXP', publicOrigin: 'https://example.test' },
    });
    await request(server).get('/api/areas').expect(401);
    await request(server).get('/api/projects').expect(401);
    await request(server).get('/api/feed/projects').set('Authorization', `Bearer ${TOKEN}`).expect(200);
  });
});
