import { visit } from 'unist-util-visit';
import type { Break, InlineCode, Link, Parent, Root, Text } from 'mdast';
import { splitWikilinks } from './wikilink.js';

/**
 * Bots write their results as plain text: "written to Research/ai/x-research.md",
 * sometimes in backticks, sometimes as `[[x-research]]`. This finds the bare
 * paths so a card can link them like a note links its wikilinks.
 *
 * A candidate is a slash-separated token ending in a file extension, not glued
 * to a URL (`https://host/a.md` is left to remark-gfm's autolinker). Whether it
 * is really a vault file is the server's call; a miss renders as plain text.
 */
const VAULT_PATH_RE = /(?<![\w/.:@~-])((?:[\w.-]+\/)+[\w.-]*\w\.[A-Za-z0-9]{1,8})(?![\w/])/g;

export type VaultPathPiece = { type: 'text'; value: string } | { type: 'path'; path: string };

/** Pure and exported for the tests. */
export function splitVaultPaths(value: string): VaultPathPiece[] {
  const pieces: VaultPathPiece[] = [];
  let last = 0;
  for (const match of value.matchAll(VAULT_PATH_RE)) {
    const path = match[1]!;
    // `../x.md` and `./x.md` are relative to something this text doesn't have.
    if (path.startsWith('.') && !/^\.[\w-]/.test(path)) continue;
    if (path.split('/').some((seg) => seg === '..' || seg === '.')) continue;
    if (match.index > last) pieces.push({ type: 'text', value: value.slice(last, match.index) });
    pieces.push({ type: 'path', path });
    last = match.index + match[0].length;
  }
  if (pieces.length === 0) return [{ type: 'text', value }];
  if (last < value.length) pieces.push({ type: 'text', value: value.slice(last) });
  return pieces;
}

/** A backticked span counts only when the whole span is one path. */
function codePath(value: string): string | null {
  const pieces = splitVaultPaths(value.trim());
  return pieces.length === 1 && pieces[0]!.type === 'path' ? pieces[0]!.path : null;
}

/** Every ref in a text the renderer will ask about: wikilink targets and bare paths. */
export function collectVaultRefs(text: string): string[] {
  const refs = new Set<string>();
  for (const piece of splitWikilinks(text)) {
    if (piece.type === 'wikilink') refs.add(piece.target);
    else for (const p of splitVaultPaths(piece.value)) if (p.type === 'path') refs.add(p.path);
  }
  return [...refs].sort();
}

/**
 * Rewrites bare vault paths, in text and in whole inline-code spans, into
 * `vaultpath:` links. Runs after remarkWikilink, so `[[a/b.md]]` is already a
 * link and its text is never matched twice. Text inside links stays as is.
 */
export function remarkVaultPaths() {
  return (tree: Root): void => {
    visit(tree, (node, index, parent: Parent | undefined) => {
      if (!parent || index === undefined || parent.type === 'link') return;
      if (node.type === 'inlineCode') {
        const path = codePath((node as InlineCode).value);
        if (!path) return;
        parent.children.splice(index, 1, {
          type: 'link',
          url: `vaultpath:${path}`,
          children: [node as InlineCode],
        } satisfies Link);
        return index + 1;
      }
      if (node.type !== 'text') return;
      const pieces = splitVaultPaths((node as Text).value);
      if (pieces.length === 1 && pieces[0]!.type === 'text') return;
      const replacement = pieces.map((piece) =>
        piece.type === 'text'
          ? ({ type: 'text', value: piece.value } satisfies Text)
          : ({ type: 'link', url: `vaultpath:${piece.path}`, children: [{ type: 'text', value: piece.path }] } satisfies Link),
      );
      parent.children.splice(index, 1, ...replacement);
      return index + replacement.length;
    });
  };
}

/** Single newlines as line breaks, for comments typed (or printed) as plain text. */
export function remarkSoftBreaks() {
  return (tree: Root): void => {
    visit(tree, 'text', (node: Text, index: number | undefined, parent: Parent | undefined) => {
      if (!parent || index === undefined || !node.value.includes('\n')) return;
      const replacement: (Text | Break)[] = [];
      node.value.split('\n').forEach((line, i) => {
        if (i > 0) replacement.push({ type: 'break' });
        if (line) replacement.push({ type: 'text', value: line });
      });
      parent.children.splice(index, 1, ...replacement);
      return index + replacement.length;
    });
  };
}
