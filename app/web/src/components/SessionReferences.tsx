import { useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, fileHref } from '../lib/api.js';
import { collectVaultRefs } from '../lib/vaultRefs.js';

/** Literal tool/metadata output keeps its bytes and whitespace while references remain navigable. */
export function SessionReferences({ text }: { text: string }) {
  const refs = useMemo(() => collectVaultRefs(text), [text]);
  const resolved = useQuery({ queryKey: ['vault-resolve', refs], queryFn: () => api.resolveRefs(refs), enabled: refs.length > 0, staleTime: 60_000 });
  const chart = useQuery({ queryKey: ['org-chart'], queryFn: api.orgChart, staleTime: 300_000, retry: false });
  const agents = new Set((chart.data?.agents ?? []).map((a) => a.name));
  const paths = resolved.data?.resolved ?? {};
  // Match whole reference tokens, leaving unknown names and paths as text.
  const pattern = /\[\[([^\]\n]+)\]\]|(?<![\w@/.:-])@?[a-zA-Z0-9_-]+(?:\/[\w.-]+)*(?:\/)?/g;
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    const token = m[0];
    const target = m[1]?.split('|')[0]?.split('#')[0] ?? token;
    const name = token.replace(/^@/, '');
    const href = /^t_[a-f0-9]{8}$/.test(token) ? `/board/${token}`
      : agents.has(name) ? `/org/agents/${encodeURIComponent(name)}`
        : paths[target] ? fileHref(paths[target]!) : null;
    if (!href) continue;
    out.push(text.slice(last, m.index));
    out.push(<Link key={m.index} className="text-[var(--accent)] underline" to={href}>{token}</Link>);
    last = m.index + token.length;
  }
  out.push(text.slice(last));
  return <>{out}</>;
}

