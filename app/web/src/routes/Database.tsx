import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, type DbQueryResult, type DbTable } from '../lib/api.js';

/** Columns that are unreadable in a result grid: vectors and tsvectors. */
const OPAQUE = /^(vector|tsvector)\b/;

function starterSql(table: DbTable): string {
  const cols = table.columns.filter((c) => !OPAQUE.test(c.type)).map((c) => c.name);
  const list = cols.length === table.columns.length ? '*' : cols.join(', ');
  return `SELECT ${list}\nFROM ${table.name}\nLIMIT 50`;
}

/**
 * The database behind the app: every table and column on the left, and on the
 * right a question box that asks a model for SQL, the SQL itself (editable),
 * and its results. Queries run read-only on the server, so nothing typed or
 * generated here can change the data.
 */
export default function Database() {
  const schema = useQuery({ queryKey: ['db-schema'], queryFn: api.dbSchema });
  const [question, setQuestion] = useState('');
  const [sql, setSql] = useState('');
  const [model, setModel] = useState<string | null>(null);

  const run = useMutation<DbQueryResult, Error, string>({ mutationFn: api.dbQuery });
  const ask = useMutation<{ sql: string; model: string }, Error, string>({
    mutationFn: api.dbAsk,
    onSuccess: (data) => {
      setSql(data.sql);
      setModel(data.model);
      run.mutate(data.sql);
    },
  });

  function runSql(text: string): void {
    if (!text.trim()) return;
    run.mutate(text);
  }

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <SchemaPane
        tables={schema.data?.tables}
        error={schema.error}
        onPick={(table) => {
          const text = starterSql(table);
          setSql(text);
          setModel(null);
          runSql(text);
        }}
      />

      <section className="min-h-0 min-w-0 flex-1 overflow-auto px-6 py-6">
        <h1 className="text-lg font-semibold tracking-tight">Ask the database</h1>
        <p className="mt-1 text-xs text-[var(--ink-dim)]">
          Describe what you want; a model writes the SQL, you can edit it, and it runs read-only.
        </p>

        <form
          className="mt-4 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (question.trim()) ask.mutate(question.trim());
          }}
        >
          <input
            type="text"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="e.g. which folders have the most notes edited this month?"
            aria-label="Question"
            autoFocus
            className="w-full rounded border border-[var(--rule)] bg-[var(--paper-sunk)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)]"
          />
          <button
            type="submit"
            disabled={ask.isPending}
            className="shrink-0 rounded border border-[var(--rule)] px-3 py-1.5 text-sm hover:bg-[var(--paper-sunk)] disabled:text-[var(--ink-faint)]"
          >
            {ask.isPending ? 'Writing SQL…' : 'Ask'}
          </button>
        </form>
        {ask.error && <p className="mt-2 text-sm text-red-500">{ask.error.message}</p>}

        <div className="mt-5 flex items-baseline justify-between">
          <label htmlFor="sql" className="text-xs font-medium tracking-wide text-[var(--ink-dim)] uppercase">
            SQL
          </label>
          {model && <span className="text-[10px] text-[var(--ink-faint)]">written by {model}</span>}
        </div>
        <textarea
          id="sql"
          value={sql}
          onChange={(event) => setSql(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              runSql(sql);
            }
          }}
          spellCheck={false}
          rows={Math.min(16, Math.max(4, sql.split('\n').length + 1))}
          placeholder="SELECT … — or pick a table on the left"
          className="mt-1 w-full rounded border border-[var(--rule)] bg-[var(--paper-sunk)] px-2.5 py-2 font-mono text-xs leading-relaxed outline-none focus:border-[var(--accent)]"
        />
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            onClick={() => runSql(sql)}
            disabled={run.isPending || !sql.trim()}
            className="rounded border border-[var(--rule)] px-3 py-1 text-sm hover:bg-[var(--paper-sunk)] disabled:text-[var(--ink-faint)]"
          >
            {run.isPending ? 'Running…' : 'Run'}
          </button>
          <span className="text-xs text-[var(--ink-faint)]">⌘↵ to run · read-only · 500 rows · 10 s</span>
        </div>

        {run.error && <p className="mt-4 font-mono text-xs text-red-500">{run.error.message}</p>}
        {run.data && !run.error && <Results result={run.data} />}
      </section>
    </div>
  );
}

