import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Source } from './api.js';

/**
 * The vault source, its scan state, and a `rescan()` that walks the disk.
 *
 * The tree is read from the index, not the filesystem, so a file added on
 * disk shows up only after a scan — and only if the tree's cached listings
 * are dropped when that scan finishes. This hook does both: whenever a vault
 * scan completes (triggered here, from Sources, or anywhere else) every
 * `['tree', …]` query is invalidated, so open directories refetch in place.
 */
export function useVaultScan() {
  const queryClient = useQueryClient();

  const sources = useQuery<{ sources: Source[] }>({
    queryKey: ['sources'],
    queryFn: api.sources,
    // Poll only while the vault source is actually scanning — an idle app
    // makes no requests for this, same rule Sources.tsx follows.
    refetchInterval: (q) =>
      q.state.data?.sources.some((s) => s.kind === 'vault' && s.running) ? 1500 : false,
  });

  const vault = sources.data?.sources.find((s) => s.kind === 'vault');
  const running = vault?.running ?? false;
  // The newest run that has finished. Keyed on the run id rather than a
  // running→idle edge, so a scan that finishes between two polls still counts.
  const finishedRunId = vault && !running ? (vault.last_run?.id ?? null) : undefined;

  const seen = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    if (finishedRunId === undefined) return;
    if (seen.current !== undefined && seen.current !== finishedRunId) {
      void queryClient.invalidateQueries({ queryKey: ['tree'] });
    }
    seen.current = finishedRunId;
  }, [finishedRunId, queryClient]);

  const sync = useMutation({
    mutationFn: () => api.sync(vault!.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sources'] }),
  });

  return {
    vault,
    running,
    busy: running || sync.isPending,
    rescan: () => sync.mutate(),
  };
}
