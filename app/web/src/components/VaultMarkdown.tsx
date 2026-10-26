import { useMemo, useState, type ReactNode } from 'react';
import { PreviewModal } from './PreviewModal.js';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import type { PluggableList } from 'unified';
import remarkGfm from 'remark-gfm';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, fileHref } from '../lib/api.js';
import { remarkWikilink } from '../lib/wikilink.js';
import { collectVaultRefs, remarkMentions, remarkSoftBreaks, remarkVaultPaths } from '../lib/vaultRefs.js';

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
  // `@juno` links to the agent's page. Names come from the org chart; with the
  // org module off the query fails and mentions stay plain text.
  const chart = useQuery({ queryKey: ['org-chart'], queryFn: api.orgChart, staleTime: 5 * 60_000, retry: false, enabled: text.includes('@') });
  const agents = useMemo(() => new Set((chart.data?.agents ?? []).map((a) => a.name)), [chart.data]);
  const plugins = useMemo(() => {
    const p: PluggableList = [remarkGfm, remarkWikilink, remarkVaultPaths, [remarkMentions, agents]];
    return breaks ? [...p, remarkSoftBreaks] : p;
  }, [agents, breaks]);

  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={plugins}
        urlTransform={(url) => (/^(wikilink|vaultpath|agent):/.test(url) ? url : defaultUrlTransform(url))}
        components={{
          a({ href, children }) {
            if (href?.startsWith('agent:')) {
              const name = href.slice('agent:'.length);
              return <Link to={`/org/agents/${encodeURIComponent(name)}`} className="rounded bg-[var(--paper-sunk)] px-1 font-medium text-[var(--accent)] hover:underline">{children}</Link>;
            }
            const kind = href?.startsWith('wikilink:') ? 'wikilink' : href?.startsWith('vaultpath:') ? 'vaultpath' : null;
            if (!kind) {
              return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
            }
            const target = decode(href!.slice(kind.length + 1));
            const path = map[target];
            if (path) return <PathLink path={path}>{children}</PathLink>;
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

/** A resolved vault path: a link to /file/<path> and a Preview button that opens it in a modal. */
function PathLink({ path, children }: { path: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const isDir = path.endsWith('/');
  return (
    <>
      <Link to={fileHref(path)} className="text-[var(--accent)] underline">{children}</Link>
      {!isDir && <button
        type="button"
        onClick={() => setOpen(true)}
        className="ml-1 rounded border border-[var(--rule)] px-1 align-baseline text-[10px] leading-4 text-[var(--ink-dim)] hover:text-[var(--ink)]"
      >
        Preview
      </button>}
      {open && <PreviewModal path={path} onClose={() => setOpen(false)} />}
    </>
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
