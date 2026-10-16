import { withTransaction } from "./db.js";

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

/**
 * Rank ladder. Full-text matches score 0.1 or more under ts_rank_cd; a note
 * that only contains the query as a substring sits below all of them, and a
 * filename-only match below that, never interleaved.
 */
const SUBSTRING_RANK = 1e-4;
const FILENAME_RANK = 1e-6;

/** Substrings shorter than this can't use the trigram index and match everything anyway. */
const MIN_SUBSTRING = 3;

/** Characters of context on each side of a substring hit in its snippet. */
const SNIPPET_CONTEXT = 80;

/**
 * ts_headline splices its markers into the file's raw text without escaping
 * it, and the frontend renders the snippet as HTML. Marking the highlights
 * with control characters, escaping the result, and only then emitting <b> is
 * what stops a note that happens to contain a <script> tag from executing when
 * it turns up in search results. No text file carries U+0001 or U+0002.
 */
const HL_START = "\u0001";
const HL_STOP = "\u0002";

/** Shared with the semantic branch, which renders chunk text into the same field. */
export function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function toSafeSnippet(raw: string): string {
  return escapeHtml(raw)
    .replaceAll(HL_START, "<b>")
    .replaceAll(HL_STOP, "</b>");
}

/** `%`, `_` and `\` are ordinary characters in a search box, not wildcards. */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * The literal text the substring branch looks for. A query wrapped in quotes
 * means the phrase inside them, in both branches.
 */
function literalOf(term: string): string {
  const m = /^"(.+)"$/.exec(term);
  return (m?.[1] ?? term).trim();
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * ts_headline only highlights full-text matches. A substring hit gets its
 * window cut in SQL and marked here, before escaping, with the same control
 * characters the headline uses.
 */
function markSubstring(window: string, literal: string): string {
  if (!literal) return window;
  return window.replace(
    new RegExp(escapeRegExp(literal), "gi"),
    (m) => `${HL_START}${m}${HL_STOP}`,
  );
}

/**
 * Two branches over one ordering. The text branch is `websearch_to_tsquery`,
 * so quoted phrases and `-exclusions` behave the way the box implies, OR'd
 * with a plain ILIKE over content and title so any substring is found the way
 * an editor's find would (a part number like "LSM6DSV" inside "LSM6DSV16X",
 * which full-text indexes as one token). The trigram indexes from the
 * search-trigram migration keep that ILIKE to milliseconds. The filename
 * branch exists because the vault's images, PDFs and videos have no
 * indexable text at all — the only handle on them is what they are called.
 *
 * `ts_headline` runs on the paginated page rather than on every match: it is
 * the expensive part of the query and there is no reason to build snippets for
 * rows nobody asked for.
 *
 * The query runs with `enable_seqscan` off for its own transaction. The
 * planner costs a scan of `vault_files` by its heap pages, which are few
 * because every note body lives in TOAST, and never counts detoasting 50 MB
 * of text to run ILIKE over it. Measured on the droplet on 2026-10-16: the
 * scan it picks takes 1.1 s, the bitmap path over the GIN indexes 17 ms.
 */
export async function search(
  q: string,
  opts: SearchOptions,
): Promise<{ results: SearchHit[]; total: number }> {
  const term = q.trim();
  if (!term) return { results: [], total: 0 };
  const literal = literalOf(term);
  const substring = literal.length >= MIN_SUBSTRING;

  const { rows } = await withTransaction(async (c) => {
    // One round trip for all three (a plain multi-statement string). The GIN
    // indexes apply only when the planner sees the tsquery and the ILIKE
    // pattern as plain expressions over the parameters: behind a CTE they
    // become join clauses, no index path exists, and the query falls back to
    // the full scan. Custom plans keep the real values visible. The disabled
    // scan's penalty cost would push the plan past jit_above_cost, and
    // compiling it took 535 ms against 12 ms of actual work.
    await c.query(
      "SET LOCAL enable_seqscan = off; SET LOCAL plan_cache_mode = force_custom_plan; SET LOCAL jit = off",
    );
    return c.query<SearchHit & { total: number; text_match: boolean }>(
      `WITH hits AS (
       SELECT d.source_kind, d.ref_id, d.ref_path, d.title, d.content,
              d.tsv @@ websearch_to_tsquery('english', $1) AS text_match,
              greatest(ts_rank_cd(d.tsv, websearch_to_tsquery('english', $1)), ${SUBSTRING_RANK}) AS rank,
              d.occurred_at
       FROM search_documents d
       WHERE (d.tsv @@ websearch_to_tsquery('english', $1)
              OR ($8 AND (d.content ILIKE ('%' || $3 || '%') ESCAPE '\\'
                          OR d.title ILIKE ('%' || $3 || '%') ESCAPE '\\')))
         AND ($2::text IS NULL OR d.source_kind = $2)
       UNION ALL
       SELECT 'vault', f.id::text, f.path, coalesce(f.title, f.name), NULL, false,
              ${FILENAME_RANK}, f.mtime
       FROM vault_files f
       WHERE NOT f.is_markdown
         AND f.name ILIKE ('%' || $3 || '%') ESCAPE '\\'
         AND ($2::text IS NULL OR $2 = 'vault')
     ),
     page AS (
       SELECT *, count(*) OVER () AS total
       FROM hits
       ORDER BY rank DESC, occurred_at DESC, ref_path
       LIMIT $4 OFFSET $5
     )
     SELECT p.source_kind, p.ref_id, p.ref_path, p.title, p.rank, p.occurred_at,
            p.text_match, p.total::int AS total,
            CASE
              WHEN p.content IS NULL THEN p.ref_path
              WHEN p.text_match THEN ts_headline('english', p.content, websearch_to_tsquery('english', $1),
                   'MaxFragments=2, MinWords=8, MaxWords=25, StartSel=' || $6 || ', StopSel=' || $7)
              ELSE substr(p.content,
                          greatest(strpos(lower(p.content), lower($9)) - ${SNIPPET_CONTEXT}, 1),
                          length($9) + ${2 * SNIPPET_CONTEXT})
            END AS snippet
     FROM page p
     ORDER BY p.rank DESC, p.occurred_at DESC, p.ref_path`,
      [
        term,
        opts.source ?? null,
        escapeLike(literal),
        opts.limit,
        opts.offset,
        HL_START,
        HL_STOP,
        substring,
        literal,
      ],
    );
  });

  return {
    results: rows.map(({ total: _total, text_match, ...hit }) => ({
      ...hit,
      rank: Number(hit.rank),
      snippet: toSafeSnippet(
        text_match ? hit.snippet : markSubstring(hit.snippet, literal),
      ),
    })),
    total: rows[0]?.total ?? 0,
  };
}
