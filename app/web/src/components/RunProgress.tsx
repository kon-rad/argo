import type { Run } from '../lib/api.js';

const NUMBERS = ['scanned', 'inserted', 'updated', 'unchanged', 'deleted'] as const;

export default function RunProgress({ run }: { run: Run }) {
  const active = run.status === 'queued' || run.status === 'running';
  // `?? {}` is not paranoia: an older server, or a run row read before its
  // first progress write, hands back a summary with no progress at all.
  const progress = (run.progress ?? {}) as {
    phase?: string;
    filesSeen?: number;
    currentPath?: string;
  };

  return (
    <div className="mt-2 rounded border border-[var(--rule)] bg-[var(--paper-sunk)] px-3 py-2 text-xs">
      <div className="flex items-baseline gap-2">
        <span className={active ? 'text-[var(--accent)]' : run.status === 'error' ? 'text-red-500' : 'text-[var(--ink-dim)]'}>
          run #{run.id} · {run.status}
        </span>
        {run.finished_at && (
          <span className="text-[var(--ink-faint)]">
            {new Date(run.finished_at).toLocaleString()}
          </span>
        )}
      </div>

      {active && progress.phase && (
        <p className="mt-1 truncate text-[var(--ink-dim)]">
          {progress.phase}
          {progress.filesSeen !== undefined && ` · ${progress.filesSeen.toLocaleString()} files`}
          {progress.currentPath ? ` · ${progress.currentPath}` : ''}
        </p>
      )}

      {run.error && <p className="mt-1 text-red-500">{run.error}</p>}

      {run.status === 'ok' && (
        <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[var(--ink-dim)]">
          {NUMBERS.filter((key) => typeof run.stats?.[key] === 'number').map((key) => (
            <div key={key} className="flex gap-1">
              <dt>{key}</dt>
              <dd className="text-[var(--ink)]">{(run.stats[key] as number).toLocaleString()}</dd>
            </div>
          ))}
          {typeof run.stats?.['durationMs'] === 'number' && (
            <div className="flex gap-1">
              <dt>took</dt>
              <dd className="text-[var(--ink)]">
                {((run.stats['durationMs'] as number) / 1000).toFixed(1)}s
              </dd>
            </div>
          )}
        </dl>
      )}
    </div>
  );
}
