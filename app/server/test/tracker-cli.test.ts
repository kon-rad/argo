import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { runAreasCli } from '../src/cli-areas.js';
import { ALIAS_ENDS, runProjectsCli } from '../src/cli-projects.js';
import { query } from '../src/db.js';
import { areaFlag } from '../src/org.js';
import { getBoard, listProjects, resolveTrackerRef } from '../src/projects.js';
import { classifyAction } from '../src/usage/actions.js';
import { truncateAll } from './helpers.js';

/** cli-areas and cli-projects after the PARA rename: the new verbs, the 14-day aliases, the project folder. */

const DURING = new Date('2026-11-20T00:00:00Z');
const AFTER = new Date(`${ALIAS_ENDS}T00:00:00Z`);

interface Run { code: number; out: string[]; err: string[] }

function runner(vaultRoot: string) {
  const run = async (main: typeof runProjectsCli, argv: string[], now = DURING): Promise<Run> => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main([...argv, '--by', 'test'], { out: (l) => out.push(l), err: (l) => err.push(l), now, vaultRoot });
    return { code, out, err };
  };
  return {
    projects: (argv: string[], now?: Date) => run(runProjectsCli, argv, now),
    areas: (argv: string[], now?: Date) => run(runAreasCli, argv, now),
  };
}

/** The runs use a fixed clock for the alias window, so 'days in stage' is whatever the real date makes it. */
const days = (lines: string[]): string[] => lines.map((l) => l.replace(/ \d+d\]/, ' Nd]'));
const vault = (): string => mkdtempSync(join(tmpdir(), 'sb-tracker-cli-'));
const areaSlugs = async (root: string, archived = false): Promise<string[]> => (await getBoard(root, new Date(), { archived })).areas.map((a) => a.slug);

describe('cli-areas', () => {
  beforeEach(truncateAll);

  it('adds, sets, lists, archives and unarchives an area', async () => {
    const root = vault();
    const cli = runner(root);
    expect(await cli.areas(['add', 'lifeos', '--title', 'LifeOS'])).toMatchObject({ code: 0, out: ['added area lifeos'], err: [] });
    expect((await cli.areas(['set', 'lifeos', '--status', 'parked', '--home', 'Areas/lifeos/README.md', '--note', 'paused'])).out).toEqual(['updated lifeos → parked']);
    expect((await query(`SELECT status, home_path FROM areas WHERE slug = 'lifeos'`)).rows).toEqual([{ status: 'parked', home_path: 'Areas/lifeos/README.md' }]);
    await cli.projects(['add', 'lifeos/core', '--outcome', 'The core answers']);
    expect(days((await cli.areas(['list'])).out)).toEqual(['lifeos [parked]', '  lifeos/core [idea Nd]  The core answers']);

    expect((await cli.areas(['archive', 'lifeos', '--note', 'not run any more'])).out[0]).toMatch(/^archived area lifeos/);
    expect((await cli.areas(['archive', 'lifeos'])).out).toEqual(['lifeos was already archived']);
    expect((await cli.areas(['list'])).out).toEqual([]);
    expect((await cli.projects(['list'])).out).toEqual([]);
    expect(days((await cli.areas(['list', '--archived'])).out)).toEqual(['lifeos [parked archived]', '  lifeos/core [idea Nd]  The core answers']);
    // Nothing was deleted, and the history says what happened and why.
    expect((await query(`SELECT to_stage, note FROM stage_changes WHERE to_stage = 'archived'`)).rows).toEqual([{ to_stage: 'archived', note: 'not run any more' }]);

    expect((await cli.areas(['unarchive', 'lifeos'])).out).toEqual(['unarchived area lifeos']);
    expect(days((await cli.areas(['list'])).out)).toEqual(['lifeos [parked]', '  lifeos/core [idea Nd]  The core answers']);
  });

  it('deletes for good only with --purge, and only with --yes', async () => {
    const root = vault();
    const cli = runner(root);
    await cli.areas(['add', 'lifeos', '--title', 'LifeOS']);
    await cli.projects(['add', 'lifeos/core', '--outcome', 'Core']);
    expect((await cli.areas(['archive', 'lifeos', '--purge'])).out).toEqual(['would delete area lifeos and 1 projects for good. Re-run with --yes.']);
    expect(await areaSlugs(root)).toEqual(['lifeos']);
    expect((await cli.areas(['archive', 'lifeos', '--purge', '--yes'])).out).toEqual(['deleted area lifeos and 1 projects']);
    expect(await areaSlugs(root, true)).toEqual([]);
  });

  it('team, division, import and render live here now', async () => {
    const root = vault();
    const cli = runner(root);
    expect((await cli.areas(['team', 'platform', '--name', 'Platform'])).out).toEqual(['saved team platform']);
    expect((await cli.areas(['division', 'products', '--name', 'Products'])).out).toEqual(['saved division products']);
    const seed = join(root, 'seed.json');
    writeFileSync(seed, JSON.stringify({ areas: [{ slug: 'lifeos', title: 'LifeOS', team: 'platform', division: 'products', projects: [{ slug: 'core', title: 'Core' }] }] }));
    expect((await cli.areas(['import', seed])).out).toEqual(['imported 0 teams, 1 areas, 1 projects']);
    // The report file setting and its default name did not change with the rename.
    const r = await cli.areas(['render']);
    expect(r.out).toEqual([`wrote ${join(root, 'projects.md')}`]);
    expect(readFileSync(join(root, 'projects.md'), 'utf8')).toContain('# Company Report - Areas, Projects, Goals');
    expect((await cli.areas(['render'])).out).toEqual([`${join(root, 'projects.md')} unchanged`]);
  });

  it('points at cli-projects when handed a project', async () => {
    const cli = runner(vault());
    await expect(cli.areas(['add', 'lifeos/core', '--title', 'x'])).rejects.toThrow(/cli-projects add lifeos\/core/);
    await expect(cli.areas(['archive', 'lifeos/core'])).rejects.toThrow(/cli-projects archive lifeos\/core/);
  });
});

