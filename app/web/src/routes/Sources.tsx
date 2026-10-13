import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Run, type Source, type SystemInfo } from '../lib/api.js';
import RunProgress from '../components/RunProgress.js';

export default function Sources() {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);

  const sources = useQuery<{ sources: Source[] }>({
    queryKey: ['sources'],
    queryFn: api.sources,
  });
  const system = useQuery<SystemInfo>({ queryKey: ['system'], queryFn: api.system });

  // Poll ONLY while something is running. An idle Sources tab makes no
  // requests at all, which is the difference between a tool you can leave
  // open and one you close because it chatters.
  const anyActive = sources.data?.sources.some((s) => s.running) ?? false;
  const activeRuns = useQuery<{ runs: Run[] }>({
    queryKey: ['runs', 'active'],
    queryFn: () => api.runs({ active: true }),
    refetchInterval: anyActive ? 1500 : false,
  });

  const sync = useMutation({
    mutationFn: (id: number) => api.sync(id),
    onSuccess: async () => {
      setNotice(null);
      await queryClient.invalidateQueries({ queryKey: ['sources'] });
      await queryClient.invalidateQueries({ queryKey: ['runs'] });
    },
    onError: (error: Error) => setNotice(error.message),
  });

  const shutdown = useMutation({
    mutationFn: api.shutdown,
    onSuccess: () => setNotice('Server shut down. This tab is now offline.'),
    onError: (error: Error) => setNotice(error.message),
  });

  // A finished run stops the polling loop, so refresh the list once more when
  // the active set empties out.
  const activeIds = new Set(activeRuns.data?.runs.map((r) => r.source_id) ?? []);

  return (
    <div className="mx-auto max-w-3xl px-6 py-6">
      <h1 className="text-lg font-semibold tracking-tight">Sources</h1>

      {system.data && (
        <p className="mt-1 text-xs text-[var(--ink-dim)]">
          <span className="font-mono">{system.data.vault_root}</span> ·{' '}
          {system.data.counts.files.toLocaleString()} files ·{' '}
          {system.data.counts.markdown.toLocaleString()} notes ·{' '}
          {system.data.counts.links.toLocaleString()} links ·{' '}
          {system.data.counts.tags.toLocaleString()} tags
        </p>
      )}

      {notice && (
        <p className="mt-3 rounded border border-[var(--rule)] bg-[var(--paper-sunk)] px-3 py-2 text-xs">
          {notice}
        </p>
      )}

      <ul className="mt-5 space-y-4">
        {sources.data?.sources.map((source) => {
          const running = source.running || activeIds.has(source.id);
          const live = activeRuns.data?.runs.find((r) => r.source_id === source.id);
          return (
            <li key={source.id} className="rounded border border-[var(--rule)] p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="font-medium">{source.name}</h2>
                  <p className="text-xs text-[var(--ink-faint)]">
                    {source.kind}
                    {source.enabled ? '' : ' · disabled'}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={running || !source.enabled || sync.isPending}
                  onClick={() => sync.mutate(source.id)}
                  className="rounded border border-[var(--rule)] px-2.5 py-1 text-xs hover:bg-[var(--paper-sunk)] disabled:text-[var(--ink-faint)]"
                >
                  {running ? 'scanning…' : `Scan ${source.kind} now`}
                </button>
              </div>
              {live ? (
                <RunProgress run={live} />
              ) : source.last_run ? (
                <RunProgress run={source.last_run} />
              ) : (
                <p className="mt-2 text-xs text-[var(--ink-faint)]">Never scanned.</p>
              )}
            </li>
          );
        })}
      </ul>

      <div className="mt-8 border-t border-[var(--rule)] pt-4">
        <button
          type="button"
          onClick={() => shutdown.mutate()}
          className="rounded border border-[var(--rule)] px-2.5 py-1 text-xs text-[var(--ink-dim)] hover:bg-[var(--paper-sunk)] hover:text-[var(--ink)]"
        >
          Shut down server
        </button>
        <p className="mt-1 text-xs text-[var(--ink-faint)]">
          Stops the local Express process. Start it again with{' '}
          <code className="font-mono">secondbrain</code>.
        </p>
      </div>
    </div>
  );
}
