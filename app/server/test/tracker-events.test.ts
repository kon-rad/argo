import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runAreasCli } from '../src/cli-areas.js';
import { runProjectsCli } from '../src/cli-projects.js';
import { scanVault } from '../src/connectors/vault/scan.js';
import { query, withTransaction } from '../src/db.js';
import { addVerification, recordKpi, removeArea, setAreaArchived, setProjectArchived, upsertArea, upsertProject } from '../src/projects.js';
import { ALL_MODULES, truncateAll, vaultSourceId } from './helpers.js';

/**
 * The change history (1756000018500): `tracker_events` written by triggers, `stage_changes`
 * as a view over it, KPI readings, and the scanner's frontmatter events.
 */

interface Event {
  actor: string; source: string; area_slug: string; project: string | null; kind: string; field: string | null;
  from_value: unknown; to_value: unknown; note: string | null;
}

const events = async (where = 'true'): Promise<Event[]> =>
  (await query<Event>(
    `SELECT e.actor, e.source, e.area_slug, p.slug AS project, e.kind, e.field, e.from_value, e.to_value, e.note
       FROM tracker_events e LEFT JOIN projects p ON p.id = e.project_id WHERE ${where} ORDER BY e.id`,
  )).rows;
const count = async (where = 'true'): Promise<number> => (await query<{ n: number }>(`SELECT count(*)::int AS n FROM tracker_events WHERE ${where}`)).rows[0]!.n;
const lastId = async (): Promise<number> => (await query<{ id: number }>(`SELECT coalesce(max(id), 0)::int AS id FROM tracker_events`)).rows[0]!.id;

async function seed(): Promise<void> {
  await upsertArea('lifeos', { title: 'LifeOS', priority: 2 }, 'seed', { create: true });
  await upsertProject('lifeos', 'core', { title: 'Core', outcome: 'The core answers', stage: 'building' }, 'seed', { create: true });
}

const io = (vaultRoot: string, out: string[] = [], err: string[] = []) => ({ out: (l: string) => out.push(l), err: (l: string) => err.push(l), now: new Date('2026-11-20T00:00:00Z'), vaultRoot });