describe('cli-projects', () => {
  beforeEach(truncateAll);

  it('adds a project with an outcome, lists by area, stage and due date, and gates live on a verification', async () => {
    const cli = runner(vault());
    await cli.areas(['add', 'lifeos', '--title', 'LifeOS']);
    await cli.areas(['add', 'exo', '--title', 'Exo']);
    expect(await cli.projects(['add', 'lifeos/core', '--outcome', 'The core answers /v1/days', '--stage', 'building', '--due', '2026-11-30'])).toMatchObject({ code: 0, out: ['added lifeos/core'], err: [] });
    await cli.projects(['add', 'exo/case', '--title', 'Case v6', '--outcome', 'A case that survives a drop']);
    expect((await query(`SELECT title, outcome FROM projects ORDER BY slug`)).rows).toEqual([
      { title: 'Case v6', outcome: 'A case that survives a drop' },
      { title: 'The core answers /v1/days', outcome: 'The core answers /v1/days' },
    ]);

    expect((await cli.projects(['list'])).out).toEqual([
      'exo/case [idea]  A case that survives a drop',
      'lifeos/core [building] due=2026-11-30  The core answers /v1/days',
    ]);
    expect((await cli.projects(['list', '--area', 'exo'])).out).toEqual(['exo/case [idea]  A case that survives a drop']);
    expect((await cli.projects(['list', '--stage', 'building'])).out).toEqual(['lifeos/core [building] due=2026-11-30  The core answers /v1/days']);
    expect((await cli.projects(['list', '--due-before', '2026-12-01'])).out).toHaveLength(1);
    expect((await cli.projects(['list', '--due-before', '2026-11-30'])).out).toEqual([]);
    await expect(cli.projects(['list', '--stage', 'shipping'])).rejects.toThrow(/--stage is one of/);
    await expect(cli.projects(['list', '--due-before', 'soon'])).rejects.toThrow(/--due-before takes a date/);

    await cli.projects(['set', 'lifeos/core', '--next', 'write the test', '--stage', 'testing']);
    await expect(cli.projects(['set', 'lifeos/core', '--stage', 'live'])).rejects.toThrow(/has no verification/);
    expect((await cli.projects(['verify', 'lifeos/core', '--pass', '--check', 'npm test', '--evidence', '40 passed'])).out[0]).toMatch(/^recorded verification \d+ \(pass\) for lifeos\/core$/);
    expect((await cli.projects(['set', 'lifeos/core', '--stage', 'live'])).out).toEqual(['updated lifeos/core → live']);
    expect((await listProjects({ area: 'lifeos' }))[0]).toMatchObject({ stage: 'live', next_action: 'write the test' });
  });

  it('archives and unarchives a project, keeping its stage; --purge deletes it', async () => {
    const cli = runner(vault());
    await cli.areas(['add', 'lifeos', '--title', 'LifeOS']);
    await cli.projects(['add', 'lifeos/core', '--outcome', 'Core', '--stage', 'building']);
    expect((await cli.projects(['archive', 'lifeos/core', '--note', 'test'])).out[0]).toMatch(/^archived lifeos\/core/);
    expect((await cli.projects(['list'])).out).toEqual([]);
    expect((await cli.projects(['list', '--archived'])).out).toEqual(['lifeos/core [building archived]  Core']);
    expect((await cli.projects(['unarchive', 'lifeos/core'])).out).toEqual(['unarchived lifeos/core']);
    expect((await cli.projects(['list'])).out).toEqual(['lifeos/core [building]  Core']);
    // Hidden, then back with its stage unchanged; two rows in the history.
    expect((await query(`SELECT to_stage FROM stage_changes WHERE to_stage IN ('archived', 'unarchived') ORDER BY id`)).rows).toEqual([{ to_stage: 'archived' }, { to_stage: 'unarchived' }]);

    expect((await cli.projects(['archive', 'lifeos/core', '--purge'])).out[0]).toMatch(/^would delete lifeos\/core for good/);
    expect(await listProjects()).toHaveLength(1);
    expect((await cli.projects(['archive', 'lifeos/core', '--purge', '--yes'])).out).toEqual(['deleted lifeos/core']);
    expect(await listProjects({ archived: true })).toEqual([]);
  });

  it('report stays for good and is the same report as cli-areas report, with no warning', async () => {
    const cli = runner(vault());
    await cli.areas(['add', 'lifeos', '--title', 'LifeOS']);
    await cli.projects(['add', 'lifeos/core', '--outcome', 'Core', '--stage', 'building']);
    for (const format of ['telegram', 'standup', 'markdown']) {
      const old = await cli.projects(['report', '--format', format], AFTER);
      const now = await cli.areas(['report', '--format', format], AFTER);
      expect(old).toMatchObject({ code: 0, err: [] });
      expect(old.out).toEqual(now.out);
    }
    expect((await cli.projects(['report', '--format', 'standup'])).out[0]).toContain('Areas: 1 active. Projects: 1 building.');
  });
});

