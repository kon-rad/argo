import { query } from './db.js';

export interface SearchHit {
  source_kind: string;
  ref_id: string;
  ref_path: string;
  title: string | null;
  snippet: string;
  rank: number;
  occurred_at: string;
}

export interface SearchOptions {
  source?: string;
  limit: number;
  offset: number;
}

/** Filename matches sit below every text match, never interleaved with them. */
const FILENAME_RANK = 1e-6;

/**
 * ts_headline splices its markers into the file's raw text without escaping
 * it, and the frontend renders the snippet as HTML. Marking the highlights
 * with control characters, escaping the result, and only then emitting <b> is
 * what stops a note that happens to contain a <script> tag from executing when
 * it turns up in search results. No text file carries U+0001 or U+0002.
 */
const HL_START = '\u0001';
const HL_STOP = '\u0002';

/** Shared with the semantic branch, which renders chunk text into the same field. */
export function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function toSafeSnippet(raw: string): string {
  return escapeHtml(raw).replaceAll(HL_START, '<b>').replaceAll(HL_STOP, '</b>');
}

/** `%`, `_` and `\` are ordinary characters in a search box, not wildcards. */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Two branches over one ordering. The text branch is `websearch_to_tsquery`,
 * so quoted phrases and `-exclusions` behave the way the box implies. The
 * filename branch exists because the vault's images, PDFs and videos have no
 * indexable text at all — the only handle on them is what they are called.
 *
 * `ts_headline` runs on the paginated page rather than on every match: it is
 * the expensive part of the query and there is no reason to build snippets for
 * rows nobody asked for.
 */
export async function search(
  q: string,
  opts: SearchOptions,
): Promise<{ results: SearchHit[]; total: number }> {
  const term = q.trim();
  if (!term) return { results: [], total: 0 };

  const { rows } = await query<SearchHit & { total: number }>(
    `WITH tsq AS (SELECT websearch_to_tsquery('english', $1) AS q),
     hits AS (
       SELECT d.source_kind, d.ref_id, d.ref_path, d.title, d.content,
              ts_rank_cd(d.tsv, tsq.q) AS rank, d.occurred_at
       FROM search_documents d, tsq
       WHERE d.tsv @@ tsq.q
         AND ($2::text IS NULL OR d.source_kind = $2)
       UNION ALL
       SELECT 'vault', f.id::text, f.path, coalesce(f.title, f.name), NULL,
              ${FILENAME_RANK}, f.mtime
       FROM vault_files f
       WHERE NOT f.is_markdown
         AND f.name ILIKE '%' || $3 || '%' ESCAPE '\\'
         AND ($2::text IS NULL OR $2 = 'vault')
     ),
     page AS (
       SELECT *, count(*) OVER () AS total
       FROM hits
       ORDER BY rank DESC, occurred_at DESC, ref_path
       LIMIT $4 OFFSET $5
     )
     SELECT p.source_kind, p.ref_id, p.ref_path, p.title, p.rank, p.occurred_at,
            p.total::int AS total,
            CASE
              WHEN p.content IS NULL THEN p.ref_path
              ELSE ts_headline('english', p.content, tsq.q,
                   'MaxFragments=2, MinWords=8, MaxWords=25, StartSel=' || $6 || ', StopSel=' || $7)
            END AS snippet
     FROM page p, tsq
     ORDER BY p.rank DESC, p.occurred_at DESC, p.ref_path`,
    [term, opts.source ?? null, escapeLike(term), opts.limit, opts.offset, HL_START, HL_STOP],
  );

  return {
    results: rows.map(({ total: _total, ...hit }) => ({
      ...hit,
      rank: Number(hit.rank),
      snippet: toSafeSnippet(hit.snippet),
    })),
    total: rows[0]?.total ?? 0,
  };
}
