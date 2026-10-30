import { exitFlushed } from './cli-exit.js';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { config } from './config.js';
import { pool } from './db.js';
import {
  addVerification,
  buildReport,
  getBoard,
  importSeed,
  TrackerError,
  upsertFeature,
  upsertProject,
  upsertDivision,
  upsertTeam,
  removeProject,
} from './projects.js';
import { renderMarkdown, renderStandup, renderTelegram } from './projects-report.js';
import { settings } from './settings.js';

const USAGE = `cli-projects: the project tracker (Postgres). Every agent and the company-report skill use this.

  report [--format markdown|standup|telegram|json]   the company report (default: telegram)
  list                                               projects and features, one line each
  render [path]                                      write the markdown report to projects.reportFile (only if it changed)
  add-project <project> --title T --stage S [fields]
  remove-project <project> [--into P] [--yes]   deletes it and its features, re-tags its memory facts to P; dry run without --yes
  add <project>/<feature> --title T [fields]         a new feature (starts in idea = backlog unless --stage)
  set <project>[/<feature>] [fields]                 update; a stage change is recorded with --note
  verify <project>/<feature> --pass|--fail --check "what you ran" [--kind test|manual|deploy|review|metric] [--evidence "..."]
  team <team> --name N [--mission M] [--lead L] [--members a,b]
  division <division> --name N [--mission M] [--head H] [--sort N]
  import <file.json>                                 teams + projects + features, idempotent

fields: --title --division --team --area --stage idea|designing|building|testing|live|parked|done --health green|yellow|red
        --priority N --goals W1,M2 --needs "what the owner must do" --blocked "on what" --started D --due D
        --devlog PATH --design PATH --paths a,b --repos a,b --owner WHO --notes PATH --note "why"
        --unverified "why it ships without a passing check" (live/done only)
        Use "none" to clear a field. --by WHO (default $PROJECTS_BY or user@host)`;

type Args = { pos: string[]; opts: Record<string, string | true> };

export function parseArgs(argv: string[]): Args {
  const pos: string[] = [];
  const opts: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) {
      pos.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) opts[key] = true;
    else {
      opts[key] = next;
      i++;
    }
  }
  return { pos, opts };
}

const FIELD: Record<string, { key: string; kind: 'text' | 'int' | 'list' }> = {
  title: { key: 'title', kind: 'text' }, team: { key: 'team', kind: 'text' }, division: { key: 'division', kind: 'text' }, area: { key: 'area', kind: 'text' },
  stage: { key: 'stage', kind: 'text' }, health: { key: 'health', kind: 'text' }, priority: { key: 'priority', kind: 'int' },
  goals: { key: 'goals', kind: 'list' }, needs: { key: 'needs_owner', kind: 'text' }, blocked: { key: 'blocked_on', kind: 'text' },
  started: { key: 'started', kind: 'text' }, due: { key: 'due', kind: 'text' }, devlog: { key: 'devlog_path', kind: 'text' },
  design: { key: 'design_path', kind: 'text' }, paths: { key: 'paths', kind: 'list' }, repos: { key: 'repos', kind: 'list' },
  owner: { key: 'owner', kind: 'text' }, notes: { key: 'notes_path', kind: 'text' }, sort: { key: 'sort', kind: 'int' },
  note: { key: 'note', kind: 'text' }, unverified: { key: 'unverified', kind: 'text' },
};

/** --flag value pairs → a patch object; "none" clears (null, or [] for lists). */
export function patchFrom(opts: Args['opts']): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [flag, raw] of Object.entries(opts)) {
    const f = FIELD[flag];
    if (!f) continue;
    if (raw === true) throw new TrackerError(`--${flag} needs a value`);
    if (raw === 'none') patch[f.key] = f.kind === 'list' ? [] : null;
    else if (f.kind === 'int') patch[f.key] = Number(raw);
    else if (f.kind === 'list') patch[f.key] = raw.split(',').map((s) => s.trim()).filter(Boolean);
    else patch[f.key] = raw;
  }
  return patch;
}

function target(ref: string | undefined): { project: string; feature: string | null } {
  if (!ref) throw new TrackerError('which project? e.g. argo-lifeos or argo-lifeos/phase-1-core');
  const [project, feature, extra] = ref.split('/');
  if (!project || extra !== undefined) throw new TrackerError(`bad reference "${ref}"`);
  return { project, feature: feature || null };
}

