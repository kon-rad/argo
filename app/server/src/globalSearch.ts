import { query } from './db.js';
import { HL_START, HL_STOP, escapeHtml, escapeLike, search, toSafeSnippet, type SearchHit } from './search.js';
import { hybridSearch, semanticSearch, type SemanticHit } from './semantic.js';
import type { EmbeddingProvider } from './embeddings/provider.js';

/**
 * One search over every store (vault: global-search-design.md). Each scope keeps its own
 * ranking: scores from a tsvector, a trigram match and a message log are not comparable,
 * so the sections stay separate and the page decides how to show them.
 */
export const SCOPES = ['notes', 'records', 'agents'] as const;
export type Scope = (typeof SCOPES)[number];
export type NotesMode = 'keyword' | 'semantic' | 'hybrid';

export interface RecordHit {
  table: string;
  label: string;
  id: string;
  title: string;
  snippet: string;
  /** Vault path of the record's note when it has one; the page links to the note. */
  notes_path: string | null;
}

export interface AgentHit {
  host: string;
  source: string;
  external_id: string;
  harness: string | null;
  session_title: string | null;
  step: string | null;
  role: string;
  seq: number;
  ts: string | null;
  snippet: string;
  rank: number;
}

export interface Section<T> {
  results: T[];
  total: number;
  has_more: boolean;
  /** Set when this scope failed; the others still return. */
  error?: string;
  degraded?: boolean;
}

export interface GlobalOptions {
  scopes: readonly Scope[];
  mode: NotesMode;
  limit: number;
  offset: number;
  provider?: () => EmbeddingProvider;
  harness?: string;
  host?: string;
}

/** Engine tables only. A table here must be safe to show to anyone who can open the app. */
interface RecordTable {
  table: string;
  label: string;
  id: string;
  title: string;
  /** Text columns searched, as SQL expressions that yield text. */
  text: string[];
  notesPath?: string;
}

export const RECORD_TABLES: RecordTable[] = [
  { table: 'inventory_items', label: 'Inventory', id: 'id::text', title: 'name',
    text: ['name', 'brand', 'model', 'category', 'location', 'status', 'specs::text'], notesPath: 'notes_path' },
  { table: 'projects', label: 'Project', id: 'slug', title: 'title',
    text: ['slug', 'title', 'area', 'stage', 'needs_owner', 'blocked_on'], notesPath: 'design_path' },
  { table: 'features', label: 'Feature', id: 'project_slug || \'/\' || slug', title: 'title',
    text: ['slug', 'title', 'project_slug', 'stage', 'owner', 'needs_owner', 'blocked_on'], notesPath: 'notes_path' },
  { table: 'teams', label: 'Team', id: 'slug', title: 'name', text: ['slug', 'name', 'mission', 'lead'] },
];

const SNIPPET_CHARS = 200;

function empty<T>(): Section<T> {
  return { results: [], total: 0, has_more: false };
}

export async function searchRecords(q: string, limit: number, offset: number): Promise<Section<RecordHit>> {
  const term = q.trim();
  if (term.length < 2) return empty();
  const pattern = `%${escapeLike(term)}%`;
  const perTable = await Promise.all(
    RECORD_TABLES.map(async (t) => {
      const haystack = `concat_ws(' · ', ${t.text.map((c) => `${c}::text`).join(', ')})`;
      try {
        const { rows } = await query<{ id: string; title: string; hay: string; notes_path: string | null }>(
          `SELECT ${t.id} AS id, ${t.title}::text AS title, ${haystack} AS hay,
                  ${t.notesPath ? `${t.notesPath}::text` : 'NULL::text'} AS notes_path
           FROM ${t.table} WHERE ${haystack} ILIKE $1 ESCAPE '\\' LIMIT $2`,
          [pattern, limit + offset + 1],
        );
        return rows.map((r): RecordHit => ({
          table: t.table, label: t.label, id: r.id, title: r.title,
          snippet: markWindow(r.hay, term), notes_path: r.notes_path,
        }));
      } catch {
        return []; // table missing on an older schema: skip it, don't fail the scope
      }
    }),
  );
  const all = perTable.flat();
  return { results: all.slice(offset, offset + limit), total: all.length, has_more: all.length > offset + limit };
}

