import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { patchFrom, parseArgs, writeIfChanged } from '../src/cli-projects.js';
import { query } from '../src/db.js';
import {
  addVerification,
  archiveItem,
  restoreItem,
  buildReport,
  getBoard,
  importSeed,
  kioskSummary,
  nextActionFrom,
  parseGoals,
  upsertFeature,
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
  await upsertProject(
    'lifeos',
    { title: 'argo-lifeos', stage: 'building', team: 'platform', division: 'lifeos-div', priority: 2, goals: ['W1'], devlog_path: 'Areas/lifeos/dev-log/README.md' },
    'test',
    { create: true },
  );
  await upsertFeature('lifeos', 'core', { title: 'Headless core', stage: 'building', owner: 'claude-code' }, 'test', { create: true });
  await upsertFeature('lifeos', 'mcp', { title: 'MCP server' }, 'test', { create: true });
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
    expect(patchFrom(opts)).toEqual({ stage: 'testing', needs_owner: null, goals: ['W1', 'M2'], priority: 3, paths: [] });
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

  it('records every stage move with who and why', async () => {
    await seedBasic();
    await upsertFeature('lifeos', 'core', { stage: 'testing', note: 'endpoints done' }, 'claude@mac');
    const { rows } = await query(
      `SELECT f.slug, s.from_stage, s.to_stage, s.by, s.note FROM stage_changes s LEFT JOIN features f ON f.id = s.feature_id ORDER BY s.id`,
    );
    expect(rows).toEqual([
      { slug: null, from_stage: null, to_stage: 'building', by: 'test', note: 'added' },
      { slug: 'core', from_stage: null, to_stage: 'building', by: 'test', note: 'added' },
      { slug: 'mcp', from_stage: null, to_stage: 'idea', by: 'test', note: 'added' },
      { slug: 'core', from_stage: 'building', to_stage: 'testing', by: 'claude@mac', note: 'endpoints done' },
    ]);
  });

  it('refuses live without a passing verification, then allows it once one passes', async () => {
    await seedBasic();
    await expect(upsertFeature('lifeos', 'core', { stage: 'live' }, 't')).rejects.toThrow(/has no verification/);
    await addVerification('lifeos', 'core', { kind: 'test', check: 'npx vitest run', result: 'fail', evidence: '2 failed' }, 't');
    await expect(upsertFeature('lifeos', 'core', { stage: 'live' }, 't')).rejects.toThrow(/newest verification failed/);
    await addVerification('lifeos', 'core', { kind: 'test', check: 'npx vitest run', result: 'pass', evidence: '40 passed' }, 't');
    const r = await upsertFeature('lifeos', 'core', { stage: 'live' }, 't');
    expect(r.stage_changed).toBe(true);
    const { rows } = await query(`SELECT stage, shipped_at IS NOT NULL AS shipped FROM features WHERE slug = 'core'`);
    expect(rows[0]).toEqual({ stage: 'live', shipped: true });
  });

  it('lets a feature ship unverified only with a reason, kept in the history and flagged in the report', async () => {
    await seedBasic();
    await upsertFeature('lifeos', 'mcp', { stage: 'done', unverified: 'shipped before the tracker' }, 't');
    const { rows } = await query(`SELECT note FROM stage_changes WHERE to_stage = 'done'`);
    expect(rows[0]!.note).toBe('UNVERIFIED: shipped before the tracker');
    const report = await buildReport(vault);
    expect(report.gaps.unverified_shipped).toEqual([{ project: 'lifeos', feature: 'mcp', title: 'MCP server', detail: 'no verification' }]);
  });

  it('rejects unknown projects, teams and bad stages', async () => {
    await expect(upsertProject('nope', { stage: 'live' }, 't')).rejects.toThrow(/no project "nope"/);
    await expect(upsertProject('x', { title: 'X', stage: 'building', team: 'ghosts' }, 't', { create: true })).rejects.toThrow(/no team/);
    await expect(upsertProject('x', { title: 'X', stage: 'building', division: 'ghosts' }, 't', { create: true })).rejects.toThrow(/no division/);
    await seedBasic();
    await expect(upsertFeature('lifeos', 'core', { stage: 'shipping' as never }, 't')).rejects.toThrow();
  });

  it('imports a seed idempotently', async () => {
    const seed = {
      teams: [{ slug: 'platform', name: 'Platform' }],
      projects: [
        {
          slug: 'lifeos', title: 'argo-lifeos', stage: 'building', team: 'platform',
          features: [{ slug: 'core', title: 'Core', stage: 'building' }, { slug: 'ui', title: 'UI' }],
        },
      ],
    };
    expect(await importSeed(seed, 'seed')).toEqual({ teams: 1, projects: 1, features: 2 });
    await importSeed(seed, 'seed');
    // one row each for the project and its two features, and nothing more on the second import
    const { rows } = await query(`SELECT count(*)::int AS n FROM stage_changes`);
    expect(rows[0]!.n).toBe(3);
    // Imports are not news: the report's "moved" list and "shipped this week" ignore them.
    const r = await buildReport(vault);
    expect(r.moved_7d).toEqual([]);
  });

  it('imports existing evidence with its real date, so a shipped feature passes the gate', async () => {
    const seed = {
      projects: [
        {
          slug: 'lifeos', title: 'argo-lifeos', stage: 'designing',
          features: [
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
    await upsertProject('lifeos', { needs_owner: 'Write the README pitch' }, 't');
    await upsertFeature('lifeos', 'core', { stage: 'testing' }, 't');
    // An old in-flight feature: no activity for 10 days.
    await upsertFeature('lifeos', 'mcp', { stage: 'designing' }, 't');
    await query(`UPDATE features SET updated_at = now() - interval '10 days' WHERE slug = 'mcp'`);
    await query(`UPDATE stage_changes SET at = now() - interval '10 days' WHERE feature_id = (SELECT id FROM features WHERE slug = 'mcp')`);

    const r = await buildReport(vault);
    expect(r.totals.projects.building).toBe(1);
    expect(r.totals.features).toMatchObject({ testing: 1, designing: 1 });
    expect(r.needs_owner).toEqual([{ project: 'lifeos', feature: null, title: 'argo-lifeos', detail: 'Write the README pitch', priority: 2, due: null }]);
    expect(r.teams).toEqual([
      { slug: 'platform', name: 'Platform', lead: 'claude-code', projects: ['lifeos'], in_flight: 2, shipped_7d: 0, needs_owner: 1,
        stages: { idea: 0, designing: 0, building: 1, testing: 0, live: 0, parked: 0, done: 0 } },
    ]);
    expect(r.divisions.map((d) => [d.slug, d.projects])).toEqual([['lifeos-div', ['lifeos']]]);
    expect(r.gaps.no_division).toEqual([]);
    expect(r.goals.find((g) => g.code === 'W1')!.projects).toEqual(['lifeos']);
    // W2 is open with nothing linked; M1 is cancelled and T1 is ten-year, so neither is a gap.
    expect(r.gaps.goals_uncovered.map((g) => g.code)).toEqual(['W2']);
    expect(r.gaps.testing_unverified.map((i) => i.feature)).toEqual(['core']);
    expect(r.gaps.stale.map((i) => i.feature)).toEqual(['mcp']);
    expect(r.projects[0]!.next_action).toBe('write `/v1/days` and its test');
    expect(r.projects[0]!.progress).toBe(0);
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
    expect(renderTelegram(r).length).toBeLessThan(3600);
    const k = kioskSummary(r);
    expect(k.projects[0]).toMatchObject({ slug: 'lifeos', stage: 'building', in_flight: [{ title: 'Headless core', stage: 'building' }] });
  });

  it('due dates come back as written, whatever the timezone', async () => {
    await seedBasic();
    await upsertFeature('lifeos', 'core', { due: '2026-10-18' }, 't');
    expect((await getBoard(vault)).projects[0]!.features[0]!.due).toBe('2026-10-18');
  });

  it('an empty tracker still reports', async () => {
    const r = await buildReport(vault);
    expect(r.projects).toEqual([]);
    expect(renderMarkdown(r)).toContain('Nothing is waiting on you.');
  });
});

describe('archive and restore', () => {
  beforeEach(truncateAll);
  const TOKEN = 'k'.repeat(40);
  const app = () => createApp({ modules: ALL_MODULES, vaultRoot: vault, projectsFeedToken: TOKEN });

  it('hides an archived project from the board and keeps its rows and history', async () => {
    await seedBasic();
    await archiveItem('lifeos', null, 'sol', 'done, no activity 30d');
    expect((await getBoard(vault)).projects).toEqual([]);
    const all = (await getBoard(vault, new Date(), { includeArchived: true })).projects[0]!;
    expect(all).toMatchObject({ slug: 'lifeos', archived: true, archived_by: 'sol', archived_reason: 'done, no activity 30d' });
    expect(all.features).toHaveLength(2);
    expect((await query(`SELECT count(*)::int AS n FROM stage_changes`)).rows[0]!.n).toBe(3);
  });

  it('archives one feature and leaves the project visible', async () => {
    await seedBasic();
    await archiveItem('lifeos', 'mcp', 'sol', 'dropped');
    expect((await getBoard(vault)).projects[0]!.features.map((f) => f.slug)).toEqual(['core']);
    const all = (await getBoard(vault, new Date(), { includeArchived: true })).projects[0]!;
    expect(all.archived).toBe(false);
    expect(all.features.find((f) => f.slug === 'mcp')).toMatchObject({ archived: true, archived_reason: 'dropped' });
  });

  it('restores, and writes an audit row for each action', async () => {
    await seedBasic();
    await archiveItem('lifeos', null, 'sol', 'stale');
    await restoreItem('lifeos', null, 'konrad', 'needed again');
    expect((await getBoard(vault)).projects).toHaveLength(1);
    const p = (await query(`SELECT archived, archived_at, archived_by FROM projects WHERE slug = 'lifeos'`)).rows[0];
    expect(p).toEqual({ archived: false, archived_at: null, archived_by: null });
    const { rows } = await query(`SELECT action, reason, by, feature_id FROM archive_events ORDER BY id`);
    expect(rows).toEqual([
      { action: 'archive', reason: 'stale', by: 'sol', feature_id: null },
      { action: 'restore', reason: 'needed again', by: 'konrad', feature_id: null },
    ]);
  });

  it('refuses a repeat, a missing target, an empty reason, and restoring a feature under an archived project', async () => {
    await seedBasic();
    await archiveItem('lifeos', 'core', 'sol', 'x');
    await expect(archiveItem('lifeos', 'core', 'sol', 'x')).rejects.toThrow(/already archived/);
    await expect(restoreItem('lifeos', 'mcp', 'sol')).rejects.toThrow(/not archived/);
    await expect(archiveItem('nope', null, 'sol', 'x')).rejects.toThrow(/no project/);
    await expect(archiveItem('lifeos', 'nope', 'sol', 'x')).rejects.toThrow(/no feature/);
    await expect(archiveItem('lifeos', null, 'sol', '  ')).rejects.toThrow();
    await archiveItem('lifeos', null, 'sol', 'y');
    await expect(restoreItem('lifeos', 'core', 'sol')).rejects.toThrow(/restore the project first/);
  });

  it('keeps archived work out of the report counts but lists it in a collapsed footer', async () => {
    await seedBasic();
    await upsertProject('old', { title: 'Old thing', stage: 'done' }, 'test', { create: true });
    await archiveItem('old', null, 'sol', 'done, no activity 30d');
    const r = await buildReport(vault);
    expect(r.projects.map((p) => p.slug)).toEqual(['lifeos']);
    expect(r.totals.projects.done).toBe(0);
    expect(r.archived).toMatchObject([{ project: 'old', feature: null, detail: 'done, no activity 30d', archived_by: 'sol' }]);
    const md = renderMarkdown(r);
    expect(md).toContain('<summary>Archived (1)</summary>');
    expect(md).toContain('Old thing');
    expect(md).not.toContain('—');
  });

  it('serves the board without archived rows unless include_archived=true', async () => {
    await seedBasic();
    await request(app()).post('/api/projects/lifeos/archive').send({}).expect(400);
    await request(app()).post('/api/projects/lifeos/archive').send({ reason: 'stale' }).expect(200);
    await request(app()).post('/api/projects/lifeos/archive').send({ reason: 'stale' }).expect(409);
    expect((await request(app()).get('/api/projects').expect(200)).body.projects).toEqual([]);
    const all = await request(app()).get('/api/projects?include_archived=true').expect(200);
    expect(all.body.projects[0]).toMatchObject({ slug: 'lifeos', archived: true });
    await request(app()).get('/api/projects?include_archived=maybe').expect(400);
    await request(app()).post('/api/projects/lifeos/restore').send({}).expect(200);
    expect((await request(app()).get('/api/projects').expect(200)).body.projects).toHaveLength(1);
    await request(app()).post('/api/projects/lifeos/features/mcp/archive').send({ reason: 'cut' }).expect(200);
    expect((await request(app()).get('/api/projects').expect(200)).body.projects[0].features).toHaveLength(1);
  });
});

describe('API', () => {
  beforeEach(truncateAll);
  const TOKEN = 'k'.repeat(40);
  const app = () => createApp({ modules: ALL_MODULES, vaultRoot: vault, projectsFeedToken: TOKEN });

  it('serves the board and the report', async () => {
    await seedBasic();
    const board = await request(app()).get('/api/projects').expect(200);
    expect(board.body.projects[0]).toMatchObject({ slug: 'lifeos', team: 'platform', counts: { building: 1, idea: 1 } });
    expect(board.body.goals).toHaveLength(4);
    const tg = await request(app()).get('/api/projects/report?format=telegram').expect(200);
    expect(tg.body.text).toContain('Needs you');
    await request(app()).get('/api/projects/report?format=pdf').expect(400);
  });

  it('updates, adds features, records verifications and enforces the gate', async () => {
    await seedBasic();
    await request(app()).patch('/api/projects/lifeos').send({ health: 'yellow', needs_owner: 'Pick a name' }).expect(200);
    await request(app()).post('/api/projects/lifeos/features').send({ slug: 'sdk', title: 'TS SDK' }).expect(201);
    const refused = await request(app()).patch('/api/projects/lifeos/features/sdk').send({ stage: 'live' }).expect(409);
    expect(refused.body.error.message).toMatch(/no verification/);
    await request(app())
      .post('/api/projects/lifeos/features/sdk/verifications')
      .send({ kind: 'test', check: 'npm test', result: 'pass' })
      .expect(201);
    await request(app()).patch('/api/projects/lifeos/features/sdk').send({ stage: 'live' }).expect(200);
    await request(app()).patch('/api/projects/lifeos/features/nope').send({ stage: 'live' }).expect(404);
    await request(app()).patch('/api/projects/lifeos').send({ bogus: 1 }).expect(400);
    const board = (await getBoard(vault)).projects[0]!;
    expect(board).toMatchObject({ health: 'yellow', needs_owner: 'Pick a name' });
    expect(board.features.find((f) => f.slug === 'sdk')).toMatchObject({ stage: 'live', verification: { result: 'pass' } });
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
    await request(server).get('/api/projects').expect(401);
    await request(server).get('/api/feed/projects').set('Authorization', `Bearer ${TOKEN}`).expect(200);
  });
});
