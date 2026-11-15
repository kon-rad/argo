import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { query, withTransaction } from '../src/db.js';
import { addVerification, upsertArea, upsertProject } from '../src/projects.js';
import { truncateAll } from './helpers.js';

/**
 * The PARA rename (1756000018400): `projects` became `areas`, `features` became `projects`.
 *
 * The suite's database already has the migration applied, so "up, down, up" here is: seed in the
 * new schema, run the file's own Down part, then its Up part, and once more each way. The SQL
 * comes from the migration file itself, so this checks what a deploy and a rollback would run.
 *
 * If a later migration changes these tables, this file's Down part no longer fits the newest
 * schema: freeze this test at that point (skip it) rather than bending the old migration.
 */
const FILE = join(import.meta.dirname, '..', '..', 'db', 'migrations', '1756000018400_para-areas-projects.sql');
const text = readFileSync(FILE, 'utf8');
const cut = text.indexOf('-- Down Migration');
const UP = text.slice(0, cut);
const DOWN = text.slice(cut);

/** One migration direction in one transaction, as node-pg-migrate runs it. */
const migrate = (sql: string): Promise<unknown> => withTransaction((tx) => tx.query(sql));
const n = async (sql: string): Promise<number> => Number((await query<{ n: string }>(`SELECT count(*) AS n FROM ${sql}`)).rows[0]!.n);
const renamed = async (): Promise<boolean> => (await query<{ t: string | null }>(`SELECT to_regclass('public.areas')::text AS t`)).rows[0]!.t !== null;

/** Row counts by what the rows are, whichever names the schema has right now. */
async function counts(): Promise<Record<string, number>> {
  const isNew = await renamed();
  return {
    areas: await n(isNew ? 'areas' : 'projects'),
    projects: await n(isNew ? 'projects' : 'features'),
    stage_changes: await n('stage_changes'),
    verifications: await n('verifications'),
    cards: await n('cards'),
    org_messages: await n('org_messages'),
    memory_facts: await n('memory_facts'),
    teams: await n('teams'),
    divisions: await n('divisions'),
  };
}

async function seed(): Promise<void> {
  await truncateAll();
  await upsertArea('alpha', { title: 'Alpha', priority: 1 }, 'seed', { create: true });
  await upsertArea('beta', { title: 'Beta' }, 'seed', { create: true });
  await upsertArea('gamma', { title: 'Gamma' }, 'seed', { create: true });
  await upsertProject('alpha', 'one', { title: 'First', stage: 'building' }, 'seed', { create: true });
  await upsertProject('alpha', 'two', { title: 'Second' }, 'seed', { create: true });
  await upsertProject('beta', 'one', { title: 'Beta one' }, 'seed', { create: true });
  await addVerification('alpha', 'one', { kind: 'test', check: 'ran it', result: 'pass' }, 'seed');
  await query(`INSERT INTO org_agents (name, runtime, role, org_version) VALUES ('owner', 'human', 'CEO', 'v') ON CONFLICT DO NOTHING`);
  await query(`INSERT INTO boards (slug, name) VALUES ('exo', 'Exo') ON CONFLICT DO NOTHING`);
  await query(`INSERT INTO org_channels (slug, kind) VALUES ('leads', 'shared') ON CONFLICT DO NOTHING`);
  await query(
    `INSERT INTO cards (id, board_slug, title, created_by, area_slug, project_slug) VALUES
       ('t_00000a', 'exo', 'tagged with a project', 'owner', 'alpha', 'one'),
       ('t_00000b', 'exo', 'tagged with an area', 'owner', 'alpha', NULL),
       ('t_00000c', 'exo', 'not tagged', 'owner', NULL, NULL)`,
  );
  await query(`INSERT INTO org_messages (channel_slug, author, kind, body, area_slug, project_slug) VALUES ('leads', 'owner', 'message', 'about a project', 'alpha', 'one')`);
  await query(`INSERT INTO memory_facts (subject, claim, source, author, area_slug) VALUES ('s', 'c', 'src', 'owner', 'beta')`);
}

