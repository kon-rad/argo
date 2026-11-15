import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { config } from '../../config.js';
import { ALIAS_ENDS, TrackerError } from './service/index.js';

/** What cli-areas and cli-projects share: flag parsing, the alias window, the report file. */

export type Args = { pos: string[]; opts: Record<string, string | true> };

/** Where a CLI writes, and what time it is. Tests pass their own; the real CLIs use the console and the clock. */
export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  now: Date;
  /** The vault to read and write; the configured one when absent. */
  vaultRoot?: string;
}
export const consoleIo = (): CliIo => ({ out: (l) => console.log(l), err: (l) => console.error(l), now: new Date() });

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

type Field = { key: string; kind: 'text' | 'int' | 'list' };

/** `cli-areas add|set` flags. An area has a status, not a stage, and no due date. */
export const AREA_FIELDS: Record<string, Field> = {
  title: { key: 'title', kind: 'text' }, team: { key: 'team', kind: 'text' }, division: { key: 'division', kind: 'text' },
  status: { key: 'status', kind: 'text' }, health: { key: 'health', kind: 'text' }, priority: { key: 'priority', kind: 'int' },
  goals: { key: 'goals', kind: 'list' }, needs: { key: 'needs_owner', kind: 'text' }, blocked: { key: 'blocked_on', kind: 'text' },
  started: { key: 'started', kind: 'text' }, devlog: { key: 'devlog_path', kind: 'text' }, design: { key: 'design_path', kind: 'text' },
  home: { key: 'home_path', kind: 'text' }, paths: { key: 'paths', kind: 'list' }, repos: { key: 'repos', kind: 'list' },
  note: { key: 'note', kind: 'text' },
};

/** `cli-projects add|set` flags. */
export const PROJECT_FIELDS: Record<string, Field> = {
  title: { key: 'title', kind: 'text' }, outcome: { key: 'outcome', kind: 'text' }, next: { key: 'next_action', kind: 'text' },
  stage: { key: 'stage', kind: 'text' }, health: { key: 'health', kind: 'text' }, goals: { key: 'goals', kind: 'list' },
  needs: { key: 'needs_owner', kind: 'text' }, blocked: { key: 'blocked_on', kind: 'text' }, started: { key: 'started', kind: 'text' },
  due: { key: 'due', kind: 'text' }, owner: { key: 'owner', kind: 'text' }, notes: { key: 'notes_path', kind: 'text' },
  sort: { key: 'sort', kind: 'int' }, note: { key: 'note', kind: 'text' }, unverified: { key: 'unverified', kind: 'text' },
};

/** --flag value pairs → a patch object; "none" clears (null, or [] for lists). Flags not in `fields` are left alone. */
export function patchFrom(opts: Args['opts'], fields: Record<string, Field> = PROJECT_FIELDS): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [flag, raw] of Object.entries(opts)) {
    const f = fields[flag];
    if (!f) continue;
    if (raw === true) throw new TrackerError(`--${flag} needs a value`);
    if (raw === 'none') patch[f.key] = f.kind === 'list' ? [] : null;
    else if (f.kind === 'int') patch[f.key] = Number(raw);
    else if (f.kind === 'list') patch[f.key] = raw.split(',').map((s) => s.trim()).filter(Boolean);
    else patch[f.key] = raw;
  }
  return patch;
}

export const text = (v: string | true | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

export const whoAmI = (opts: Args['opts']): string =>
  text(opts.by) ?? config.env.PROJECTS_BY ?? `${userInfo().username}@${hostname().split('.')[0]}`;

/** `<area>` or `<area>/<project>`. */
export function target(ref: string | undefined): { area: string; project: string | null } {
  if (!ref) throw new TrackerError('which one? e.g. lifeos (an area) or lifeos/phase-1-core (a project)');
  const [area, project, extra] = ref.split('/');
  if (!area || extra !== undefined) throw new TrackerError(`bad reference "${ref}"`);
  return { area, project: project || null };
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

/**
 * The PARA rename moved the verbs that act on a whole area from cli-projects to cli-areas.
 * The old spellings keep working until ALIAS_ENDS, each printing a warning that names the
 * new command. From that day on an old spelling prints the new command and exits 2: it
 * never silently does the work.
 */
export { ALIAS_ENDS };
export const EXIT_ALIAS_ENDED = 2;

/** True while the old spelling still works (and warns); false once it has ended (the caller exits 2). */
export function aliasStillWorks(old: string, replacement: string, io: CliIo): boolean {
  if (io.now.toISOString().slice(0, 10) < ALIAS_ENDS) {
    io.err(`warning: "${old}" is now "${replacement}". The old spelling works until ${ALIAS_ENDS}.`);
    return true;
  }
  io.err(`"${old}" ended on ${ALIAS_ENDS}. Use "${replacement}".`);
  return false;
}

/** Prints the error the way every tracker CLI does, for the entry files. */
export function printError(err: unknown): void {
  if (err instanceof TrackerError) console.error(err.message);
  else if (err instanceof z.ZodError) console.error(err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('\n'));
  else console.error(err instanceof Error ? err.message : String(err));
}
