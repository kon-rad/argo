import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type MemoryFact } from '../lib/api.js';

/** Saved sourced claims, with retirement and agent filtering. */

/** A fact's source: a vault path links to the file, a URL goes out, a card or message id stays plain text. */
function SourceLink({ source }: { source: string }) {
  if (/^https?:\/\//.test(source)) {
    return (
      <a href={source} target="_blank" rel="noreferrer" className="font-mono text-[var(--ink-dim)] underline">
        {source}
      </a>
    );
  }
  if (/\.md$|^(Areas|Projects|Research|CURRENT|Archives)\//.test(source)) {
    return (
      <Link to={`/file/${source}`} className="font-mono text-[var(--ink-dim)] underline">
        {source}
      </Link>
    );
  }
  return <span className="font-mono text-[var(--ink-dim)]">{source}</span>;
}

export default function Memory() {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const [agent, setAgent] = useState('');
  const [retiring, setRetiring] = useState<number | null>(null);
  const [retireWhy, setRetireWhy] = useState('');

  const facts = useQuery<{ facts: MemoryFact[] }>({
    queryKey: ['memory', 'facts', agent],
    queryFn: () => api.memoryFacts({ agent: agent || undefined, limit: 200 }),
  });

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['memory'] });
  };

  const retire = useMutation({
    mutationFn: ({ id, why }: { id: number; why: string }) => api.retireMemoryFact(id, why),
    onSuccess: async () => {
      setNotice('Fact retired (it stays in the record, closed).');
      setRetiring(null);
      setRetireWhy('');
      await refresh();
    },
    onError: (e: Error) => setNotice(e.message),
  });

  const onRetire = (id: number): void => {
    const why = retireWhy.trim();
    if (why) retire.mutate({ id, why });
  };

  return (
    <div className="mx-auto max-w-3xl px-6 py-6">
      <h1 className="text-lg font-semibold tracking-tight">Memory</h1>
      <p className="mt-1 text-xs text-[var(--ink-dim)]">
        Facts learned from finished sessions are saved automatically, each with a source.
        Retire a fact when it is wrong or out of date.
      </p>

      {notice && (
        <p className="mt-3 rounded border border-[var(--rule)] bg-[var(--paper-sunk)] px-3 py-2 text-xs">{notice}</p>
      )}

      <div className="mt-8 flex items-center justify-between gap-3 border-t border-[var(--rule)] pt-4">
        <h2 className="text-sm font-medium">Facts {facts.data ? `(${facts.data.facts.length})` : ''}</h2>
        <label className="text-xs text-[var(--ink-dim)]">
          agent{' '}
          <input
            value={agent}
            onChange={(e) => setAgent(e.target.value.trim())}
            placeholder="all"
            className="w-28 rounded border border-[var(--rule)] bg-transparent px-2 py-1 font-mono text-xs"
          />
        </label>
      </div>
      <ul className="mt-2 space-y-2">
        {facts.data?.facts.length === 0 && <li className="text-xs text-[var(--ink-faint)]">No facts{facts.data ? ' yet' : ''}.</li>}
        {facts.data?.facts.map((f) => (
          <li key={f.id} className="rounded border border-[var(--rule)] p-3">
            <div className="text-sm">
              <span className="font-medium">{f.subject}:</span> {f.claim}
            </div>
            <p className="mt-1 text-xs text-[var(--ink-faint)]">
              #{f.id}
              {f.agent ? ` · ${f.agent}'s` : ''}
              {f.project_slug ? ` · ${f.project_slug}` : ''} · {f.confidence} · by {f.author}
              {f.via ? ` via ${f.via}` : ''} · <SourceLink source={f.source} />
            </p>
            <button
              type="button"
              disabled={retire.isPending}
              onClick={() => (retiring === f.id ? onRetire(f.id) : (setRetiring(f.id), setRetireWhy('')))}
              className="mt-2 rounded border border-[var(--rule)] px-2.5 py-1 text-xs text-[var(--ink-dim)] hover:bg-[var(--paper-sunk)] disabled:text-[var(--ink-faint)]"
            >
              Retire
            </button>
            {retiring === f.id && (
              <div className="mt-2 flex items-center gap-2">
                <input
                  autoFocus
                  value={retireWhy}
                  onChange={(e) => setRetireWhy(e.target.value)}
                  placeholder="why it no longer holds"
                  className="flex-1 rounded border border-[var(--rule)] bg-transparent px-2 py-1 text-xs"
                />
                <button
                  type="button"
                  disabled={retire.isPending || !retireWhy.trim()}
                  onClick={() => onRetire(f.id)}
                  className="rounded border border-[var(--rule)] px-2.5 py-1 text-xs hover:bg-[var(--paper-sunk)] disabled:text-[var(--ink-faint)]"
                >
                  Close it
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