/** Cut a window around the first literal hit and bold every occurrence, escaped. */
function markWindow(text: string, term: string): string {
  const at = text.toLowerCase().indexOf(term.toLowerCase());
  const from = Math.max(0, at - 60);
  const win = text.slice(from, from + SNIPPET_CHARS);
  const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  return escapeHtml(win.replace(re, (m) => `${HL_START}${m}${HL_STOP}`))
    .replaceAll(HL_START, '<b>').replaceAll(HL_STOP, '</b>');
}

export async function searchAgentLogs(
  q: string, limit: number, offset: number, filter: { harness?: string; host?: string } = {},
): Promise<Section<AgentHit>> {
  const term = q.trim();
  if (!term) return empty();
  const { rows } = await query<AgentHit & { total: number }>(
    `WITH hits AS (
       SELECT m.id, m.seq, m.role, m.step, m.ts, m.content_text, s.host, s.source, s.external_id, s.harness, s.title,
              ts_rank_cd(m.tsv, websearch_to_tsquery('simple', $1)) AS rank
       FROM archive_messages m JOIN archive_sessions s ON s.id = m.session_id
       WHERE m.tsv @@ websearch_to_tsquery('simple', $1)
         AND ($2::text IS NULL OR s.harness = $2) AND ($3::text IS NULL OR s.host = $3)
     ), page AS (
       SELECT *, count(*) OVER () AS total FROM hits
       ORDER BY rank DESC, ts DESC NULLS LAST, id LIMIT $4 OFFSET $5
     )
     SELECT host, source, external_id, harness, title AS session_title, step, role, seq, ts, rank, total::int AS total,
            ts_headline('simple', left(content_text, 20000), websearch_to_tsquery('simple', $1),
              'MaxFragments=2, MinWords=8, MaxWords=30, StartSel=' || $6 || ', StopSel=' || $7) AS snippet
     FROM page ORDER BY rank DESC, ts DESC NULLS LAST, id`,
    [term, filter.harness ?? null, filter.host ?? null, limit, offset, HL_START, HL_STOP],
  );
  const total = rows[0]?.total ?? 0;
  return {
    results: rows.map(({ total: _t, ...r }) => ({ ...r, rank: Number(r.rank), snippet: toSafeSnippet(r.snippet) })),
    total,
    has_more: offset + rows.length < total,
  };
}

async function searchNotes(q: string, o: GlobalOptions): Promise<Section<SearchHit | SemanticHit>> {
  const base = { limit: o.limit, offset: o.offset };
  if (o.mode === 'keyword') {
    const r = await search(q, base);
    return { ...r, has_more: o.offset + r.results.length < r.total };
  }
  let provider: EmbeddingProvider;
  try {
    if (!o.provider) throw new Error('semantic search is not configured on this server');
    provider = o.provider();
  } catch (err) {
    if (o.mode === 'semantic') throw err;
    // Hybrid without a provider is still a useful keyword search; say so instead of failing.
    const r = await search(q, base);
    return { ...r, has_more: o.offset + r.results.length < r.total, degraded: true };
  }
  if (o.mode === 'semantic') {
    const r = await semanticSearch(q, { ...base, provider });
    return { ...r, has_more: o.offset + r.results.length < r.total };
  }
  const r = await hybridSearch(q, { ...base, provider });
  return { ...r, has_more: o.offset + r.results.length < r.total };
}

export interface GlobalResponse {
  q: string;
  mode: NotesMode;
  notes?: Section<SearchHit | SemanticHit>;
  records?: Section<RecordHit>;
  agents?: Section<AgentHit>;
}

export async function globalSearch(q: string, o: GlobalOptions): Promise<GlobalResponse> {
  const run = async <T>(fn: () => Promise<Section<T>>): Promise<Section<T>> => {
    try { return await fn(); }
    catch (err) { return { ...empty<T>(), error: err instanceof Error ? err.message : String(err) }; }
  };
  const want = new Set(o.scopes);
  const [notes, records, agents] = await Promise.all([
    want.has('notes') ? run(() => searchNotes(q, o)) : undefined,
    want.has('records') ? run(() => searchRecords(q, o.limit, o.offset)) : undefined,
    want.has('agents') ? run(() => searchAgentLogs(q, o.limit, o.offset, { harness: o.harness, host: o.host })) : undefined,
  ]);
  return { q, mode: o.mode, notes, records, agents };
}