/** Atomic write, and none at all when nothing changed (keeps git quiet). */
export function writeIfChanged(path: string, text: string): boolean {
  try {
    if (readFileSync(path, 'utf8') === text) return false;
  } catch {
    // missing: write it
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${process.pid}.projects.tmp`);
  writeFileSync(tmp, text);
  renameSync(tmp, path);
  return true;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const { pos, opts } = parseArgs(rest);
  const by = typeof opts.by === 'string' ? opts.by : (process.env.PROJECTS_BY ?? `${userInfo().username}@${hostname().split('.')[0]}`);
  const vault = config.vaultRoot;

  switch (cmd) {
    case 'report': {
      const format = z.enum(['markdown', 'standup', 'telegram', 'json']).parse(typeof opts.format === 'string' ? opts.format : 'telegram');
      const r = await buildReport(vault);
      console.log(format === 'json' ? JSON.stringify(r, null, 2) : format === 'markdown' ? renderMarkdown(r) : format === 'standup' ? renderStandup(r) : renderTelegram(r));
      return 0;
    }
    case 'render': {
      const path = pos[0] ?? join(vault, settings(vault).projects.reportFile);
      const changed = writeIfChanged(path, renderMarkdown(await buildReport(vault)));
      console.log(changed ? `wrote ${path}` : `${path} unchanged`);
      return 0;
    }
    case 'list': {
      const b = await getBoard(vault);
      for (const p of b.projects) {
        console.log(`${p.slug} [${p.stage}]${p.division ? ` division=${p.division}` : ''}${p.team ? ` team=${p.team}` : ''}${p.needs_owner ? ` NEEDS: ${p.needs_owner}` : ''}`);
        for (const f of p.features) {
          const v = f.verification ? ` verified=${f.verification.result}` : '';
          console.log(`  ${p.slug}/${f.slug} [${f.stage} ${f.days_in_stage}d]${v}${f.needs_owner ? ` NEEDS: ${f.needs_owner}` : ''}  ${f.title}`);
        }
      }
      return 0;
    }
    case 'add-project': {
      const { project } = target(pos[0]);
      const r = await upsertProject(project, patchFrom(opts), by, { create: true });
      console.log(r.created ? `added project ${project}` : `updated project ${project}`);
      return 0;
    }
    case 'remove-project': {
      const { project } = target(pos[0]);
      const dry = opts.yes !== true;
      const into = typeof opts.into === 'string' ? opts.into : undefined;
      const r = await removeProject(project, { dryRun: dry, into });
      const facts = r.facts ? `, ${r.facts} memory facts ${into ? `re-tagged to ${into}` : 'untagged'}` : '';
      console.log(dry
        ? `would remove project ${project} and ${r.features} features${facts}. Re-run with --yes.`
        : `removed project ${project} and ${r.features} features${facts}`);
      return 0;
    }
    case 'add': {
      const { project, feature } = target(pos[0]);
      if (!feature) throw new TrackerError('add takes <project>/<feature>; use add-project for a project');
      const r = await upsertFeature(project, feature, patchFrom(opts), by, { create: true });
      console.log(r.created ? `added ${project}/${feature}` : `updated ${project}/${feature}`);
      return 0;
    }
    case 'set': {
      const { project, feature } = target(pos[0]);
      const patch = patchFrom(opts);
      if (!Object.keys(patch).length) throw new TrackerError('nothing to set');
      if (feature) {
        const r = await upsertFeature(project, feature, patch, by);
        console.log(`updated ${project}/${feature}${r.stage_changed ? ` → ${String(patch.stage)}` : ''}`);
      } else {
        const r = await upsertProject(project, patch, by);
        console.log(`updated ${project}${r.stage_changed ? ` → ${String(patch.stage)}` : ''}`);
      }
      return 0;
    }
    case 'verify': {
      const { project, feature } = target(pos[0]);
      if (!feature) throw new TrackerError('verify takes <project>/<feature>');
      if (Boolean(opts.pass) === Boolean(opts.fail)) throw new TrackerError('say --pass or --fail');
      const id = await addVerification(
        project,
        feature,
        {
          kind: (typeof opts.kind === 'string' ? opts.kind : 'test') as 'test',
          check: typeof opts.check === 'string' ? opts.check : '',
          result: opts.pass ? 'pass' : 'fail',
          evidence: typeof opts.evidence === 'string' ? opts.evidence : null,
        },
        by,
      );
      console.log(`recorded verification ${id} (${opts.pass ? 'pass' : 'fail'}) for ${project}/${feature}`);
      return 0;
    }
    case 'team': {
      const slug = pos[0];
      if (!slug || typeof opts.name !== 'string') throw new TrackerError('team <slug> --name N');
      await upsertTeam(slug, {
        name: opts.name,
        mission: typeof opts.mission === 'string' ? opts.mission : null,
        lead: typeof opts.lead === 'string' ? opts.lead : null,
        members: typeof opts.members === 'string' ? opts.members.split(',').map((s) => s.trim()) : [],
      });
      console.log(`saved team ${slug}`);
      return 0;
    }
    case 'division': {
      const slug = pos[0];
      if (!slug || typeof opts.name !== 'string') throw new TrackerError('division <slug> --name N');
      await upsertDivision(slug, {
        name: opts.name,
        mission: typeof opts.mission === 'string' ? opts.mission : null,
        head: typeof opts.head === 'string' ? opts.head : null,
        sort: typeof opts.sort === 'string' ? Number(opts.sort) : 0,
      });
      console.log(`saved division ${slug}`);
      return 0;
    }
    case 'import': {
      if (!pos[0]) throw new TrackerError('import <file.json>');
      const n = await importSeed(JSON.parse(readFileSync(pos[0], 'utf8')), by);
      console.log(`imported ${n.teams} teams, ${n.projects} projects, ${n.features} features`);
      return 0;
    }
    default:
      console.log(USAGE);
      return cmd === undefined || cmd === 'help' || cmd === '--help' ? 0 : 1;
  }
}

if (process.argv[1]?.endsWith('cli-projects.js') || process.argv[1]?.endsWith('cli-projects.ts')) {
  let code = 1;
  try {
    code = await main(process.argv.slice(2));
  } catch (err) {
    if (err instanceof TrackerError) console.error(err.message);
    else if (err instanceof z.ZodError) console.error(err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('\n'));
    else console.error(err instanceof Error ? err.message : String(err));
  } finally {
    await pool.end();
  }
  await exitFlushed(code);
}
