import type { Note, VaultIndex } from '../backlinks.js';
import type { Shelf } from './shelves.js';

/**
 * The generated block at the end of every shelf note: status line, design
 * doc, next action, newest and most-linked notes, sibling shelves. Everything
 * outside the markers is the owner's and is never touched.
 */
export const SHELF_START = '<!-- shelf:start -->';
export const SHELF_END = '<!-- shelf:end -->';
const BLOCK_RE = /\n*<!-- shelf:start -->[\s\S]*?<!-- shelf:end -->\n*/;
const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;

export interface ShelfFacts {
  designDoc: Note | null;
  nextAction: string | null;
  newest: Note[];
  mostLinked: { note: Note; inbound: number }[];
  siblings: string[];
}

const BOILERPLATE = new Set(['README.md', 'CLAUDE.md', 'AGENTS.md', 'AGENTS.local.md']);

/** Notes of the shelf worth listing: not its own note, not agent instruction files. */
function inShelf(note: Note, dir: string): boolean {
  return note.path.startsWith(`${dir}/`) && !BOILERPLATE.has(note.path.split('/').pop()!);
}

/** Inbound wikilink counts for every note, resolved the same way the scanner does. */
export function inboundCounts(notes: Note[], index: VaultIndex): Map<string, number> {
  const counts = new Map<string, number>();
  for (const n of notes) {
    for (const m of n.content.matchAll(WIKILINK_RE)) {
      const hit = index.resolve(m[1]!.trim(), n.dir);
      if (!hit || hit.path === n.path) continue;
      counts.set(hit.path, (counts.get(hit.path) ?? 0) + 1);
    }
  }
  return counts;
}

export function shelfFacts(
  shelf: Shelf,
  shelves: Shelf[],
  notes: Note[],
  inbound: Map<string, number>,
  mtime: (path: string) => number,
  nextAction: string | null,
): ShelfFacts {
  const own = notes.filter((n) => inShelf(n, shelf.dir) && n.path !== shelf.readme);
  const designDoc = own.find((n) => n.path.endsWith('-design.md')) ?? null;
  const newest = [...own].sort((a, b) => mtime(b.path) - mtime(a.path) || a.path.localeCompare(b.path)).slice(0, 5);
  const mostLinked = own
    .map((note) => ({ note, inbound: inbound.get(note.path) ?? 0 }))
    .filter((x) => x.inbound > 0)
    .sort((a, b) => b.inbound - a.inbound || a.note.path.localeCompare(b.note.path))
    .slice(0, 5);
  const root = shelf.dir.split('/')[0]!;
  const siblings = shelves
    .filter((s) => s.dir !== shelf.dir && s.dir.startsWith(`${root}/`) && s.meta.status !== 'archived')
    .map((s) => s.dir)
    .sort()
    .slice(0, 8);
  return { designDoc, nextAction, newest, mostLinked, siblings };
}

export function renderShelfBlock(shelf: Shelf, facts: ShelfFacts, index: VaultIndex): string {
  const link = (n: Note) => `[[${index.linkText(n.path)}]]`;
  const lines: string[] = [SHELF_START];
  lines.push(`**Status:** ${shelf.meta.status} · **Project:** ${shelf.meta.project} · **Kind:** ${shelf.meta.kind} · **Reviewed:** ${shelf.meta.last_reviewed}`);
  if (facts.designDoc) lines.push(`**Design:** ${link(facts.designDoc)}`);
  if (facts.nextAction) lines.push(`**Next action:** ${facts.nextAction}`);
  if (facts.newest.length) lines.push(`**Newest:** ${facts.newest.map(link).join(' · ')}`);
  if (facts.mostLinked.length) lines.push(`**Most linked:** ${facts.mostLinked.map((x) => `${link(x.note)} (${x.inbound})`).join(' · ')}`);
  if (facts.siblings.length) lines.push(`**Siblings:** ${facts.siblings.map((d) => `\`${d}\``).join(' · ')}`);
  lines.push(SHELF_END);
  return lines.join('\n');
}

export function applyShelfBlock(body: string, block: string): string {
  const stripped = body.replace(BLOCK_RE, '\n').replace(/\n+$/, '');
  return `${stripped}\n\n${block}\n`;
}