describe('cli-projects add creates the project folder', () => {
  beforeEach(truncateAll);

  it('writes <home>/projects/<slug>/README.md with the frontmatter and sets notes_path', async () => {
    const root = vault();
    const cli = runner(root);
    await cli.areas(['add', 'lifeos', '--title', 'LifeOS', '--home', 'Areas/lifeos/README.md']);
    const r = await cli.projects(['add', 'lifeos/core', '--title', 'Headless core', '--outcome', 'The core answers: "/v1/days" works']);
    const rel = join('Areas', 'lifeos', 'projects', 'core', 'README.md');
    expect(r.out).toEqual(['added lifeos/core', `wrote ${rel}`]);
    expect(readFileSync(join(root, rel), 'utf8')).toBe(
      ['---', 'kind: project', 'area: lifeos', 'project: core', 'outcome: "The core answers: \\"/v1/days\\" works"', '---', '', '# Headless core', '', '**Outcome:** The core answers: "/v1/days" works', ''].join('\n'),
    );
    expect((await query(`SELECT notes_path FROM projects WHERE slug = 'core'`)).rows).toEqual([{ notes_path: rel }]);
  });

  it('takes a folder as the home as well as a home note', async () => {
    const root = vault();
    const cli = runner(root);
    await cli.areas(['add', 'exo', '--title', 'Exo', '--home', 'Areas/exo']);
    expect((await cli.projects(['add', 'exo/case', '--outcome', 'A case'])).out[1]).toBe(`wrote ${join('Areas', 'exo', 'projects', 'case', 'README.md')}`);
  });

  it('never overwrites an existing README: it is left as it is and still becomes the notes_path', async () => {
    const root = vault();
    const cli = runner(root);
    await cli.areas(['add', 'lifeos', '--title', 'LifeOS', '--home', 'Areas/lifeos/README.md']);
    const rel = join('Areas', 'lifeos', 'projects', 'core', 'README.md');
    mkdirSync(join(root, 'Areas', 'lifeos', 'projects', 'core'), { recursive: true });
    writeFileSync(join(root, rel), '# My own notes\n\nwritten by hand\n');
    const r = await cli.projects(['add', 'lifeos/core', '--outcome', 'Core']);
    expect(r.out).toEqual(['added lifeos/core', `${rel} exists, left as it is`]);
    expect(readFileSync(join(root, rel), 'utf8')).toBe('# My own notes\n\nwritten by hand\n');
    expect((await query(`SELECT notes_path FROM projects WHERE slug = 'core'`)).rows).toEqual([{ notes_path: rel }]);
    // Adding again is an update: still nothing is written.
    expect((await cli.projects(['add', 'lifeos/core', '--outcome', 'Core, again'])).out).toEqual(['updated lifeos/core']);
    expect(readFileSync(join(root, rel), 'utf8')).toBe('# My own notes\n\nwritten by hand\n');
  });

  it('creates nothing when the area has no home, when --notes is given, or when the home leaves the vault', async () => {
    const root = vault();
    const cli = runner(root);
    await cli.areas(['add', 'bare', '--title', 'Bare']);
    expect((await cli.projects(['add', 'bare/one', '--outcome', 'One'])).out).toEqual(['added bare/one']);
    await cli.areas(['add', 'homed', '--title', 'Homed', '--home', 'Areas/homed']);
    expect((await cli.projects(['add', 'homed/two', '--outcome', 'Two', '--notes', 'Projects/two/notes.md'])).out).toEqual(['added homed/two']);
    expect(existsSync(join(root, 'Areas'))).toBe(false);
    expect((await query(`SELECT slug, notes_path FROM projects ORDER BY slug`)).rows).toEqual([{ slug: 'one', notes_path: null }, { slug: 'two', notes_path: 'Projects/two/notes.md' }]);
    // A home outside the vault is refused when it is set, so no project can be given a folder there.
    await expect(cli.areas(['add', 'escape', '--title', 'Escape', '--home', '../outside'])).rejects.toThrow(/inside the vault/);
    await expect(cli.areas(['set', 'homed', '--home', '/etc/outside'])).rejects.toThrow(/inside the vault/);
    expect((await query(`SELECT 1 FROM areas WHERE slug = 'escape'`)).rowCount).toBe(0);
  });
});

