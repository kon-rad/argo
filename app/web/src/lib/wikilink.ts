import { visit } from 'unist-util-visit';
import type { Link, Parent, Root, Text } from 'mdast';

export type WikilinkPiece =
  | { type: 'text'; value: string }
  | { type: 'wikilink'; target: string; label: string };

/** `[[target|alias]]`, `[[target#heading]]`, `[[target^block]]`, `![[embed]]`. */
const WIKILINK_RE = /!?\[\[([^\]\n]+)\]\]/g;

/**
 * The scanner stores `spec` for `[[spec#Section]]`, so this has to strip the
 * anchor the same way or every anchored link in the vault renders unresolved.
 * Keeping the two in step matters more than either rule on its own.
 */
function parseInner(inner: string): { target: string; label: string } | null {
  const pipe = inner.indexOf('|');
  const alias = pipe >= 0 ? inner.slice(pipe + 1).trim() : '';
  const target = (pipe >= 0 ? inner.slice(0, pipe) : inner).split('#')[0]!.split('^')[0]!.trim();
  if (!target) return null;
  return { target, label: alias || target };
}

/** Pure and exported so the split rule can be tested without a mdast tree. */
export function splitWikilinks(value: string): WikilinkPiece[] {
  const pieces: WikilinkPiece[] = [];
  let last = 0;

  for (const match of value.matchAll(WIKILINK_RE)) {
    const parsed = parseInner(match[1]!);
    if (!parsed) continue;
    const start = match.index;
    if (start > last) pieces.push({ type: 'text', value: value.slice(last, start) });
    pieces.push({ type: 'wikilink', ...parsed });
    last = start + match[0].length;
  }

  if (pieces.length === 0) return [{ type: 'text', value }];
  if (last < value.length) pieces.push({ type: 'text', value: value.slice(last) });
  return pieces;
}

/**
 * Rewrites `[[x|y]]` into an ordinary mdast link with a `wikilink:` protocol,
 * which the renderer resolves against the API's `links` array. Code safety is
 * free: remark never produces `text` nodes inside `code` or `inlineCode`.
 */
export function remarkWikilink() {
  return (tree: Root): void => {
    visit(tree, 'text', (node: Text, index: number | undefined, parent: Parent | undefined) => {
      if (!parent || index === undefined) return;
      const pieces = splitWikilinks(node.value);
      if (pieces.length === 1 && pieces[0]!.type === 'text') return;

      const replacement = pieces.map((piece) =>
        piece.type === 'text'
          ? ({ type: 'text', value: piece.value } satisfies Text)
          : ({
              type: 'link',
              url: `wikilink:${piece.target}`,
              children: [{ type: 'text', value: piece.label }],
            } satisfies Link),
      );

      parent.children.splice(index, 1, ...replacement);
      // Skip past what we just inserted; re-visiting our own text nodes would
      // not loop forever, but it would rescan the whole paragraph per link.
      return index + replacement.length;
    });
  };
}
