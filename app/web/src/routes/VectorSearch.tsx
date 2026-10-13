import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { api, fileHref, type SearchResponse } from '../lib/api.js';

const PAGE = 20;

/**
 * Semantic search only, no keyword/hybrid toggle — for that, use ⌘K / Search.
 * This page exists so a similarity search over meaning, not words, has its
 * own front door with the score and heading path always visible.
 */
export default function VectorSearch() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const offset = Number(params.get('offset') ?? 0);
  const [draft, setDraft] = useState(q);

  const { data, isPending, error } = useQuery<SearchResponse>({
    queryKey: ['vector-search', q, offset],
    queryFn: () => api.search(q, 'vault', offset, PAGE, 'semantic'),
    enabled: q.trim().length > 0,
  });

  function submit(): void {
    const trimmed = draft.trim();
    if (!trimmed) return;
    setParams({ q: trimmed });
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-6">
      <h1 className="text-lg font-semibold tracking-tight">Vector search</h1>
      <p className="mt-1 text-xs text-[var(--ink-dim)]">
        Nearest neighbours over embedded chunks — finds notes that never use your words.
      </p>

      <form
        className="mt-4 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <input
          type="search"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Describe what you're looking for…"
          aria-label="Vector search"
          autoFocus
          className="w-full rounded border border-[var(--rule)] bg-[var(--paper-sunk)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)]"
        />
        <button
          type="submit"
          className="shrink-0 rounded border border-[var(--rule)] px-3 py-1.5 text-sm hover:bg-[var(--paper-sunk)]"
        >
          Search
        </button>
      </form>

      {!q.trim() && (
        <p className="mt-6 text-[var(--ink-dim)]">Type a question or a description to search by meaning.</p>
      )}

      {q.trim() && (
        <>
          <p className="mt-6 text-[var(--ink-dim)]">
            {isPending ? 'searching…' : `${data?.total ?? 0} result${data?.total === 1 ? '' : 's'} for `}
            {!isPending && <span className="text-[var(--ink)]">{q}</span>}
          </p>

          {error && <p className="mt-2 text-red-500">{(error as Error).message}</p>}

          {data?.results.length === 0 && (
            <p className="mt-2 text-[var(--ink-dim)]">
              Nothing was near enough. If the vault has never been embedded, run the Embeddings
              source from the Sources screen.
            </p>
          )}

          <ol className="mt-4 space-y-4">
            {data?.results.map((hit) => (
              <li key={hit.ref_id} className="rounded border border-[var(--rule)] p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <Link
                    to={fileHref(hit.ref_path)}
                    className="font-medium text-[var(--accent)] hover:underline"
                  >
                    {hit.title ?? hit.ref_path}
                  </Link>
                  {hit.similarity != null && (
                    <span
                      title="cosine similarity"
                      className="shrink-0 rounded border border-[var(--rule)] px-1 text-[10px] tracking-wide text-[var(--ink-faint)]"
                    >
                      {hit.similarity.toFixed(2)}
                    </span>
                  )}
                </div>
                <p className="font-mono text-xs text-[var(--ink-faint)]">
                  {hit.ref_path}
                  {hit.heading_path && <span className="text-[var(--ink-dim)]"> › {hit.heading_path}</span>}
                </p>
                <p
                  className="mt-1 text-[13px] leading-relaxed text-[var(--ink-dim)]"
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
                onClick={() => setParams({ q, offset: String(Math.max(0, offset - PAGE)) })}
                className="text-[var(--accent)] disabled:text-[var(--ink-faint)] hover:underline disabled:no-underline"
              >
                ← previous
              </button>
              <button
                type="button"
                disabled={!data.has_more}
                onClick={() => setParams({ q, offset: String(offset + PAGE) })}
                className="text-[var(--accent)] disabled:text-[var(--ink-faint)] hover:underline disabled:no-underline"
              >
                next →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