describe('the PARA rename migration', () => {
  beforeAll(seed);
  // Whatever a failed assertion left behind, the rest of the suite needs the renamed schema.
  afterAll(async () => {
    if (!(await renamed())) await migrate(UP);
    await truncateAll();
  });

  it('runs up, down, up with every row count equal, and maps stage to status and back', async () => {
    // ---- down: back to projects and features
    await migrate(DOWN);
    expect(await renamed()).toBe(false);
    const a = await counts();
    expect(a).toMatchObject({ areas: 3, projects: 3, verifications: 1, cards: 3, org_messages: 1, memory_facts: 1 });
    const oldCols = async (table: string): Promise<string[]> =>
      (await query<{ c: string }>(`SELECT column_name AS c FROM information_schema.columns WHERE table_name = $1 ORDER BY 1`, [table])).rows.map((r) => r.c);
    expect(await oldCols('cards')).toEqual(expect.arrayContaining(['project_slug', 'feature_slug']));
    expect(await oldCols('cards')).not.toContain('area_slug');
    expect(await oldCols('projects')).toEqual(expect.arrayContaining(['stage', 'due', 'area']));
    expect(await oldCols('projects')).not.toEqual(expect.arrayContaining(['status']));
    expect(await oldCols('features')).not.toEqual(expect.arrayContaining(['outcome']));
    // The tags came back under their old names.
    expect((await query(`SELECT project_slug, feature_slug FROM cards ORDER BY id`)).rows).toEqual([
      { project_slug: 'alpha', feature_slug: 'one' }, { project_slug: 'alpha', feature_slug: null }, { project_slug: null, feature_slug: null },
    ]);

    // What a pre-rename tracker holds: stages on every row, a due date on one, a parked and a done row.
    await query(`UPDATE projects SET stage = 'testing', due = '2026-12-01' WHERE slug = 'alpha'`);
    await query(`UPDATE projects SET stage = 'parked' WHERE slug = 'beta'`);
    await query(`UPDATE projects SET stage = 'done' WHERE slug = 'gamma'`);

    // ---- up: areas and projects
    await migrate(UP);
    expect(await renamed()).toBe(true);
    const b = await counts();
    // Nothing lost, and exactly one note row per area in the history.
    expect(b).toEqual({ ...a, stage_changes: a.stage_changes! + 3 });
    expect((await query(`SELECT slug, status, home_path, archived_at FROM areas ORDER BY slug`)).rows).toEqual([
      { slug: 'alpha', status: 'active', home_path: null, archived_at: null },
      { slug: 'beta', status: 'parked', home_path: null, archived_at: null },
      { slug: 'gamma', status: 'active', home_path: null, archived_at: null },
    ]);
    expect((await query(`SELECT area_slug, from_stage, to_stage, note FROM stage_changes WHERE by = 'migration' ORDER BY area_slug`)).rows).toEqual([
      { area_slug: 'alpha', from_stage: 'testing', to_stage: 'active', note: 'para-rename: stage was testing, due 2026-12-01' },
      { area_slug: 'beta', from_stage: 'parked', to_stage: 'parked', note: 'para-rename: stage was parked' },
      { area_slug: 'gamma', from_stage: 'done', to_stage: 'active', note: 'para-rename: stage was done' },
    ]);
    // Projects keep every row and gain an outcome, backfilled from the title.
    expect((await query(`SELECT area_slug, slug, title, outcome, next_action, archived_at FROM projects ORDER BY area_slug, slug`)).rows).toEqual([
      { area_slug: 'alpha', slug: 'one', title: 'First', outcome: 'First', next_action: null, archived_at: null },
      { area_slug: 'alpha', slug: 'two', title: 'Second', outcome: 'Second', next_action: null, archived_at: null },
      { area_slug: 'beta', slug: 'one', title: 'Beta one', outcome: 'Beta one', next_action: null, archived_at: null },
    ]);
    expect((await query(`SELECT area_slug, project_slug FROM cards ORDER BY id`)).rows).toEqual([
      { area_slug: 'alpha', project_slug: 'one' }, { area_slug: 'alpha', project_slug: null }, { area_slug: null, project_slug: null },
    ]);
    expect((await query(`SELECT area_slug, project_slug FROM org_messages`)).rows).toEqual([{ area_slug: 'alpha', project_slug: 'one' }]);
    expect((await query(`SELECT area_slug FROM memory_facts`)).rows).toEqual([{ area_slug: 'beta' }]);

    // ---- down again: the stage and the due date come back from the note rows, which are then gone
    await migrate(DOWN);
    const c = await counts();
    expect(c).toEqual(a);
    expect((await query(`SELECT slug, stage, to_char(due, 'YYYY-MM-DD') AS due, area FROM projects ORDER BY slug`)).rows).toEqual([
      { slug: 'alpha', stage: 'testing', due: '2026-12-01', area: null },
      { slug: 'beta', stage: 'parked', due: null, area: null },
      { slug: 'gamma', stage: 'done', due: null, area: null },
    ]);

    // ---- up again: the same rows as the first time
    await migrate(UP);
    const d = await counts();
    expect(d).toEqual(b);
    expect((await query(`SELECT slug, status FROM areas ORDER BY slug`)).rows).toEqual([
      { slug: 'alpha', status: 'active' }, { slug: 'beta', status: 'parked' }, { slug: 'gamma', status: 'active' },
    ]);
  });

  it('clears a tag that points at a project that is gone, instead of failing to add the guard', async () => {
    await migrate(DOWN);
    // Before the rename nothing tied feature_slug to a row: a card could name a feature that was deleted.
    await query(`INSERT INTO cards (id, board_slug, title, created_by, project_slug, feature_slug) VALUES ('t_00000d', 'exo', 'dangling', 'owner', 'alpha', 'deleted-long-ago')`);
    await query(`INSERT INTO cards (id, board_slug, title, created_by, project_slug, feature_slug) VALUES ('t_00000e', 'exo', 'orphan', 'owner', NULL, 'one')`);
    await migrate(UP);
    expect((await query(`SELECT id, area_slug, project_slug FROM cards WHERE id IN ('t_00000d', 't_00000e') ORDER BY id`)).rows).toEqual([
      { id: 't_00000d', area_slug: 'alpha', project_slug: null },
      { id: 't_00000e', area_slug: null, project_slug: null },
    ]);
    await query(`DELETE FROM cards WHERE id IN ('t_00000d', 't_00000e')`);
  });
});

