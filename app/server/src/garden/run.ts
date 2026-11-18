import { execFileSync } from 'node:child_process';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { collectNotes, VaultIndex } from '../backlinks.js';
import { parseSettings, type GardenSettings } from '../settings.js';
import { applyActions, type ApplyResult } from './apply.js';
import { readNextAction, renderCatalog } from './catalog.js';
import { renderReport, type GardenMode, type RunResult } from './report.js';
import { planLoose, planShelves, quarterOf, type Action, type RuleContext } from './rules.js';
import { discoverShelves, serializeShelf, type Shelf } from './shelves.js';
import { applyShelfBlock, inboundCounts, renderShelfBlock, shelfFacts } from './wiki.js';

export interface RunOptions {
  mode: GardenMode;
  today?: string;
  settings?: GardenSettings;
  lastTouched?: RuleContext['lastTouched'];
  trackerStage?: RuleContext['trackerStage'];
  git?: (args: string[]) => string;
  skipWiki?: boolean;
}

function gitFor(root: string): (args: string[]) => string {
  return (args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Last commit date under a folder, from git; null when the folder has no history (or this is not a checkout). */
export function gitLastTouched(git: (args: string[]) => string): (dir: string) => string | null {
  const cache = new Map<string, string | null>();
  return (dir) => {
    if (cache.has(dir)) return cache.get(dir)!;
    let v: string | null = null;
    try { v = git(['log', '-1', '--format=%cs', '--', dir]).trim() || null; } catch { v = null; }
    cache.set(dir, v);
    return v;
  };
}

function dirtySet(git: (args: string[]) => string): Set<string> {
  try {
    return new Set(git(['status', '--porcelain', '-uall']).split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^"|"$/g, '')));
  } catch { return new Set(); }
}

/** `.md` files sitting directly in a root folder instead of inside a shelf. The vault root itself is the owner's (guides, priorities) and is not scanned. */
async function looseNotes(root: string, roots: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const r of roots) {
    let entries;
    try { entries = await readdir(join(root, r), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md') || e.name.startsWith('.') || e.name === 'README.md') continue;
      out.push(`${r}/${e.name}`);
    }
  }
  return out.sort();
}

/** A shelf with no `project:` whose folder name is a tracker slug belongs to that project; written on the next write run. */
export function inferProjects(shelves: Shelf[], ctx: RuleContext): void {
  for (const s of shelves) {
    if (s.meta.project !== 'none') continue;
    const name = s.dir.split('/').pop()!;
    if (ctx.trackerStage(name) !== null) s.meta.project = name;
  }
}

async function writeShelfNotes(root: string, shelves: Shelf[], ctx: RuleContext, dirty: Set<string>, skipWiki: boolean): Promise<number> {
  const notes = await collectNotes(root);
  const index = new VaultIndex(notes);
  const inbound = inboundCounts(notes, index);
  const mtimes = new Map<string, number>();
  const mtime = (p: string) => mtimes.get(p) ?? 0;
  if (!skipWiki) {
    for (const n of notes) {
      try { mtimes.set(n.path, (await stat(join(root, n.path))).mtimeMs); } catch { /* gone */ }
    }
  }
  let created = 0;
  for (const s of shelves) {
    if (dirty.has(s.readme)) continue;
    s.meta.last_reviewed = ctx.today;
    if (!skipWiki) {
      const facts = shelfFacts(s, shelves, notes, inbound, mtime, await readNextAction(root, s.dir));
      s.body = applyShelfBlock(s.body, renderShelfBlock(s, facts, index));
    }
    await mkdir(dirname(join(root, s.readme)), { recursive: true });
    await writeFile(join(root, s.readme), serializeShelf(s));
    if (!s.exists) created++;
  }
  return created;
}

export async function runGarden(root: string, opts: RunOptions): Promise<RunResult> {
  const settings = opts.settings ?? parseSettings({}).garden;
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const git = opts.git ?? gitFor(root);
  const dirty = dirtySet(git);
  const ctx: RuleContext = {
    today,
    quarter: quarterOf(today),
    lastTouched: opts.lastTouched ?? gitLastTouched(git),
    trackerStage: opts.trackerStage ?? (() => null),
    settings,
  };

  let shelves = await discoverShelves(root, settings.roots, settings.shelfFile, today);
  inferProjects(shelves, ctx);
  const actions: Action[] = [...planShelves(shelves, ctx), ...planLoose(await looseNotes(root, settings.roots), ctx)];

  let applied: ApplyResult | null = null;
  if (opts.mode === 'apply') {
    applied = await applyActions(root, actions, { git, dirty, today });
    shelves = await discoverShelves(root, settings.roots, settings.shelfFile, today);
    inferProjects(shelves, ctx);
  }

  let created = 0;
  const catalogPath = settings.catalogFile;
  if (opts.mode !== 'shadow') {
    created = await writeShelfNotes(root, shelves, ctx, dirty, opts.skipWiki === true);
    const counts = new Map<string, number>();
    for (const n of await collectNotes(root)) {
      const shelf = shelves.find((s) => n.path.startsWith(`${s.dir}/`));
      if (shelf) counts.set(shelf.dir, (counts.get(shelf.dir) ?? 0) + 1);
    }
    const next = new Map<string, string | null>();
    for (const s of shelves) next.set(s.dir, await readNextAction(root, s.dir));
    if (!dirty.has(catalogPath)) {
      await mkdir(dirname(join(root, catalogPath)), { recursive: true });
      await writeFile(join(root, catalogPath), renderCatalog(shelves, ctx, { noteCount: (d) => counts.get(d) ?? 0, nextAction: (d) => next.get(d) ?? null }));
    }
  }

  const reportPath = `${settings.reportDir}/${today}.md`;
  const result: RunResult = { mode: opts.mode, today, shelves: shelves.length, created, actions, applied, reportPath, catalogPath, dirtySkipped: dirty.size };
  await mkdir(dirname(join(root, reportPath)), { recursive: true });
  await writeFile(join(root, reportPath), renderReport(result));
  return result;
}