describe('tracker_events: the triggers', () => {
  beforeEach(truncateAll);

  it('writes one created row per insert, with every field it was created with', async () => {
    await seed();
    const rows = await events();
    expect(rows.map((r) => [r.kind, r.project, r.actor, r.source, r.field, r.note])).toEqual([
      ['created', null, 'seed', 'api', null, 'added'],
      ['created', 'core', 'seed', 'api', null, 'added'],
    ]);
    expect(rows[0]!.to_value).toMatchObject({ slug: 'lifeos', title: 'LifeOS', status: 'active', priority: 2 });
    expect(rows[1]!.to_value).toMatchObject({ area_slug: 'lifeos', slug: 'core', outcome: 'The core answers', stage: 'building' });
    // The bookkeeping columns are not history.
    expect(rows[1]!.to_value).not.toHaveProperty('updated_at');
    expect(rows[1]!.to_value).not.toHaveProperty('updated_by');
  });

  it('writes exactly one row per changed column, with the actor, the old and the new value', async () => {
    await seed();
    const before = await lastId();
    await upsertProject('lifeos', 'core', { stage: 'testing', due: '2026-12-31', next_action: 'write the test', title: 'Core', note: 'endpoints done' }, 'dax');
    expect(await events(`e.id > ${before}`)).toEqual([
      { actor: 'dax', source: 'api', area_slug: 'lifeos', project: 'core', kind: 'changed', field: 'due', from_value: null, to_value: '2026-12-31', note: 'endpoints done' },
      { actor: 'dax', source: 'api', area_slug: 'lifeos', project: 'core', kind: 'changed', field: 'next_action', from_value: null, to_value: 'write the test', note: 'endpoints done' },
      { actor: 'dax', source: 'api', area_slug: 'lifeos', project: 'core', kind: 'stage', field: 'stage', from_value: 'building', to_value: 'testing', note: 'endpoints done' },
    ]);
    // Three columns changed (the title was set to what it was): three rows, and none for updated_at or updated_by,
    // on the project or on the area the write touches.
    expect(await count(`id > ${before}`)).toBe(3);

    // Writing the same values again changes no column, so it writes nothing.
    await upsertProject('lifeos', 'core', { stage: 'testing', due: '2026-12-31' }, 'dax');
    expect(await count(`id > ${before}`)).toBe(3);

    // One column of an area: one row.
    await upsertArea('lifeos', { priority: 1 }, 'orin');
    expect(await events(`e.id > ${before + 3}`)).toEqual([
      { actor: 'orin', source: 'api', area_slug: 'lifeos', project: null, kind: 'changed', field: 'priority', from_value: 2, to_value: 1, note: null },
    ]);
    await upsertArea('lifeos', { status: 'parked', note: 'paused' }, 'orin');
    expect((await events(`e.id > ${before + 4}`)).map((r) => [r.kind, r.field, r.from_value, r.to_value, r.note])).toEqual([['stage', 'status', 'active', 'parked', 'paused']]);
  });

  it('records archive and unarchive as their own kinds, and a verification writes no event', async () => {
    await seed();
    const before = await lastId();
    await setProjectArchived('lifeos', 'core', true, 'dax', 'superseded');
    await setProjectArchived('lifeos', 'core', false, 'dax');
    await setAreaArchived('lifeos', true, 'dax');
    await addVerification('lifeos', 'core', { kind: 'test', check: 'npm test', result: 'pass' }, 'dax');
    const rows = await events(`e.id > ${before}`);
    expect(rows.map((r) => [r.kind, r.project, r.field, r.actor, r.note])).toEqual([
      ['archived', 'core', 'archived_at', 'dax', 'superseded'],
      ['unarchived', 'core', 'archived_at', 'dax', null],
      ['archived', null, 'archived_at', 'dax', null],
    ]);
    expect(rows[0]!.from_value).toBeNull();
    expect(typeof rows[0]!.to_value).toBe('string');
    expect(rows[1]!.to_value).toBeNull();
  });

  it('names the CLI as the source, and the --by as the actor', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sb-events-'));
    expect(await runAreasCli(['add', 'lifeos', '--title', 'LifeOS', '--by', 'konrad'], io(root))).toBe(0);
    expect(await runProjectsCli(['add', 'lifeos/core', '--outcome', 'The core answers', '--by', 'dax'], io(root))).toBe(0);
    expect(await runProjectsCli(['set', 'lifeos/core', '--stage', 'designing', '--by', 'dax'], io(root))).toBe(0);
    expect((await events()).map((r) => [r.kind, r.actor, r.source])).toEqual([
      ['created', 'konrad', 'cli'],
      ['created', 'dax', 'cli'],
      ['stage', 'dax', 'cli'],
    ]);
  });

  it('logs a write that names nobody as unknown: no path can skip the log', async () => {
    await seed();
    const before = await lastId();
    await query(`UPDATE projects SET owner = 'someone' WHERE slug = 'core'`);
    expect(await events(`e.id > ${before}`)).toEqual([
      { actor: 'unknown', source: 'unknown', area_slug: 'lifeos', project: 'core', kind: 'changed', field: 'owner', from_value: null, to_value: 'someone', note: null },
    ]);
    // A setting from an earlier transaction on the same connection does not leak into this one.
    await withTransaction(async (tx) => {
      await tx.query(`SELECT set_config('app.actor', 'ghost', true)`);
    });
    await query(`UPDATE projects SET owner = NULL WHERE slug = 'core'`);
    expect((await events(`e.id > ${before + 1}`)).map((r) => r.actor)).toEqual(['unknown']);
  });

  it('the board names the actor when a card makes its assignee the owner of a project', async () => {
    await seed();
    await query(`INSERT INTO org_agents (name, runtime, role, org_version) VALUES ('owner', 'human', 'CEO', 'v'), ('dax', 'claude-code', 'Engineer', 'v')`);
    const before = await lastId();
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM board_card_create('owner', 'exo', 'build it', NULL, '{}', 'dax', 'lifeos', 'core', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false)`,
    );
    expect(await events(`e.id > ${before}`)).toEqual([
      { actor: 'owner', source: 'board', area_slug: 'lifeos', project: 'core', kind: 'changed', field: 'owner', from_value: null, to_value: 'dax', note: `card ${rows[0]!.id}` },
    ]);
  });
});

describe('tracker_events is append-only', () => {
  beforeEach(truncateAll);

  it('refuses UPDATE and DELETE from the role the app connects as', async () => {
    await seed();
    await expect(query(`UPDATE tracker_events SET actor = 'someone-else'`)).rejects.toThrow(/tracker_events is append-only: UPDATE is refused/);
    await expect(query(`DELETE FROM tracker_events`)).rejects.toThrow(/tracker_events is append-only: DELETE is refused/);
    // The view is no way around it.
    await expect(query(`UPDATE stage_changes SET note = 'rewritten'`)).rejects.toThrow(/append-only/);
    await expect(query(`DELETE FROM stage_changes`)).rejects.toThrow(/append-only/);
    expect(await count()).toBe(2);
    expect((await events()).map((r) => r.actor)).toEqual(['seed', 'seed']);
  });

  it('gives the agents role SELECT and nothing else', async () => {
    await seed();
    const asAgent = (sql: string): Promise<unknown> =>
      withTransaction(async (tx) => {
        await tx.query(`SET LOCAL ROLE sb_org`);
        return (await tx.query(sql)).rows;
      });
    expect(await asAgent(`SELECT count(*)::int AS n FROM tracker_events`)).toEqual([{ n: 2 }]);
    expect(await asAgent(`SELECT count(*)::int AS n FROM stage_changes`)).toEqual([{ n: 2 }]);
    await expect(asAgent(`UPDATE tracker_events SET actor = 'x'`)).rejects.toThrow(/permission denied/);
    await expect(asAgent(`DELETE FROM tracker_events`)).rejects.toThrow(/permission denied/);
    await expect(asAgent(`INSERT INTO tracker_events (area_slug, kind) VALUES ('lifeos', 'changed')`)).rejects.toThrow(/permission denied/);
    await expect(asAgent(`DELETE FROM kpi_readings`)).rejects.toThrow(/permission denied/);
    const grants = await query<{ p: string }>(
      `SELECT privilege_type AS p FROM information_schema.role_table_grants WHERE table_name = 'tracker_events' AND grantee IN ('sb_org', 'PUBLIC') ORDER BY 1`,
    );
    expect(grants.rows.map((r) => r.p)).toEqual(['SELECT']);
  });

  it('still lets a purge take the history of what it deletes', async () => {
    await seed();
    await upsertArea('other', { title: 'Other' }, 'seed', { create: true });
    await removeArea('lifeos');
    expect((await events()).map((r) => r.area_slug)).toEqual(['other']);
  });
});

describe('stage_changes as a view', () => {
  beforeEach(truncateAll);

  const FILE = join(import.meta.dirname, '..', '..', 'db', 'migrations', '1756000018500_tracker-events.sql');
  const text = readFileSync(FILE, 'utf8');
  const cut = text.indexOf('-- Down Migration');
  const UP = text.slice(0, cut);
  const DOWN = text.slice(cut);
  const migrate = (sql: string): Promise<unknown> => withTransaction((tx) => tx.query(sql));
  const isView = async (): Promise<boolean> => (await query<{ k: string }>(`SELECT relkind AS k FROM pg_class WHERE relname = 'stage_changes'`)).rows[0]!.k === 'v';
  const all = async () => (await query(`SELECT id, area_slug, project_id, from_stage, to_stage, at, by, note FROM stage_changes ORDER BY id`)).rows;
  const columns = async () =>
    (await query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'stage_changes' ORDER BY ordinal_position`)).rows;

  // Whatever a failed assertion left behind, the rest of the suite needs the view.
  afterAll(async () => {
    if (!(await isView())) await migrate(UP);
    await truncateAll();
  });

  it('returns the same rows as the table did, for every kind of row the table held', async () => {
    await seed();
    await upsertArea('beta', { title: 'Beta' }, 'seed', { create: true });
    const core = (await query<{ id: number }>(`SELECT id FROM projects WHERE slug = 'core'`)).rows[0]!.id;

    // ---- back to the table, as it was before this migration
    await migrate(DOWN);
    expect(await isView()).toBe(false);
    const cols = await columns();
    // What the application wrote there: a creation, moves, an unverified ship, an archive and its undo,
    // the rename's note row, a row with nobody named. Ids with a gap, as deletes leave them.
    await query(`TRUNCATE stage_changes`);
    await query(
      `INSERT INTO stage_changes (id, area_slug, project_id, from_stage, to_stage, at, by, note) VALUES
         (3,  'lifeos', NULL, NULL,       'active',     '2026-01-05T10:00:00Z', 'konrad',    'added'),
         (4,  'lifeos', $1,   NULL,       'idea',       '2026-01-05T10:01:00Z', 'konrad',    'imported · from the old list'),
         (7,  'lifeos', $1,   'idea',     'building',   '2026-02-01T09:00:00Z', 'dax',       NULL),
         (8,  'lifeos', $1,   'building', 'live',       '2026-03-01T09:00:00Z', 'dax',       'UNVERIFIED: shipped before the tracker · hotfix'),
         (9,  'lifeos', $1,   NULL,       'archived',   '2026-04-01T09:00:00Z', 'konrad',    'superseded'),
         (12, 'lifeos', $1,   NULL,       'unarchived', '2026-04-02T09:00:00Z', NULL,        NULL),
         (13, 'beta',   NULL, 'testing',  'active',     '2026-05-01T09:00:00Z', 'migration', 'para-rename: stage was testing, due 2026-12-01'),
         (20, 'beta',   NULL, 'active',   'parked',     '2026-06-01T09:00:00Z', NULL,        'paused')`,
      [core],
    );
    await query(`SELECT setval('stage_changes_id_seq', 20)`);
    const before = await all();
    expect(before).toHaveLength(8);

    // ---- up: the table becomes the view
    await migrate(UP);
    expect(await isView()).toBe(true);
    expect(await all()).toEqual(before);
    expect(await columns()).toEqual(cols);
    // In the log they are stage rows (and archive rows), marked as migrated, under the same ids.
    expect((await query(`SELECT id::int, kind, source, actor FROM tracker_events ORDER BY id`)).rows).toEqual([
      { id: 3, kind: 'stage', source: 'migration', actor: 'konrad' },
      { id: 4, kind: 'stage', source: 'migration', actor: 'konrad' },
      { id: 7, kind: 'stage', source: 'migration', actor: 'dax' },
      { id: 8, kind: 'stage', source: 'migration', actor: 'dax' },
      { id: 9, kind: 'archived', source: 'migration', actor: 'konrad' },
      { id: 12, kind: 'unarchived', source: 'migration', actor: 'unknown' },
      { id: 13, kind: 'stage', source: 'migration', actor: 'migration' },
      { id: 20, kind: 'stage', source: 'migration', actor: 'unknown' },
    ]);

    // New rows carry on after the old ids, and read through the view like the old ones.
    await upsertProject('lifeos', 'core', { stage: 'testing' }, 'dax');
    const after = await all();
    expect(after.slice(0, 8)).toEqual(before);
    expect(after.slice(8)).toMatchObject([{ id: 21, area_slug: 'lifeos', project_id: core, from_stage: 'building', to_stage: 'testing', by: 'dax', note: null }]);

    // ---- down and up once more: nothing the view shows is lost either way
    await migrate(DOWN);
    expect(await all()).toEqual(after);
    await migrate(UP);
    expect(await all()).toEqual(after);
  });

  it('shows what the application writes now in the shape it always had', async () => {
    await seed();
    await upsertProject('lifeos', 'core', { stage: 'testing', due: '2026-12-31', note: 'endpoints done' }, 'dax');
    await upsertProject('lifeos', 'core', { stage: 'done', unverified: 'shipped before the tracker' }, 'dax');
    await setProjectArchived('lifeos', 'core', true, 'konrad', 'superseded');
    await query(`UPDATE areas SET status = 'parked' WHERE slug = 'lifeos'`);
    expect((await query(`SELECT p.slug, s.from_stage, s.to_stage, s.by, s.note FROM stage_changes s LEFT JOIN projects p ON p.id = s.project_id ORDER BY s.id`)).rows).toEqual([
      { slug: null, from_stage: null, to_stage: 'active', by: 'seed', note: 'added' },
      { slug: 'core', from_stage: null, to_stage: 'building', by: 'seed', note: 'added' },
      // The due date changed in the same write: it is in tracker_events, and not a stage change.
      { slug: 'core', from_stage: 'building', to_stage: 'testing', by: 'dax', note: 'endpoints done' },
      { slug: 'core', from_stage: 'testing', to_stage: 'done', by: 'dax', note: 'UNVERIFIED: shipped before the tracker' },
      { slug: 'core', from_stage: null, to_stage: 'archived', by: 'konrad', note: 'superseded' },
      { slug: null, from_stage: 'active', to_stage: 'parked', by: null, note: null },
    ]);
  });
});

