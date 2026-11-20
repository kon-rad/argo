import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { settings } from '../../settings.js';
import { getBoard } from './service/index.js';
import { writeIfChanged } from './cli-shared.js';
import { fetchCards, mayOverwrite, renderRoadmap, RoadmapError } from '../../roadmap.js';
import { exitFlushed } from '../../cli-exit.js';
import { config } from '../../config.js';
import { pool } from '../../db.js';
import { runAreasCli } from './cli-areas.js';
import {
  aliasStillWorks, consoleIo, EXIT_ALIAS_ENDED, parseArgs, patchFrom, printError, PROJECT_FIELDS, target, text, whoAmI,
  type CliIo,
} from './cli-shared.js';
import {
  addVerification, createProjectNote, listProjects, removeProject, setProjectArchived, STAGES, TrackerError, upsertProject, withTrackerSource, type Stage,
} from './service/index.js';

export { ALIAS_ENDS, parseArgs, patchFrom, writeIfChanged } from './cli-shared.js';
export { runAreasCli } from './cli-areas.js';

const USAGE = `cli-projects: the projects of the tracker (Postgres). A project is an outcome with an end, inside
one area. Every agent and the company-report skill use this. Areas themselves: see cli-areas.

  roadmap [path]                                    cards and projects by roadmap.themes; never replaces a handwritten file
  report [--format markdown|standup|telegram|json]   the company report (default: telegram); same as cli-areas report
  list [--area A] [--stage S] [--due-before D] [--archived]   projects across areas, one line each
  add <area>/<project> --outcome "what done means" [--title T] [fields]
                                                     a new project (starts in idea = backlog unless --stage). When the area
                                                     has a home (cli-areas set <area> --home PATH) this also creates
                                                     <home>/projects/<project>/README.md and never overwrites one
  set <area>/<project> [fields]                      update; a stage change is recorded with --note
  verify <area>/<project> --pass|--fail --check "what you ran" [--kind test|manual|deploy|review|metric] [--evidence "..."]
  archive <area>/<project> [--note "why"]            hide it from every active view; deletes nothing, keeps its stage
  archive <area>/<project> --purge [--yes]           delete it for good, with its history; dry run without --yes
  unarchive <area>/<project> [--note "why"]          bring it back as it was

fields: --title --outcome --next "the next action" --stage idea|designing|building|testing|live|parked|done
        --health green|yellow|red --goals W1,M2 --needs "what the owner must do" --blocked "on what" --started D --due D
        --owner WHO --notes PATH --note "why" --unverified "why it ships without a passing check" (live/done only)
        Use "none" to clear a field. --by WHO (default $PROJECTS_BY or user@host)

moved to cli-areas (the old spelling here warns and still works for a while): add-project -> cli-areas add,
remove-project -> cli-areas archive, set <area> -> cli-areas set, render, team, division, import.`;

/** `cli-projects <old> ...` → `cli-areas <new> ...`, with the warning; exit 2 once the alias has ended. */
async function forward(old: string, verb: string, rest: string[], io: CliIo, hint?: string): Promise<number> {
  if (!aliasStillWorks(`cli-projects ${old}`, `cli-areas ${verb}`, io)) return EXIT_ALIAS_ENDED;
  if (hint) io.err(hint);
  return runAreasCli([verb, ...rest], io);
}

/** Everything this CLI writes is recorded in the change history with the source `cli`. */
export function runProjectsCli(argv: string[], io: CliIo = consoleIo()): Promise<number> {
  return withTrackerSource('cli', () => projectsCli(argv, io));
}