function SchemaPane({
  tables,
  error,
  onPick,
}: {
  tables: DbTable[] | undefined;
  error: Error | null;
  onPick: (table: DbTable) => void;
}) {
  const [filter, setFilter] = useState('');
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!tables || !f) return tables;
    return tables.filter(
      (t) => t.name.includes(f) || t.columns.some((c) => c.name.includes(f)) || t.note?.toLowerCase().includes(f),
    );
  }, [tables, filter]);

  return (
    <aside className="max-h-[40vh] shrink-0 overflow-auto border-b border-[var(--rule)] px-3 py-4 md:max-h-none md:w-96 md:border-r md:border-b-0">
      <div className="flex items-baseline justify-between px-1">
        <h2 className="text-sm font-semibold">Schema</h2>
        {tables && (
          <span className="text-[10px] text-[var(--ink-faint)]">
            {tables.length} tables &amp; views
          </span>
        )}
      </div>
      <input
        type="search"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder="Filter tables and columns…"
        aria-label="Filter schema"
        className="mt-2 w-full rounded border border-[var(--rule)] bg-[var(--paper-sunk)] px-2 py-1 text-xs outline-none focus:border-[var(--accent)]"
      />
      {error && <p className="mt-3 text-xs text-red-500">{error.message}</p>}
      {!tables && !error && <p className="mt-3 text-xs text-[var(--ink-dim)]">loading…</p>}

      <ul className="mt-3 space-y-1">
        {shown?.map((t) => (
          <li key={t.name}>
            <details open={filter.trim().length > 0} className="group rounded border border-transparent open:border-[var(--rule)]">
              <summary className="flex cursor-pointer items-baseline gap-2 rounded px-1.5 py-1 hover:bg-[var(--paper-sunk)]">
                <span className="font-mono text-xs">{t.name}</span>
                {t.kind === 'view' && <Badge>view</Badge>}
                <span className="ml-auto text-[10px] text-[var(--ink-faint)] tabular-nums">
                  {t.rows != null ? `${t.rows.toLocaleString()} rows` : ''}
                </span>
              </summary>
              <div className="px-2 pb-2">
                {t.note && <p className="mt-1 text-[11px] leading-snug text-[var(--ink-dim)]">{t.note}</p>}
                <table className="mt-2 w-full text-[11px]">
                  <tbody>
                    {t.columns.map((c) => (
                      <tr key={c.name} className="align-baseline">
                        <td className="py-0.5 pr-2 font-mono">
                          {c.name}
                          {!c.nullable && <span className="text-[var(--ink-faint)]" title="NOT NULL">*</span>}
                        </td>
                        <td className="py-0.5 pr-1 font-mono text-[var(--ink-dim)]">{c.type}</td>
                        <td className="py-0.5 text-right whitespace-nowrap">
                          {c.pk && <Badge>PK</Badge>}
                          {c.generated && <Badge>gen</Badge>}
                          {c.references && (
                            <span title={`references ${c.references.table}.${c.references.column}`}>
                              <Badge>→ {c.references.table}</Badge>
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button
                  type="button"
                  onClick={() => onPick(t)}
                  className="mt-2 text-[11px] text-[var(--accent)] hover:underline"
                >
                  Query this {t.kind} →
                </button>
              </div>
            </details>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="ml-1 rounded border border-[var(--rule)] px-1 text-[9px] tracking-wide text-[var(--ink-faint)]">
      {children}
    </span>
  );
}

function Results({ result }: { result: DbQueryResult }) {
  return (
    <div className="mt-5">
      <p className="text-xs text-[var(--ink-dim)]">
        {result.row_count.toLocaleString()} row{result.row_count === 1 ? '' : 's'} · {result.ms} ms
        {result.truncated && <span className="text-amber-600"> · capped at {result.row_count} — add a LIMIT or narrow the query</span>}
      </p>
      {result.columns.length > 0 && (
        <div className="mt-2 max-h-[60vh] overflow-auto rounded border border-[var(--rule)]">
          <table className="min-w-full text-xs">
            <thead className="sticky top-0 bg-[var(--paper-sunk)]">
              <tr>
                {result.columns.map((c, i) => (
                  <th key={i} className="border-b border-[var(--rule)] px-2 py-1.5 text-left font-mono font-medium whitespace-nowrap">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, r) => (
                <tr key={r} className="odd:bg-[var(--paper)] even:bg-[var(--paper-sunk)]/50">
                  {row.map((v, i) => (
                    <td key={i} className="max-w-md border-b border-[var(--rule)] px-2 py-1 align-top">
                      <Cell value={v} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Cell({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-[var(--ink-faint)] italic">null</span>;
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return (
    <div className="line-clamp-4 font-mono break-words whitespace-pre-wrap" title={text.length > 120 ? text : undefined}>
      {text}
    </div>
  );
}