describe('frontmatter events from the scanner', () => {
  beforeEach(truncateAll);

  const home = (target: number, body = 'What the area is.') =>
    `---\narea: lifeos\nkind: area\ndescription: A private journal\nkpis:\n  - {key: paying-users, name: Paying users, unit: users, target: ${target}}\n---\n\n# LifeOS\n\n${body}\n`;

  it('writes one event when a kpis target changes, none for a body edit, none for the first scan', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sb-events-scan-'));
    const sourceId = await vaultSourceId();
    mkdirSync(join(root, 'Areas/lifeos/projects/core'), { recursive: true });
    writeFileSync(join(root, 'Areas/lifeos/README.md'), home(100));
    writeFileSync(join(root, 'Areas/lifeos/projects/core/README.md'), '---\nkind: project\narea: lifeos\nproject: core\noutcome: The core answers\n---\n\n# Core\n');
    writeFileSync(join(root, 'Areas/lifeos/notes.md'), '---\nstatus: draft\n---\n\nAn ordinary note.\n');
    await seed();
    const scan = () => scanVault({ root, sourceId });
    const fm = () => events(`e.kind = 'frontmatter'`);

    // The first scan is the baseline: nothing changed yet.
    await scan();
    expect(await fm()).toEqual([]);

    // The target moves from 100 to 250: one row, for the key that changed, with both values.
    writeFileSync(join(root, 'Areas/lifeos/README.md'), home(250));
    await scan();
    expect(await fm()).toEqual([
      {
        actor: 'scanner', source: 'scanner', area_slug: 'lifeos', project: null, kind: 'frontmatter', field: 'kpis',
        from_value: [{ key: 'paying-users', name: 'Paying users', unit: 'users', target: 100 }],
        to_value: [{ key: 'paying-users', name: 'Paying users', unit: 'users', target: 250 }],
        note: 'Areas/lifeos/README.md',
      },
    ]);

    // A body edit writes nothing, and neither does a scan with nothing changed.
    writeFileSync(join(root, 'Areas/lifeos/README.md'), home(250, 'What the area is, rewritten at length.'));
    await scan();
    await scan();
    expect(await fm()).toHaveLength(1);

    // A project's home note is logged under the project; a key added and a key removed are one row each.
    writeFileSync(join(root, 'Areas/lifeos/projects/core/README.md'), '---\nkind: project\narea: lifeos\nproject: core\nlinks:\n  repos: [example/core]\n---\n\n# Core\n');
    await scan();
    expect((await fm()).slice(1).map((r) => [r.project, r.field, r.from_value, r.to_value])).toEqual([
      ['core', 'links', null, { repos: ['example/core'] }],
      ['core', 'outcome', 'The core answers', null],
    ]);

    // A note that is not a home note, and a home note of an area the tracker does not know, write nothing.
    writeFileSync(join(root, 'Areas/lifeos/notes.md'), '---\nstatus: final\n---\n\nAn ordinary note.\n');
    mkdirSync(join(root, 'Areas/elsewhere'), { recursive: true });
    writeFileSync(join(root, 'Areas/elsewhere/README.md'), '---\narea: elsewhere\nkind: area\n---\n');
    await scan();
    writeFileSync(join(root, 'Areas/elsewhere/README.md'), '---\narea: elsewhere\nkind: area\ndescription: new\n---\n');
    await scan();
    expect(await fm()).toHaveLength(3);
  });
});