describe('the old verbs warn and name the new command, for 14 days', () => {
  beforeEach(truncateAll);

  it('add-project, set <area>, team, division, import and render forward to cli-areas with a warning', async () => {
    const root = vault();
    const cli = runner(root);
    const warn = (old: string, now: string): string => `warning: "cli-projects ${old}" is now "cli-areas ${now}". The old spelling works until ${ALIAS_ENDS}.`;

    const team = await cli.projects(['team', 'platform', '--name', 'Platform']);
    expect(team).toMatchObject({ code: 0, out: ['saved team platform'], err: [warn('team', 'team')] });
    expect((await cli.projects(['division', 'products', '--name', 'Products'])).err).toEqual([warn('division', 'division')]);

    // The old add-project took a stage; an area has a status now, and the flag says so.
    const add = await cli.projects(['add-project', 'lifeos', '--title', 'LifeOS', '--stage', 'building', '--team', 'platform']);
    expect(add.code).toBe(0);
    expect(add.out).toEqual(['added area lifeos']);
    expect(add.err).toEqual([warn('add-project', 'add'), `warning: "--stage on an area" is now "--status active|parked". The old spelling works until ${ALIAS_ENDS}.`]);
    expect((await query(`SELECT status, team_slug FROM areas WHERE slug = 'lifeos'`)).rows).toEqual([{ status: 'active', team_slug: 'platform' }]);

    const set = await cli.projects(['set', 'lifeos', '--stage', 'parked', '--due', '2026-12-01']);
    expect(set.out).toEqual(['updated lifeos → parked']);
    expect(set.err[0]).toBe(warn('set <area>', 'set'));
    expect(set.err.join('\n')).toContain('an area has no due date, so --due was ignored');

    const seed = join(root, 'seed.json');
    writeFileSync(seed, JSON.stringify({ projects: [{ slug: 'old', title: 'Old shape', stage: 'building', features: [{ slug: 'f', title: 'F' }] }] }));
    expect(await cli.projects(['import', seed])).toMatchObject({ code: 0, out: ['imported 0 teams, 1 areas, 1 projects'], err: [warn('import', 'import')] });

    const render = await cli.projects(['render']);
    expect(render.err).toEqual([warn('render', 'render')]);
    expect(render.out[0]).toMatch(/^wrote /);
  });

  it('remove-project archives instead of deleting, and says how to delete for good', async () => {
    const root = vault();
    const cli = runner(root);
    await cli.areas(['add', 'lifeos', '--title', 'LifeOS']);
    await cli.projects(['add', 'lifeos/core', '--outcome', 'Core']);
    // The old destructive spelling, --yes and all: nothing is deleted.
    const r = await cli.projects(['remove-project', 'lifeos', '--yes']);
    expect(r.code).toBe(0);
    expect(r.err[0]).toBe(`warning: "cli-projects remove-project" is now "cli-areas archive". The old spelling works until ${ALIAS_ENDS}.`);
    expect(r.err[1]).toMatch(/archive hides the area and its projects and deletes nothing.*--purge --yes/);
    expect(r.out[0]).toMatch(/^archived area lifeos/);
    expect(await areaSlugs(root)).toEqual([]);
    expect(await areaSlugs(root, true)).toEqual(['lifeos']);
    expect((await query(`SELECT count(*)::int AS n FROM projects`)).rows[0]!.n).toBe(1);
    // Real deletion needs --purge.
    const purge = await cli.projects(['remove-project', 'lifeos', '--purge', '--yes']);
    expect(purge.out).toEqual(['deleted area lifeos and 1 projects']);
    expect(await areaSlugs(root, true)).toEqual([]);
  });

  it('add without --outcome defaults the outcome to the title, with a warning', async () => {
    const cli = runner(vault());
    await cli.areas(['add', 'lifeos', '--title', 'LifeOS']);
    const r = await cli.projects(['add', 'lifeos/core', '--title', 'Headless core']);
    expect(r).toMatchObject({ code: 0, out: ['added lifeos/core'] });
    expect(r.err).toEqual([`warning: "cli-projects add without --outcome" is now "cli-projects add lifeos/core --outcome "what done means"". The old spelling works until ${ALIAS_ENDS}.`]);
    expect((await query(`SELECT outcome FROM projects`)).rows).toEqual([{ outcome: 'Headless core' }]);
  });

  it('after the window an old verb prints the new command, exits 2 and does none of the work', async () => {
    const root = vault();
    const cli = runner(root);
    await cli.areas(['add', 'lifeos', '--title', 'LifeOS']);
    const ended = (old: string, now: string): string => `"cli-projects ${old}" ended on ${ALIAS_ENDS}. Use "cli-areas ${now}".`;

    expect(await cli.projects(['add-project', 'late', '--title', 'Late'], AFTER)).toEqual({ code: 2, out: [], err: [ended('add-project', 'add')] });
    expect(await cli.projects(['remove-project', 'lifeos', '--yes'], AFTER)).toEqual({ code: 2, out: [], err: [ended('remove-project', 'archive')] });
    expect(await cli.projects(['set', 'lifeos', '--health', 'red'], AFTER)).toEqual({ code: 2, out: [], err: [ended('set <area>', 'set')] });
    expect(await cli.projects(['team', 'x', '--name', 'X'], AFTER)).toEqual({ code: 2, out: [], err: [ended('team', 'team')] });
    expect(await cli.projects(['division', 'x', '--name', 'X'], AFTER)).toEqual({ code: 2, out: [], err: [ended('division', 'division')] });
    expect(await cli.projects(['import', 'seed.json'], AFTER)).toEqual({ code: 2, out: [], err: [ended('import', 'import')] });
    expect(await cli.projects(['render'], AFTER)).toEqual({ code: 2, out: [], err: [ended('render', 'render')] });
    expect((await cli.projects(['add', 'lifeos/core', '--title', 'No outcome'], AFTER)).code).toBe(2);
    expect((await cli.areas(['set', 'lifeos', '--stage', 'parked'], AFTER)).code).toBe(2);

    // None of it happened.
    expect(await areaSlugs(root)).toEqual(['lifeos']);
    expect((await query(`SELECT health, status FROM areas`)).rows).toEqual([{ health: null, status: 'active' }]);
    expect(await listProjects()).toEqual([]);
    expect((await query(`SELECT count(*)::int AS n FROM teams`)).rows[0]!.n).toBe(0);
    // The new spellings work as before.
    expect((await cli.areas(['set', 'lifeos', '--status', 'parked'], AFTER)).code).toBe(0);
    expect((await cli.projects(['add', 'lifeos/core', '--outcome', 'Core'], AFTER)).err).toEqual([]);
  });
});

