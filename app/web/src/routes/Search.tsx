import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { api, fileHref, type SearchMode, type SearchResponse } from '../lib/api.js';

const PAGE = 25;

const MODES: { value: SearchMode; label: string; hint: string }[] = [
  { value: 'keyword', label: 'Keyword', hint: 'Postgres full-text. Exact words, quoted "phrases" and -exclusions.' },
  { value: 'semantic', label: 'Meaning', hint: 'Nearest neighbours over embedded chunks. Finds notes that never use your words.' },
  { value: 'hybrid', label: 'Both', hint: 'Keyword and meaning, fused by reciprocal rank. The best default when you are not sure.' },
];

const MATCH_LABEL: Record<string, string> = {
  text: 'text',
  filename: 'filename',
  semantic: 'meaning',
  hybrid: 'both',
};

export default function Search() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const source = params.get('source') ?? '';
  const offset = Number(params.get('offset') ?? 0);
  const mode = (params.get('mode') as SearchMode | null) ?? 'keyword';

  const { data, isPending, error } = useQuery<SearchResponse>({
    queryKey: ['search', q, source, offset, mode],
    queryFn: () => api.search(q, source || undefined, offset, PAGE, mode),
    enabled: q.trim().length > 0,
  });

  function setParam(key: string, value: string): void {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== 'offset') next.delete('offset');
    setParams(next);
  }

  if (!q.trim()) {
    return <p className="p-6 text-[var(--ink-dim)]">Type something in the search box.</p>;
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-6">
      <div className="mb-3 flex flex-wrap items-center gap-1">
        {MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            title={m.hint}
            onClick={() => setParam('mode', m.value)}
            className={
              'rounded px-2.5 py-1 text-xs transition ' +
              (mode === m.value
                ? 'bg-[var(--accent)] text-[var(--paper)]'
                : 'border border-[var(--rule)] text-[var(--ink-dim)] hover:text-[var(--ink)]')
            }
          >
            {m.label}
          </button>
        ))}
        {data?.degraded && (
          <span
            title="The embedding provider could not be reached, so these are keyword results only."
            className="ml-2 rounded border border-amber-500/40 px-2 py-0.5 text-[10px] text-amber-600"
          >
            vector branch offline — keyword only
          </span>
        )}
      </div>

      <div className="mb-4 flex items-baseline justify-between gap-4">
        <p className="text-[var(--ink-dim)]">
          {isPending ? 'searching…' : `${data?.total ?? 0} result${data?.total === 1 ? '' : 's'} for `}
          {!isPending && <span className="text-[var(--ink)]">{q}</span>}
        </p>
        <select
          value={source}
          onChange={(event) => setParam('source', event.target.value)}
          aria-label="Filter by source"
          className="rounded border border-[var(--rule)] bg-[var(--paper-sunk)] px-2 py-1 text-xs"
        >
          <option value="">All sources</option>
          <option value="vault">Vault</option>
          <option value="discord">Discord</option>
        </select>
      </div>

      {error && <p className="text-red-500">{(error as Error).message}</p>}

      {data?.results.length === 0 && (
        <p className="text-[var(--ink-dim)]">
          {mode === 'keyword' ? (
            <>
              Nothing matched. Quoted <code>"phrases"</code> and <code>-exclusions</code> both work
              here — or try <button type="button" className="text-[var(--accent)] hover:underline" onClick={() => setParam('mode', 'hybrid')}>searching by meaning</button>.
            </>
          ) : (
            <>
              Nothing was near enough. If the vault has never been embedded, run the Embeddings
              source once from the Sources screen.
            </>
          )}
        </p>
      )}

      <ol className="space-y-4">
        {data?.results.map((hit) => (
          <li key={`${hit.source_kind}:${hit.ref_id}`}>
            <div className="flex items-baseline gap-2">
              {hit.source_kind === 'vault' ? (
                <Link
                  to={fileHref(hit.ref_path)}
                  className="font-medium text-[var(--accent)] hover:underline"
                >
                  {hit.title ?? hit.ref_path}
                </Link>
              ) : (
                <span className="font-medium">{hit.title ?? hit.ref_path}</span>
              )}
              <span className="rounded border border-[var(--rule)] px-1 text-[10px] tracking-wide text-[var(--ink-faint)] uppercase">
                {hit.source_kind}
              </span>
              {hit.match_kind && mode !== 'keyword' && (
                <span
                  title={
                    hit.similarity != null
                      ? `cosine similarity ${hit.similarity.toFixed(3)}`
                      : 'matched on text only'
                  }
                  className="rounded border border-[var(--rule)] px-1 text-[10px] tracking-wide text-[var(--ink-faint)] uppercase"
                >
                  {MATCH_LABEL[hit.match_kind] ?? hit.match_kind}
                  {hit.similarity != null && ` ${hit.similarity.toFixed(2)}`}
                </span>
              )}
            </div>
            <p className="font-mono text-xs text-[var(--ink-faint)]">
              {hit.ref_path}
              {hit.heading_path && <span className="text-[var(--ink-dim)]"> › {hit.heading_path}</span>}
            </p>
            {/* The snippet is ts_headline output: server-generated <b> tags
                around lexeme matches, never user-authored markup. */}
            <p
              className="mt-1 text-[13px] leading-relaxed text-[var(--ink-dim)] [&_b]:font-semibold [&_b]:text-[var(--ink)]"
              dangerouslySetInnerHTML={{ __html: hit.snippet }}
            />
          </li>
        ))}
      </ol>

      {data && (data.has_more || offset > 0) && (
        <div className="mt-6 flex gap-3 border-t border-[var(--rule)] pt-4">
          <button
            type="button"
            disabled={offset === 0}
            onClick={() => setParam('offset', String(Math.max(0, offset - PAGE)))}
            className="text-[var(--accent)] disabled:text-[var(--ink-faint)] hover:underline disabled:no-underline"
          >
            ← previous
          </button>
          <button
            type="button"
            disabled={!data.has_more}
            onClick={() => setParam('offset', String(offset + PAGE))}
            className="text-[var(--accent)] disabled:text-[var(--ink-faint)] hover:underline disabled:no-underline"
          >
            next →
          </button>
        </div>
      )}
    </div>
  );
}