describe('KPI readings', () => {
  beforeEach(truncateAll);

  function vaultWithKpis(): string {
    const root = mkdtempSync(join(tmpdir(), 'sb-events-kpi-'));
    mkdirSync(join(root, 'Areas/lifeos'), { recursive: true });
    writeFileSync(
      join(root, 'Areas/lifeos/README.md'),
      '---\narea: lifeos\nkind: area\nkpis:\n  - {key: paying-users, name: Paying users, unit: users, target: 100}\n  - {key: mrr, name: MRR, unit: usd}\n---\n\n# LifeOS\n',
    );
    return root;
  }

  it('cli-areas record stores a reading and one kpi_reading event', async () => {
    const root = vaultWithKpis();
    await seed();
    await upsertArea('lifeos', { home_path: 'Areas/lifeos' }, 'seed');
    const out: string[] = [];
    expect(await runAreasCli(['record', 'lifeos', 'paying-users', '12', '--at', '2026-11-01', '--note', 'from the dashboard', '--by', 'konrad'], io(root, out))).toBe(0);
    expect(out[0]).toMatch(/^recorded lifeos paying-users = 12 \(reading \d+\)$/);
    expect(await runAreasCli(['record', 'lifeos', 'paying-users', '17.5', '--by', 'konrad'], io(root, out))).toBe(0);
    expect((await query(`SELECT area_slug, project_id, kpi_key, value::text, to_char(at, 'YYYY-MM-DD') AS day, source, actor, note FROM kpi_readings ORDER BY id LIMIT 1`)).rows).toEqual([
      { area_slug: 'lifeos', project_id: null, kpi_key: 'paying-users', value: '12', day: '2026-11-01', source: 'cli', actor: 'konrad', note: 'from the dashboard' },
    ]);
    expect(await events(`e.kind = 'kpi_reading'`)).toEqual([
      { actor: 'konrad', source: 'kpi', area_slug: 'lifeos', project: null, kind: 'kpi_reading', field: 'paying-users', from_value: null, to_value: 12, note: 'from the dashboard' },
      { actor: 'konrad', source: 'kpi', area_slug: 'lifeos', project: null, kind: 'kpi_reading', field: 'paying-users', from_value: 12, to_value: 17.5, note: null },
    ]);
  });

  it('refuses a key the home note does not define, and lists the ones it does', async () => {
    const root = vaultWithKpis();
    await seed();
    await upsertArea('lifeos', { home_path: 'Areas/lifeos/README.md' }, 'seed');
    await expect(recordKpi(root, 'lifeos', { key: 'payng-users', value: 12 }, 'konrad')).rejects.toThrow(
      'lifeos has no KPI "payng-users". Known keys: paying-users, mrr (the kpis: frontmatter of Areas/lifeos/README.md)',
    );
    await expect(runAreasCli(['record', 'lifeos', 'churn', '3'], io(root))).rejects.toThrow(/Known keys: paying-users, mrr/);
    await expect(runAreasCli(['record', 'lifeos', 'mrr', 'lots'], io(root))).rejects.toThrow(/the value is a number/);
    await expect(recordKpi(root, 'lifeos', { key: 'mrr', value: 1, at: 'yesterday-ish' }, 'konrad')).rejects.toThrow(/not a date/);
    await expect(recordKpi(root, 'nope', { key: 'mrr', value: 1 }, 'konrad')).rejects.toThrow(/no area "nope"/);
    // Nothing was stored, and nothing logged.
    expect((await query(`SELECT count(*)::int AS n FROM kpi_readings`)).rows[0]).toEqual({ n: 0 });
    expect(await count(`kind = 'kpi_reading'`)).toBe(0);

    // An area with no home note, or a home note with no kpis, has no KPIs to record.
    await upsertArea('bare', { title: 'Bare' }, 'seed', { create: true });
    await expect(recordKpi(root, 'bare', { key: 'mrr', value: 1 }, 'konrad')).rejects.toThrow(/bare has no home note/);
    mkdirSync(join(root, 'Areas/bare'), { recursive: true });
    writeFileSync(join(root, 'Areas/bare/README.md'), '---\narea: bare\nkind: area\n---\n');
    await upsertArea('bare', { home_path: 'Areas/bare' }, 'seed');
    await expect(recordKpi(root, 'bare', { key: 'mrr', value: 1 }, 'konrad')).rejects.toThrow(/defines none in its kpis: frontmatter/);
  });

  it('POST /api/areas/:area/kpis records a reading, and answers 400 with the known keys for an unknown one', async () => {
    const root = vaultWithKpis();
    await seed();
    await upsertArea('lifeos', { home_path: 'Areas/lifeos' }, 'seed');
    const app = createApp({ modules: ALL_MODULES, vaultRoot: root });
    const ok = await request(app).post('/api/areas/lifeos/kpis').send({ key: 'mrr', value: 420.5, note: 'month end' }).expect(201);
    expect(ok.body).toEqual({ id: expect.any(Number) });
    expect((await query(`SELECT kpi_key, value::text, source, note FROM kpi_readings`)).rows).toEqual([{ kpi_key: 'mrr', value: '420.5', source: 'api', note: 'month end' }]);
    expect((await events(`e.kind = 'kpi_reading'`)).map((r) => [r.field, r.to_value, r.source])).toEqual([['mrr', 420.5, 'kpi']]);
    const bad = await request(app).post('/api/areas/lifeos/kpis').send({ key: 'churn', value: 3 }).expect(400);
    expect(JSON.stringify(bad.body)).toMatch(/Known keys: paying-users, mrr/);
    await request(app).post('/api/areas/lifeos/kpis').send({ key: 'mrr', value: 'lots' }).expect(400);
    await request(app).post('/api/areas/nope/kpis').send({ key: 'mrr', value: 1 }).expect(404);
  });
});
