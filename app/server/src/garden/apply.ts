import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import matter from 'gray-matter';
import { collectNotes } from '../backlinks.js';
import type { Action } from './rules.js';
import { defaultMeta, SHELF_KEYS, serializeShelf, titleFor, type ShelfKind } from './shelves.js';

/**
 * Applies archive and rename actions with `git mv` only, then rewrites path
 * links to the moved folder in every note. A move is refused, not forced,
 * when its target exists, its source is gone, or a file under it has
 * uncommitted changes (that file belongs to whoever is editing it).
 */
export interface ApplyResult {
  done: Action[];
  refused: { action: Action; reason: string }[];
  linksRewritten: number;
  filesTouched: string[];
}

export interface ApplyOptions {
  git: (args: string[]) => string;
  dirty: Set<string>;
  today: string;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rewrites `from/...` folder references inside wikilinks, markdown link
 * targets and backticked paths. A bare `[[stem]]` resolves by file name and
 * keeps working after a move, so it is left alone.
 */
export function rewriteLinks(content: string, from: string, to: string): { content: string; count: number } {
  let count = 0;
  const f = escapeRe(from);
  const patterns: RegExp[] = [
    new RegExp(`(\\[\\[)${f}(/[^\\]|#]*)`, 'g'),          // [[Projects/foo/bar]] and [[Projects/foo/bar|label]]
    new RegExp(`(\\]\\(<?)${f}(/[^)>]*)`, 'g'),           // [x](Projects/foo/bar.md)
    new RegExp(`(\`)${f}(/[^\`]*\`)`, 'g'),               // `Projects/foo/bar.md`
  ];
  let out = content;
  for (const re of patterns) {
    out = out.replace(re, (_m, pre: string, rest: string) => { count++; return `${pre}${to}${rest}`; });
  }
  return { content: out, count };
}

async function setArchived(root: string, dir: string, kind: ShelfKind, today: string): Promise<void> {
  const readme = join(root, dir, 'README.md');
  let text = '';
  try { text = await readFile(readme, 'utf8'); } catch { text = `# ${titleFor(dir)}\n`; }
  let parsed: { data: Record<string, unknown>; content: string };
  try { parsed = matter(text); } catch { parsed = { data: {}, content: text }; }
  const meta = defaultMeta(dir, kind, today);
  const foreign: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed.data)) {
    if ((SHELF_KEYS as string[]).includes(k)) { if (k === 'project' && typeof v === 'string') meta.project = v; if (k === 'pin') meta.pin = v === true; }
    else foreign[k] = v;
  }
  meta.status = 'archived';
  meta.last_reviewed = today;
  await writeFile(readme, serializeShelf({ dir, readme: `${dir}/README.md`, exists: true, meta, body: parsed.content.replace(/^\n+/, ''), foreign }));
}

export async function applyActions(root: string, actions: Action[], opts: ApplyOptions): Promise<ApplyResult> {
  const result: ApplyResult = { done: [], refused: [], linksRewritten: 0, filesTouched: [] };
  const touched = new Set<string>();
  for (const action of actions) {
    if (action.type !== 'archive' && action.type !== 'rename') continue;
    const { from, to } = action;
    if (!existsSync(join(root, from))) { result.refused.push({ action, reason: 'source missing' }); continue; }
    if (existsSync(join(root, to))) { result.refused.push({ action, reason: 'target exists' }); continue; }
    const dirtyUnder = [...opts.dirty].find((p) => p === from || p.startsWith(`${from}/`));
    if (dirtyUnder) { result.refused.push({ action, reason: `uncommitted changes: ${dirtyUnder}` }); continue; }
    await mkdir(dirname(join(root, to)), { recursive: true });
    try { opts.git(['mv', from, to]); } catch (err) { result.refused.push({ action, reason: `git mv failed: ${(err as Error).message.split('\n')[0]}` }); continue; }
    if (action.type === 'archive') {
      const kind: ShelfKind = from.startsWith('Projects/') ? 'project' : from.startsWith('Areas/') ? 'area' : 'resource';
      await setArchived(root, to, kind, opts.today);
      touched.add(`${to}/README.md`);
    }
    const notes = await collectNotes(root);
    for (const n of notes) {
      if (opts.dirty.has(n.path)) continue;
      const r = rewriteLinks(n.content, from, to);
      if (r.count === 0) continue;
      await writeFile(join(root, n.path), r.content);
      result.linksRewritten += r.count;
      touched.add(n.path);
    }
    result.done.push(action);
  }
  result.filesTouched = [...touched].sort();
  return result;
}
