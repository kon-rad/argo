import { useMemo } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, fileHref } from '../lib/api.js';
import { remarkWikilink } from '../lib/wikilink.js';
import { collectVaultRefs, remarkSoftBreaks, remarkVaultPaths } from '../lib/vaultRefs.js';

/**
 * Markdown that isn't a vault file (kanban cards, comments, bot results) with
 * its note references made clickable: `[[wikilinks]]`, bare vault paths and
 * backticked paths all open the note. The server resolves them with the same
 * rules as the link graph. A dead wikilink shows as a gap; a bare path that
 * isn't in the vault stays plain text, since the path match is a guess.
 */
export function VaultMarkdown({ text, className = 'prose max-w-none text-sm', breaks = false }: {
  text: string;
  className?: string;
  /** Keep single newlines, for comments written as plain text. */
  breaks?: boolean;
}) {
  const refs = useMemo(() => collectVaultRefs(text), [text]);
  const resolved = useQuery({
    queryKey: ['vault-resolve', refs],
    queryFn: () => api.resolveRefs(refs),
    enabled: refs.length > 0,
    staleTime: 60_000,
  });
  const map = resolved.data?.resolved ?? {};

  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={breaks ? [remarkGfm, remarkWikilink, remarkVaultPaths, remarkSoftBreaks] : [remarkGfm, remarkWikilink, remarkVaultPaths]}
        urlTransform={(url) => (url.startsWith('wikilink:') || url.startsWith('vaultpath:') ? url : defaultUrlTransform(url))}
        components={{
          a({ href, children }) {
            const kind = href?.startsWith('wikilink:') ? 'wikilink' : href?.startsWith('vaultpath:') ? 'vaultpath' : null;
            if (!kind) {
              return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
            }
            const target = decode(href!.slice(kind.length + 1));
            const path = map[target];
            if (path) return <Link to={fileHref(path)} className="text-[var(--accent)] underline">{children}</Link>;
            if (kind === 'vaultpath' || resolved.isPending) return <>{children}</>;
            return <span className="wikilink-dead" title={`No note in the vault matches “${target}”`}>{children}</span>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** mdast-to-hast percent-encodes urls; the refs map is keyed by the raw text. */
function decode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
