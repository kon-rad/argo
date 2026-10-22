import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  api, fileHref,
  type AgentHit, type GlobalSearchResponse, type RecordHit, type SearchHit, type SearchMode, type SearchScope,
} from '../lib/api.js';

const PAGE = 25;
const OVERVIEW = 5;

type Tab = 'all' | SearchScope;
const TABS: { value: Tab; label: string; hint: string }[] = [
  { value: 'all', label: 'All', hint: 'A few hits from every store' },
  { value: 'notes', label: 'Notes', hint: 'Markdown in the vault, plus Discord' },
  { value: 'records', label: 'Records', hint: 'Database rows: gear, projects, features, teams' },
  { value: 'agents', label: 'Agent logs', hint: 'Claude Code and Hermes messages, tool calls and results' },
];

const MODES: { value: SearchMode; label: string; hint: string }[] = [
  { value: 'keyword', label: 'Keyword', hint: 'Any substring, quoted "phrases" and -exclusions.' },
  { value: 'semantic', label: 'Meaning', hint: 'Nearest neighbours over embedded note chunks. Notes only.' },
  { value: 'hybrid', label: 'Both', hint: 'Keyword and meaning fused by reciprocal rank. Notes only.' },
];

const chip = 'rounded border border-[var(--rule)] px-1 text-[10px] tracking-wide text-[var(--ink-faint)] uppercase';
const snippetCls = 'mt-1 text-[13px] leading-relaxed text-[var(--ink-dim)] [&_b]:font-semibold [&_b]:text-[var(--ink)]';

