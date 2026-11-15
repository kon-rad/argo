import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { exitFlushed } from '../../cli-exit.js';
import { config } from '../../config.js';
import { pool } from '../../db.js';
import { settings } from '../../settings.js';
import {
  aliasStillWorks, AREA_FIELDS, consoleIo, EXIT_ALIAS_ENDED, parseArgs, patchFrom, printError, target, text, whoAmI, writeIfChanged,
  type Args, type CliIo,
} from './cli-shared.js';
import {
  buildReport, getBoard, importSeed, recordKpi, removeArea, setAreaArchived, TrackerError, upsertArea, upsertDivision, upsertTeam, withTrackerSource,
} from './service/index.js';
import { renderMarkdown, renderStandup, renderTelegram } from './service/report.js';

const USAGE = `cli-areas: the areas of the tracker (Postgres). Areas are what you run: they have no end date.
The finite work inside an area is its projects: see cli-projects.

  list [--archived]                                  areas with their projects, one line each
  report [--format markdown|standup|telegram|json]   the company report (default: telegram)
  render [path]                                      write the markdown report to projects.reportFile (only if it changed)
  add <area> --title T [fields]                      a new area (starts active)
  set <area> [fields]                                update; a status change is recorded with --note
  archive <area> [--note "why"]                      hide it and its projects from every active view; deletes nothing
  archive <area> --purge [--into A] [--yes]          delete it and its projects for good, re-tag its memory facts to A; dry run without --yes
  unarchive <area> [--note "why"]                    bring it back as it was
  record <area> <kpi> <value> [--at D] [--note "why"]
                                                     one KPI reading; <kpi> is a key from the kpis: frontmatter of the area's home note
  team <team> --name N [--mission M] [--lead L] [--members a,b]
  division <division> --name N [--mission M] [--head H] [--sort N]
  import <file.json>                                 teams + areas + projects, idempotent

fields: --title --division --team --status active|parked --health green|yellow|red --priority N --goals W1,M2
        --needs "what the owner must do" --blocked "on what" --started D --home PATH (the area's home note or folder)
        --devlog PATH --design PATH --paths a,b --repos a,b --note "why"
        Use "none" to clear a field. --by WHO (default $PROJECTS_BY or user@host)`;

/**
 * The patch for `add` and `set`. `--stage` is what an area had before the rename: it is read
 * as a status (parked stays parked, anything else is active) with a warning, for as long as
 * the aliases last. Returns null when that window has ended.
 */
function areaPatch(opts: Args['opts'], io: CliIo): Record<string, unknown> | null {
  const patch = patchFrom(opts, AREA_FIELDS);
  if (opts.stage !== undefined) {
    if (!aliasStillWorks('--stage on an area', '--status active|parked', io)) return null;
    if (patch.status === undefined) patch.status = opts.stage === 'parked' ? 'parked' : 'active';
  }
  if (opts.due !== undefined) io.err('warning: an area has no due date, so --due was ignored. Put the date on a project (cli-projects set <area>/<project> --due D).');
  return patch;
}

/** Everything this CLI writes is recorded in the change history with the source `cli`. */
export function runAreasCli(argv: string[], io: CliIo = consoleIo()): Promise<number> {
  return withTrackerSource('cli', () => areasCli(argv, io));
}

