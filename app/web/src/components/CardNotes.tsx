import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, fileHref } from '../lib/api.js';
import { collectVaultRefs } from '../lib/vaultRefs.js';

/** The vault notes a card's title, body or result names, by card; resolved in batches of 100 for the whole board. */
export function useCardNotesFor(items: { id: string; text: string }[]) {
  const key = items.map((i) => `${i.id}:${i.text.length}`).join('|');
  const refsByTask = useMemo(
    () => new Map(items.map((i) => [i.id, collectVaultRefs(i.text)])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  const all = useMemo(() => [...new Set([...refsByTask.values()].flat())].sort(), [refsByTask]);
  const resolved = useQuery({
    queryKey: ['vault-resolve-board', all],
    queryFn: async () => {
      const out: Record<string, string | null> = {};
      for (let i = 0; i < all.length; i += 100) Object.assign(out, (await api.resolveRefs(all.slice(i, i + 100))).resolved);
      return out;
    },
    enabled: all.length > 0,
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });
  return { refsByTask, resolved: resolved.data ?? {} };
}

/** Links on a card tile to the notes it references; refs that aren't vault files are left out. */
export function CardNotes({ refs, resolved }: { refs: string[]; resolved: Record<string, string | null> }) {
  const paths = [...new Set(refs.map((r) => resolved[r]).filter((p): p is string => !!p))];
  if (!paths.length) return null;
  return (
    <div className="flex flex-wrap gap-1 px-2 pb-1.5" aria-label="Referenced notes">
      {paths.slice(0, 4).map((p) => (
        <Link key={p} to={fileHref(p)} title={p}
          className="max-w-full truncate rounded bg-[var(--paper-sunk)] px-1.5 py-0.5 text-[0.7rem] text-[var(--accent)] underline-offset-2 hover:underline">
          {p.split('/').filter(Boolean).pop()}{p.endsWith('/') ? '/' : ''}
        </Link>
      ))}
      {paths.length > 4 && <span className="text-[0.7rem] text-[var(--ink-faint)]">+{paths.length - 4} more</span>}
    </div>
  );
}