describe('old --project and --feature flags on the board and org commands', () => {
  beforeEach(async () => {
    await truncateAll();
    const cli = runner(vault());
    await cli.areas(['add', 'lifeos', '--title', 'LifeOS']);
    await cli.projects(['add', 'lifeos/core', '--outcome', 'Core']);
  });
  const resolve = async (ref: Parameters<typeof resolveTrackerRef>[0], now = DURING): Promise<{ ref: unknown; warned: string[] }> => {
    const warned: string[] = [];
    return { ref: await resolveTrackerRef(ref, { warn: (l) => warned.push(l), now }), warned };
  };

  it('the new spelling passes through without a warning', async () => {
    expect(await resolve({ area: 'lifeos', project: 'core' })).toEqual({ ref: { area: 'lifeos', project: 'core' }, warned: [] });
    expect(await resolve({ area: 'lifeos' })).toEqual({ ref: { area: 'lifeos' }, warned: [] });
    expect(await resolve({})).toEqual({ ref: {}, warned: [] });
  });

  it('--project <area> alone is read as the area, with a warning', async () => {
    expect(await resolve({ project: 'lifeos' })).toEqual({
      ref: { area: 'lifeos' },
      warned: [`warning: --project lifeos (an area) is now --area lifeos. The old spelling works until ${ALIAS_ENDS}.`],
    });
  });

  it('--feature is read as --project, and the old pair as area and project, with a warning', async () => {
    expect(await resolve({ project: 'lifeos', feature: 'core' })).toEqual({
      ref: { area: 'lifeos', project: 'core' },
      warned: [`warning: --project lifeos --feature core is now --area lifeos --project core. The old spelling works until ${ALIAS_ENDS}.`],
    });
    expect(await resolve({ area: 'lifeos', feature: 'core' })).toEqual({
      ref: { area: 'lifeos', project: 'core' },
      warned: [`warning: --feature core is now --project core. The old spelling works until ${ALIAS_ENDS}.`],
    });
    await expect(resolve({ area: 'lifeos', project: 'core', feature: 'other' })).rejects.toThrow(/give the project once/);
  });

  it('a project with no area is not guessed at: it is passed on and refused where the pair is checked', async () => {
    expect(await resolve({ project: 'core' })).toEqual({ ref: { project: 'core' }, warned: [] });
  });

  it('after the window the old spellings are refused with the new one in the message', async () => {
    await expect(resolve({ project: 'lifeos' }, AFTER)).rejects.toThrow(`--project lifeos (an area) ended on ${ALIAS_ENDS}. Use --area lifeos.`);
    await expect(resolve({ project: 'lifeos', feature: 'core' }, AFTER)).rejects.toThrow(/Use --area lifeos --project core\./);
    expect(await resolve({ area: 'lifeos', project: 'core' }, AFTER)).toEqual({ ref: { area: 'lifeos', project: 'core' }, warned: [] });
  });

  it('shared memory takes --area; the old --project there warns, then ends', () => {
    const warned: string[] = [];
    expect(areaFlag('lifeos', undefined, (l) => warned.push(l), DURING)).toBe('lifeos');
    expect(areaFlag(undefined, 'lifeos', (l) => warned.push(l), DURING)).toBe('lifeos');
    expect(warned).toEqual([`warning: --project lifeos is now --area lifeos. The old spelling works until ${ALIAS_ENDS}.`]);
    expect(() => areaFlag(undefined, 'lifeos', () => undefined, AFTER)).toThrow(`--project lifeos ended on ${ALIAS_ENDS}. Use --area lifeos.`);
    expect(() => areaFlag('a', 'b', () => undefined, DURING)).toThrow(/give the area once/);
  });
});

describe('usage: what a cli-areas call did', () => {
  it('classifies cli-areas like cli-projects: list and report read, the rest writes the tracker', () => {
    expect(classifyAction('Bash', { command: 'cli-areas list' })).toBe('read');
    expect(classifyAction('Bash', { command: 'cli-areas report --format standup' })).toBe('read');
    expect(classifyAction('Bash', { command: 'cli-areas archive lifeos --note "why"' })).toBe('tracker');
    expect(classifyAction('Bash', { command: 'cd /vault && cli-areas set lifeos --status parked' })).toBe('tracker');
    expect(classifyAction('Bash', { command: 'cli-projects list --area lifeos' })).toBe('read');
    expect(classifyAction('Bash', { command: 'cli-projects archive lifeos/core' })).toBe('tracker');
  });
});