async function areasCli(argv: string[], io: CliIo): Promise<number> {
  const [cmd, ...rest] = argv;
  const { pos, opts } = parseArgs(rest);
  const by = whoAmI(opts);
  const vault = io.vaultRoot ?? config.vaultRoot;

  switch (cmd) {
    case 'report': {
      const format = z.enum(['markdown', 'standup', 'telegram', 'json']).parse(text(opts.format) ?? 'telegram');
      const r = await buildReport(vault, io.now, { archived: opts.archived === true });
      io.out(format === 'json' ? JSON.stringify(r, null, 2) : format === 'markdown' ? renderMarkdown(r) : format === 'standup' ? renderStandup(r) : renderTelegram(r));
      return 0;
    }
    case 'render': {
      const path = pos[0] ?? join(vault, settings(vault).projects.reportFile);
      const changed = writeIfChanged(path, renderMarkdown(await buildReport(vault, io.now)));
      io.out(changed ? `wrote ${path}` : `${path} unchanged`);
      return 0;
    }
    case 'list': {
      const b = await getBoard(vault, io.now, { archived: opts.archived === true });
      for (const a of b.areas) {
        io.out(`${a.slug} [${a.status}${a.archived_at ? ' archived' : ''}]${a.division ? ` division=${a.division}` : ''}${a.team ? ` team=${a.team}` : ''}${a.needs_owner ? ` NEEDS: ${a.needs_owner}` : ''}`);
        for (const p of a.projects) {
          const v = p.verification ? ` verified=${p.verification.result}` : '';
          io.out(`  ${a.slug}/${p.slug} [${p.stage} ${p.days_in_stage}d${p.archived_at ? ' archived' : ''}]${v}${p.needs_owner ? ` NEEDS: ${p.needs_owner}` : ''}  ${p.title}`);
        }
      }
      return 0;
    }
    case 'add': {
      const { area, project } = target(pos[0]);
      if (project) throw new TrackerError(`add takes <area>; for a project use: cli-projects add ${area}/${project} --outcome "..."`);
      const patch = areaPatch(opts, io);
      if (!patch) return EXIT_ALIAS_ENDED;
      const r = await upsertArea(area, patch, by, { create: true });
      io.out(r.created ? `added area ${area}` : `updated area ${area}`);
      return 0;
    }
    case 'set': {
      const { area, project } = target(pos[0]);
      if (project) throw new TrackerError(`set takes <area>; for a project use: cli-projects set ${area}/${project}`);
      const patch = areaPatch(opts, io);
      if (!patch) return EXIT_ALIAS_ENDED;
      if (!Object.keys(patch).length) throw new TrackerError('nothing to set');
      const r = await upsertArea(area, patch, by);
      io.out(`updated ${area}${r.stage_changed ? ` → ${String(patch.status)}` : ''}`);
      return 0;
    }
    case 'archive': {
      const { area, project } = target(pos[0]);
      if (project) throw new TrackerError(`archive takes <area>; for a project use: cli-projects archive ${area}/${project}`);
      if (opts.purge === true) {
        const dry = opts.yes !== true;
        const into = text(opts.into);
        const r = await removeArea(area, { dryRun: dry, into });
        const facts = r.facts ? `, ${r.facts} memory facts ${into ? `re-tagged to ${into}` : 'untagged'}` : '';
        io.out(dry
          ? `would delete area ${area} and ${r.projects} projects for good${facts}. Re-run with --yes.`
          : `deleted area ${area} and ${r.projects} projects${facts}`);
        return 0;
      }
      const r = await setAreaArchived(area, true, by, text(opts.note));
      io.out(r.changed ? `archived area ${area} (its projects are hidden with it; cli-areas unarchive ${area} brings it back)` : `${area} was already archived`);
      return 0;
    }
    case 'unarchive': {
      const { area, project } = target(pos[0]);
      if (project) throw new TrackerError(`unarchive takes <area>; for a project use: cli-projects unarchive ${area}/${project}`);
      const r = await setAreaArchived(area, false, by, text(opts.note));
      io.out(r.changed ? `unarchived area ${area}` : `${area} was not archived`);
      return 0;
    }
    case 'record': {
      const [ref, key, value] = pos;
      const { area, project } = target(ref);
      if (project) throw new TrackerError('record takes <area>: a KPI belongs to an area');
      if (!key || value === undefined) throw new TrackerError('record <area> <kpi> <value> [--at D] [--note "why"]');
      if (!/^-?\d+(\.\d+)?$/.test(value)) throw new TrackerError(`the value is a number, e.g. 42 or 3.5 (got "${value}")`);
      const r = await recordKpi(vault, area, { key, value: Number(value), at: text(opts.at), note: text(opts.note) }, by);
      io.out(`recorded ${area} ${key} = ${value} (reading ${r.id})`);
      return 0;
    }
    case 'team': {
      const slug = pos[0];
      const name = text(opts.name);
      if (!slug || !name) throw new TrackerError('team <slug> --name N');
      await upsertTeam(slug, {
        name,
        mission: text(opts.mission) ?? null,
        lead: text(opts.lead) ?? null,
        members: text(opts.members)?.split(',').map((s) => s.trim()) ?? [],
      });
      io.out(`saved team ${slug}`);
      return 0;
    }
    case 'division': {
      const slug = pos[0];
      const name = text(opts.name);
      if (!slug || !name) throw new TrackerError('division <slug> --name N');
      await upsertDivision(slug, {
        name,
        mission: text(opts.mission) ?? null,
        head: text(opts.head) ?? null,
        sort: text(opts.sort) !== undefined ? Number(opts.sort) : 0,
      });
      io.out(`saved division ${slug}`);
      return 0;
    }
    case 'import': {
      if (!pos[0]) throw new TrackerError('import <file.json>');
      const n = await importSeed(JSON.parse(readFileSync(pos[0], 'utf8')), by);
      io.out(`imported ${n.teams} teams, ${n.areas} areas, ${n.projects} projects`);
      return 0;
    }
    default:
      io.out(USAGE);
      return cmd === undefined || cmd === 'help' || cmd === '--help' ? 0 : 1;
  }
}

if (process.argv[1]?.endsWith('cli-areas.js') || process.argv[1]?.endsWith('cli-areas.ts')) {
  let code = 1;
  try {
    code = await runAreasCli(process.argv.slice(2));
  } catch (err) {
    printError(err);
  } finally {
    await pool.end();
  }
  await exitFlushed(code);
}