async function projectsCli(argv: string[], io: CliIo): Promise<number> {
  const [cmd, ...rest] = argv;
  const { pos, opts } = parseArgs(rest);
  const by = whoAmI(opts);
  const vault = io.vaultRoot ?? config.vaultRoot;

  switch (cmd) {
    case 'roadmap': {
      const rs = settings(vault).roadmap;
      const path = pos[0] ?? join(vault, rs.file);
      const [cards, board] = await Promise.all([fetchCards(rs), getBoard(vault)]);
      if (!mayOverwrite(path)) throw new RoadmapError(`${path} exists and is not a generated roadmap`);
      const { text, counts } = renderRoadmap(cards, board, rs);
      const stable = (t: string): string => t.replace(/^\*\*Generated at:\*\* \S+/m, '');
      let same = false;
      try { same = stable(readFileSync(path, 'utf8')) === stable(text); } catch { /* missing */ }
      if (!same) writeIfChanged(path, text);
      io.out(`${same ? 'unchanged' : 'wrote'} ${path}: ${counts.map((c) => `${c.id} ${c.projects} projects, ${c.cards} tickets`).join('; ') || 'no themes'}`);
      return 0;
    }
    // The stand-up and every skill call `cli-projects report`, and it only reads: it stays for good.
    case 'report':
      return runAreasCli(['report', ...rest], io);
    case 'list': {
      const stage = text(opts.stage);
      if (stage !== undefined && !(STAGES as readonly string[]).includes(stage)) throw new TrackerError(`--stage is one of ${STAGES.join(', ')}`);
      const dueBefore = text(opts['due-before']);
      if (dueBefore !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(dueBefore)) throw new TrackerError('--due-before takes a date, e.g. 2026-12-31');
      const rows = await listProjects({ area: text(opts.area), stage: stage as Stage | undefined, dueBefore, archived: opts.archived === true });
      for (const p of rows) {
        io.out(`${p.area}/${p.slug} [${p.stage}${p.archived_at ? ' archived' : ''}]${p.due ? ` due=${p.due}` : ''}${p.owner ? ` owner=${p.owner}` : ''}${p.needs_owner ? ` NEEDS: ${p.needs_owner}` : ''}  ${p.outcome ?? p.title}`);
      }
      if (!rows.length) io.err('no projects match (cli-areas list shows the areas)');
      return 0;
    }
    case 'add': {
      const { area, project } = target(pos[0]);
      if (!project) throw new TrackerError(`add takes <area>/<project>; for an area use: cli-areas add ${area} --title "..."`);
      const patch = patchFrom(opts, PROJECT_FIELDS);
      if (patch.title === undefined && typeof patch.outcome === 'string') patch.title = patch.outcome.slice(0, 200);
      if (patch.outcome === undefined && typeof patch.title === 'string') {
        // Old callers pass only --title. Until the aliases end the outcome defaults to it.
        if (!aliasStillWorks('cli-projects add without --outcome', `cli-projects add ${area}/${project} --outcome "what done means"`, io)) return EXIT_ALIAS_ENDED;
      }
      const r = await upsertProject(area, project, patch, by, { create: true });
      io.out(r.created ? `added ${area}/${project}` : `updated ${area}/${project}`);
      if (r.created && patch.notes_path === undefined) {
        const note = await createProjectNote(vault, area, project, by);
        if (note) io.out(note.written ? `wrote ${note.path}` : `${note.path} exists, left as it is`);
      }
      return 0;
    }
    case 'set': {
      const { area, project } = target(pos[0]);
      if (!project) return forward('set <area>', 'set', rest, io);
      const patch = patchFrom(opts, PROJECT_FIELDS);
      if (!Object.keys(patch).length) throw new TrackerError('nothing to set');
      const r = await upsertProject(area, project, patch, by);
      io.out(`updated ${area}/${project}${r.stage_changed ? ` → ${String(patch.stage)}` : ''}`);
      return 0;
    }
    case 'verify': {
      const { area, project } = target(pos[0]);
      if (!project) throw new TrackerError('verify takes <area>/<project>');
      if (Boolean(opts.pass) === Boolean(opts.fail)) throw new TrackerError('say --pass or --fail');
      const id = await addVerification(
        area,
        project,
        {
          kind: (text(opts.kind) ?? 'test') as 'test',
          check: text(opts.check) ?? '',
          result: opts.pass ? 'pass' : 'fail',
          evidence: text(opts.evidence) ?? null,
        },
        by,
      );
      io.out(`recorded verification ${id} (${opts.pass ? 'pass' : 'fail'}) for ${area}/${project}`);
      return 0;
    }
    case 'archive': {
      const { area, project } = target(pos[0]);
      if (!project) throw new TrackerError(`archive takes <area>/<project>; for an area use: cli-areas archive ${area}`);
      if (opts.purge === true) {
        const dry = opts.yes !== true;
        const r = await removeProject(area, project, { dryRun: dry });
        io.out(dry
          ? `would delete ${area}/${project} for good, with its history and ${r.verifications} verifications. Re-run with --yes.`
          : `deleted ${area}/${project}`);
        return 0;
      }
      const r = await setProjectArchived(area, project, true, by, text(opts.note));
      io.out(r.changed ? `archived ${area}/${project} (cli-projects unarchive ${area}/${project} brings it back)` : `${area}/${project} was already archived`);
      return 0;
    }
    case 'unarchive': {
      const { area, project } = target(pos[0]);
      if (!project) throw new TrackerError(`unarchive takes <area>/<project>; for an area use: cli-areas unarchive ${area}`);
      const r = await setProjectArchived(area, project, false, by, text(opts.note));
      io.out(r.changed ? `unarchived ${area}/${project}` : `${area}/${project} was not archived`);
      return 0;
    }

    // ---- moved to cli-areas by the PARA rename; these spellings end on ALIAS_ENDS.
    case 'render':
      return forward('render', 'render', rest, io);
    case 'add-project':
      return forward('add-project', 'add', rest, io);
    case 'remove-project':
      return forward('remove-project', 'archive', rest, io,
        opts.purge === true ? undefined : 'note: archive hides the area and its projects and deletes nothing. To delete for good: cli-areas archive <area> --purge --yes');
    case 'team':
      return forward('team', 'team', rest, io);
    case 'division':
      return forward('division', 'division', rest, io);
    case 'import':
      return forward('import', 'import', rest, io);
    default:
      io.out(USAGE);
      return cmd === undefined || cmd === 'help' || cmd === '--help' ? 0 : 1;
  }
}

if (process.argv[1]?.endsWith('cli-projects.js') || process.argv[1]?.endsWith('cli-projects.ts')) {
  let code = 1;
  try {
    code = await runProjectsCli(process.argv.slice(2));
  } catch (err) {
    printError(err);
  } finally {
    await pool.end();
  }
  await exitFlushed(code);
}