export default function Search() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const tab = (params.get('scope') as Tab | null) ?? 'all';
  const mode = (params.get('mode') as SearchMode | null) ?? 'hybrid';
  const offset = Number(params.get('offset') ?? 0);
  const single = tab !== 'all';

  const { data, isPending, error } = useQuery<GlobalSearchResponse>({
    queryKey: ['global-search', q, tab, mode, offset],
    queryFn: () =>
      api.globalSearch(q, single ? [tab] : ['notes', 'records', 'agents'], mode, single ? offset : 0, single ? PAGE : OVERVIEW),
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
    return <p className="p-6 text-[var(--ink-dim)]">Type something in the search box. It searches notes, database records and agent logs.</p>;
  }

  const available = data?.available ?? ['notes', 'records', 'agents'];
  const count = (s: SearchScope): string => {
    const sec = data?.[s];
    return sec && !sec.error && !single ? ` ${sec.total}${sec.has_more ? '+' : ''}` : '';
  };
  const section = single ? data?.[tab as SearchScope] : undefined;

  return (
    <div className="mx-auto max-w-3xl px-6 py-6">
      <div className="mb-3 flex flex-wrap items-center gap-1">
        {TABS.filter((t) => t.value === 'all' || available.includes(t.value as SearchScope)).map((t) => (
          <button
            key={t.value}
            type="button"
            title={t.hint}
            onClick={() => setParam('scope', t.value === 'all' ? '' : t.value)}
            className={'rounded px-2.5 py-1 text-xs transition ' +
              (tab === t.value ? 'bg-[var(--accent)] text-[var(--paper)]' : 'border border-[var(--rule)] text-[var(--ink-dim)] hover:text-[var(--ink)]')}
          >
            {t.label}{t.value !== 'all' && count(t.value as SearchScope)}
          </button>
        ))}
        {(tab === 'all' || tab === 'notes') && (
          <span className="ml-auto flex items-center gap-1">
            {MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                title={m.hint}
                onClick={() => setParam('mode', m.value === 'hybrid' ? '' : m.value)}
                className={'rounded px-2 py-0.5 text-[11px] ' +
                  (mode === m.value ? 'border border-[var(--accent)] text-[var(--ink)]' : 'text-[var(--ink-faint)] hover:text-[var(--ink)]')}
              >
                {m.label}
              </button>
            ))}
          </span>
        )}
      </div>

      {isPending && <p className="text-[var(--ink-dim)]">searching…</p>}
      {error && <p className="text-red-500">{(error as Error).message}</p>}

      {data && !single && (
        <div className="space-y-8">
          {available.includes('notes') && data.notes && (
            <Block title="Notes" scope="notes" sec={data.notes} onMore={setParam}>
              {data.notes.results.map((h) => <NoteRow key={`${h.source_kind}:${h.ref_id}`} hit={h} />)}
            </Block>
          )}
          {available.includes('records') && data.records && (
            <Block title="Records" scope="records" sec={data.records} onMore={setParam}>
              {data.records.results.map((h) => <RecordRow key={`${h.table}:${h.id}`} hit={h} />)}
            </Block>
          )}
          {available.includes('agents') && data.agents && (
            <Block title="Agent logs" scope="agents" sec={data.agents} onMore={setParam}>
              {data.agents.results.map((h, i) => <AgentRow key={`${h.host}:${h.external_id}:${h.seq}:${i}`} hit={h} />)}
            </Block>
          )}
        </div>
      )}

      {section && (
        <>
          {section.error && <p className="text-red-500">{section.error}</p>}
          {!section.error && <p className="mb-4 text-[var(--ink-dim)]">{section.total} result{section.total === 1 ? '' : 's'} for <span className="text-[var(--ink)]">{q}</span></p>}
          <ol className="space-y-4">
            {tab === 'notes' && data?.notes?.results.map((h) => <NoteRow key={`${h.source_kind}:${h.ref_id}`} hit={h} />)}
            {tab === 'records' && data?.records?.results.map((h) => <RecordRow key={`${h.table}:${h.id}`} hit={h} />)}
            {tab === 'agents' && data?.agents?.results.map((h, i) => <AgentRow key={`${h.host}:${h.external_id}:${h.seq}:${i}`} hit={h} />)}
          </ol>
          {(section.has_more || offset > 0) && (
            <div className="mt-6 flex gap-3 border-t border-[var(--rule)] pt-4">
              <button type="button" disabled={offset === 0} onClick={() => setParam('offset', String(Math.max(0, offset - PAGE)))}
                className="text-[var(--accent)] disabled:text-[var(--ink-faint)] hover:underline disabled:no-underline">← previous</button>
              <button type="button" disabled={!section.has_more} onClick={() => setParam('offset', String(offset + PAGE))}
                className="text-[var(--accent)] disabled:text-[var(--ink-faint)] hover:underline disabled:no-underline">next →</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Block<T>({ title, scope, sec, onMore, children }: {
  title: string; scope: SearchScope;
  sec: { results: T[]; total: number; has_more: boolean; error?: string; degraded?: boolean };
  onMore: (key: string, value: string) => void; children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex items-baseline gap-2 border-b border-[var(--rule)] pb-1">
        <h2 className="text-sm font-semibold">{title}</h2>
        {!sec.error && <span className="text-xs text-[var(--ink-faint)]">{sec.total}{sec.has_more ? '+' : ''}</span>}
        {sec.degraded && <span title="The embedding provider is not reachable, so these are keyword results only." className="rounded border border-amber-500/40 px-1 text-[10px] text-amber-600">keyword only</span>}
        {sec.total > sec.results.length && (
          <button type="button" onClick={() => onMore('scope', scope)} className="ml-auto text-xs text-[var(--accent)] hover:underline">all {sec.total} →</button>
        )}
      </div>
      {sec.error ? <p className="text-sm text-red-500">{sec.error}</p>
        : sec.results.length === 0 ? <p className="text-sm text-[var(--ink-faint)]">No matches.</p>
        : <ol className="space-y-4">{children}</ol>}
    </section>
  );
}

function NoteRow({ hit }: { hit: SearchHit }) {
  return (
    <li>
      <div className="flex items-baseline gap-2">
        {hit.source_kind === 'vault'
          ? <Link to={fileHref(hit.ref_path)} className="font-medium text-[var(--accent)] hover:underline">{hit.title ?? hit.ref_path}</Link>
          : <span className="font-medium">{hit.title ?? hit.ref_path}</span>}
        <span className={chip}>{hit.source_kind}</span>
        {hit.match_kind && hit.match_kind !== 'text' && (
          <span title={hit.similarity != null ? `cosine similarity ${hit.similarity.toFixed(3)}` : undefined} className={chip}>
            {hit.match_kind === 'semantic' ? 'meaning' : hit.match_kind}{hit.similarity != null && ` ${hit.similarity.toFixed(2)}`}
          </span>
        )}
      </div>
      <p className="font-mono text-xs text-[var(--ink-faint)]">
        {hit.ref_path}{hit.heading_path && <span className="text-[var(--ink-dim)]"> › {hit.heading_path}</span>}
      </p>
      {/* Server-built snippet: input escaped, only <b> added. */}
      <p className={snippetCls} dangerouslySetInnerHTML={{ __html: hit.snippet }} />
    </li>
  );
}

function RecordRow({ hit }: { hit: RecordHit }) {
  return (
    <li>
      <div className="flex items-baseline gap-2">
        {hit.notes_path
          ? <Link to={fileHref(hit.notes_path)} className="font-medium text-[var(--accent)] hover:underline">{hit.title}</Link>
          : <Link to="/database" className="font-medium text-[var(--accent)] hover:underline">{hit.title}</Link>}
        <span className={chip}>{hit.label}</span>
      </div>
      <p className="font-mono text-xs text-[var(--ink-faint)]">{hit.table} · {hit.id}</p>
      <p className={snippetCls} dangerouslySetInnerHTML={{ __html: hit.snippet }} />
    </li>
  );
}

function AgentRow({ hit }: { hit: AgentHit }) {
  const to = `/usage/session/${encodeURIComponent(hit.host)}/${encodeURIComponent(hit.external_id)}?source=${encodeURIComponent(hit.source)}`;
  return (
    <li>
      <div className="flex flex-wrap items-baseline gap-2">
        <Link to={to} className="font-medium text-[var(--accent)] hover:underline">{hit.session_title ?? hit.external_id}</Link>
        <span className={chip}>{hit.harness ?? hit.source}</span>
        <span className={chip}>{hit.host}</span>
        <span className={chip}>{hit.step ?? hit.role}</span>
      </div>
      <p className="font-mono text-xs text-[var(--ink-faint)]">{hit.ts ? hit.ts.slice(0, 16).replace('T', ' ') : 'no timestamp'} · message {hit.seq}</p>
      <p className={snippetCls} dangerouslySetInnerHTML={{ __html: hit.snippet }} />
    </li>
  );
}