describe('a caller that still thinks project means area', () => {
  beforeAll(seed);
  afterAll(truncateAll);

  it('cannot write an area slug into a project column: the check refuses it', async () => {
    // The old `UPDATE cards SET project_slug = <the area>`: project_slug now means a finite project.
    await expect(query(`UPDATE cards SET project_slug = 'alpha' WHERE id = 't_00000c'`)).rejects.toThrow(/cards_project_needs_area/);
    await expect(query(`INSERT INTO cards (id, board_slug, title, created_by, project_slug) VALUES ('t_00000f', 'exo', 'stale', 'owner', 'alpha')`)).rejects.toThrow(/cards_project_needs_area/);
    await expect(
      query(`INSERT INTO org_messages (channel_slug, author, kind, body, project_slug) VALUES ('leads', 'owner', 'message', 'stale', 'alpha')`),
    ).rejects.toThrow(/org_messages_project_needs_area/);
    expect((await query(`SELECT area_slug, project_slug FROM cards WHERE id = 't_00000c'`)).rows).toEqual([{ area_slug: null, project_slug: null }]);
  });

  it('cannot write a pair that is not a project: the foreign key refuses it', async () => {
    // The area slug in both columns, or a project of another area.
    await expect(query(`UPDATE cards SET area_slug = 'alpha', project_slug = 'alpha' WHERE id = 't_00000c'`)).rejects.toThrow(/cards_area_project_fkey/);
    await expect(query(`UPDATE cards SET area_slug = 'gamma', project_slug = 'one' WHERE id = 't_00000c'`)).rejects.toThrow(/cards_area_project_fkey/);
    await expect(
      query(`INSERT INTO org_messages (channel_slug, author, kind, body, area_slug, project_slug) VALUES ('leads', 'owner', 'message', 'stale', 'alpha', 'alpha')`),
    ).rejects.toThrow(/org_messages_area_project_fkey/);
  });

  it('hits a missing column when it still names feature_slug, feature_id or the features table', async () => {
    await expect(query(`UPDATE cards SET feature_slug = 'one' WHERE id = 't_00000c'`)).rejects.toThrow(/feature_slug/);
    await expect(query(`SELECT feature_slug FROM task_links`)).rejects.toThrow(/feature_slug/);
    await expect(query(`SELECT feature_id FROM verifications`)).rejects.toThrow(/feature_id/);
    await expect(query(`SELECT 1 FROM features`)).rejects.toThrow(/features/);
    await expect(query(`SELECT stage FROM areas`)).rejects.toThrow(/stage/);
  });

  it('the board functions take the area then the project, in the positions the old pair had', async () => {
    const create = (area: string | null, project: string | null) =>
      query<{ id: string; area_slug: string | null; project_slug: string | null }>(
        `SELECT id, area_slug, project_slug FROM board_card_create('owner', 'exo', 'positional', NULL, '{}', NULL, $1, $2, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false)`,
        [area, project],
      );
    // An old positional caller passed (project, feature): the same two values are (area, project) now.
    const { rows } = await create('alpha', 'one');
    expect(rows[0]).toMatchObject({ area_slug: 'alpha', project_slug: 'one' });
    expect((await create('alpha', null)).rows[0]).toMatchObject({ area_slug: 'alpha', project_slug: null });
    await expect(create('nope', null)).rejects.toThrow(/no area "nope" in the tracker \(cli-areas list\)/);
    await expect(create('alpha', 'nope')).rejects.toThrow(/no project "alpha\/nope" in the tracker/);
    // A project with no area never reaches the table.
    await expect(create(null, 'one')).rejects.toThrow(/no project/);
    await expect(query(`SELECT board_card_tag('owner', $1, NULL, 'one')`, [rows[0]!.id])).rejects.toThrow(/a project needs an area/);
    // The old parameter names are gone, so a caller using them by name fails too.
    await expect(query(`SELECT board_card_tag(p_by => 'owner', p_card => $1, p_project => 'alpha', p_feature => 'one')`, [rows[0]!.id])).rejects.toThrow(/p_feature|does not exist/);
    const tagged = await query<{ area_slug: string; project_slug: string }>(`SELECT area_slug, project_slug FROM board_card_tag(p_by => 'owner', p_card => $1, p_area => 'alpha', p_project => 'two')`, [rows[0]!.id]);
    expect(tagged.rows[0]).toEqual({ area_slug: 'alpha', project_slug: 'two' });
  });

  it('deleting an area clears both tags on its cards and messages, whichever foreign key fires first', async () => {
    await query(`DELETE FROM areas WHERE slug = 'alpha'`);
    expect((await query(`SELECT DISTINCT area_slug, project_slug FROM cards`)).rows).toEqual([{ area_slug: null, project_slug: null }]);
    expect((await query(`SELECT area_slug, project_slug FROM org_messages`)).rows).toEqual([{ area_slug: null, project_slug: null }]);
    expect((await query(`SELECT 1 FROM projects WHERE area_slug = 'alpha'`)).rowCount).toBe(0);
  });

  it('deleting a project clears the project tag and keeps the area tag', async () => {
    await query(`UPDATE cards SET area_slug = 'beta', project_slug = 'one' WHERE id = 't_00000c'`);
    await query(`DELETE FROM projects WHERE area_slug = 'beta' AND slug = 'one'`);
    expect((await query(`SELECT area_slug, project_slug FROM cards WHERE id = 't_00000c'`)).rows).toEqual([{ area_slug: 'beta', project_slug: null }]);
  });
});
