import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type AgentSummary } from '../../lib/api.js';
import { zoned } from '../../lib/time.js';
import { sessionLink } from './AgentSessions.js';
import { formatTokens } from './format.js';

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const OUTCOMES = ['finished', 'partial', 'blocked', 'failed', 'unknown'] as const;
const OUTCOME_STYLE: Record<string, string> = {
  finished: 'border-green-700 text-green-700', partial: 'border-amber-600 text-amber-700', blocked: 'border-amber-600 text-amber-700',
  failed: 'border-red-600 text-red-600', unknown: 'border-[var(--rule)] text-[var(--ink-dim)]',
};
const RANGES = [{ days: 1, label: '24 h' }, { days: 2, label: '2 d' }, { days: 7, label: '7 d' }, { days: 30, label: '30 d' }];

const totalTokens = (m: AgentSummary['metrics']) => m.input_tokens + m.cache_write_tokens + m.cache_read_tokens + m.output_tokens;

function Chip({ outcome }: { outcome: string }) {
  return <span className={`rounded border px-1 text-xs ${OUTCOME_STYLE[outcome] ?? ''}`}>{outcome}</span>;
}

function Card({ s }: { s: AgentSummary }) {
  const m = s.metrics;
  const title = s.title ?? s.external_id.slice(0, 12);
  return (
    <article className="border-t border-[var(--rule)] py-3" aria-label={`Summary of ${title}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--ink-dim)]">
        <Chip outcome={s.outcome} />
        <span>{s.ended_at ? zoned(s.ended_at, tz) : ''}</span>
        <span>{s.harness}{s.profile && s.profile !== 'main' ? ` · ${s.profile}` : ''} on {s.host}</span>
        {s.project ? <span>{s.project}</span> : null}
        <span title={`input ${formatTokens(m.input_tokens)} · cache write ${formatTokens(m.cache_write_tokens)} · cache read ${formatTokens(m.cache_read_tokens)} · output ${formatTokens(m.output_tokens)}`}>
          {formatTokens(totalTokens(m))} tokens</span>
        <span>{m.tool_calls} tool calls{m.error_steps ? <span className="text-red-600"> · ✗{m.error_steps}</span> : null}</span>
        {m.duration_s != null ? <span>{Math.max(1, Math.round(m.duration_s / 60))} min</span> : null}
        {m.models.length ? <span>{m.models.join(', ')}</span> : null}
      </div>
      <p className="mt-1 text-sm font-medium">{s.request}</p>
      <p className="text-sm">{s.done}</p>
      {s.learned ? <p className="text-sm"><span className="text-xs text-[var(--ink-dim)]">Learned </span>{s.learned}</p> : null}
      {s.open_items ? <p className="text-sm"><span className="text-xs text-[var(--ink-dim)]">Open </span>{s.open_items}</p> : null}
      <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-[var(--ink-dim)]">
        <Link className="underline" to={sessionLink(s)}>Open transcript</Link>
        {s.touched.files_edited.length ? <span title={s.touched.files_edited.join('\n')}>{s.touched.files_edited.length} files edited</span> : null}
        {s.touched.cards.length ? <span>{s.touched.cards.join(', ')}</span> : null}
        {s.touched.skills.length ? <span>skills: {s.touched.skills.join(', ')}</span> : null}
        {s.proposed_facts ? <span>{s.proposed_facts} proposed {s.proposed_facts === 1 ? 'fact' : 'facts'}</span> : null}
        <span title="Written by this model; the counts above are computed from the transcript, not written by it.">written by {s.writer_provider}/{s.writer_model}</span>
      </div>
    </article>
  );
}

function Facts() {
  const qc = useQueryClient();
  const facts = useQuery({ queryKey: ['summary-facts', 'proposed'], queryFn: () => api.summaryFacts('proposed') });
  const done = () => { void qc.invalidateQueries({ queryKey: ['summary-facts'] }); void qc.invalidateQueries({ queryKey: ['summary-overview'] }); };
  const promote = useMutation({ mutationFn: (id: number) => api.promoteSummaryFact(id), onSuccess: done });
  const reject = useMutation({ mutationFn: (id: number) => api.rejectSummaryFact(id), onSuccess: done });
  const list = facts.data?.facts ?? [];
  return (
    <section aria-label="Proposed facts">
      <h2 className="text-sm font-semibold">Learned, waiting for you</h2>
      <p className="text-xs text-[var(--ink-dim)]">Facts a session proposed. Promote one to put it in shared memory with this session as its source; reject one and it is not proposed again.</p>
      {facts.isLoading ? <p className="text-sm text-[var(--ink-dim)]">Loading…</p> : null}
      {!facts.isLoading && !list.length ? <p className="text-sm text-[var(--ink-dim)]">Nothing waiting.</p> : null}
      <ul className="mt-1 space-y-2">
        {list.map((f) => (
          <li key={f.id} className="rounded border border-[var(--rule)] p-2 text-sm">
            <div><span className="font-medium">{f.subject}</span>{f.project ? <span className="text-xs text-[var(--ink-dim)]"> · {f.project}</span> : null}</div>
            <div>{f.claim}</div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
              <button type="button" className="rounded border border-[var(--ink)] px-2 py-0.5" disabled={promote.isPending} onClick={() => promote.mutate(f.id)}>Promote</button>
              <button type="button" className="rounded border border-[var(--rule)] px-2 py-0.5" disabled={reject.isPending} onClick={() => reject.mutate(f.id)}>Reject</button>
              <Link className="text-[var(--ink-dim)] underline" to={sessionLink({ host: f.host, external_id: f.external_id, source: f.source })}>from: {f.request.slice(0, 70)}</Link>
            </div>
          </li>
        ))}
      </ul>
      {promote.error || reject.error ? <p role="alert" className="text-xs text-red-600">{String((promote.error ?? reject.error) as Error)}</p> : null}
    </section>
  );
}

export default function Summaries() {
  const [sp, setSp] = useSearchParams();
  const days = Number(sp.get('sd')) || 2;
  const outcome = (sp.get('s_outcome') ?? '').split(',').filter(Boolean);
  const harness = (sp.get('s_harness') ?? '').split(',').filter(Boolean);
  const [q, setQ] = useState(sp.get('s_q') ?? '');
  const [from, to] = useMemo(() => {
    const end = new Date(Math.ceil(Date.now() / 3600_000) * 3600_000);
    return [new Date(end.getTime() - days * 86400_000).toISOString(), end.toISOString()];
  }, [days]);
  const filters = { outcome, harness, ...(sp.get('s_q') ? { q: sp.get('s_q')! } : {}) };
  const list = useQuery({ queryKey: ['summaries', from, to, JSON.stringify(filters)], queryFn: () => api.summaries(from, to, filters) });
  const overview = useQuery({ queryKey: ['summary-overview', from, to], queryFn: () => api.summaryOverview(from, to, tz) });

  const update = (fn: (n: URLSearchParams) => void) => { const n = new URLSearchParams(sp); fn(n); setSp(n, { replace: true }); };
  const toggle = (key: string, v: string) => update((n) => {
    const cur = (n.get(key) ?? '').split(',').filter(Boolean);
    const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
    if (next.length) n.set(key, next.join(',')); else n.delete(key);
  });
  const o = overview.data;
  const finished = o?.outcomes.find((x) => x.key === 'finished')?.n ?? 0;
  const total = o?.outcomes.reduce((n, x) => n + x.n, 0) ?? 0;
  const maxTokens = Math.max(1, ...(o?.days.map((d) => Number(d.tokens)) ?? [1]));
  const harnesses = [...new Set((list.data?.summaries ?? []).map((s) => s.harness).filter((h): h is string => !!h))];

  return (
    <div className="space-y-5">
      <header>
        <h2 className="text-sm font-semibold">Summaries</h2>
        <p className="text-xs text-[var(--ink-dim)]">One record per finished agent session, any harness, any machine. The request, what was done, what was learned and what is open are written by a model; the outcome check, tokens, tool calls and files are counted from the transcript. For tokens by hour, model, provider and harness see <Link className="underline" to="/usage?group=provider">Usage</Link>.</p>
      </header>

      <section aria-label="Overview" className="grid gap-3 sm:grid-cols-2">
        <div>
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
            <span><b>{o?.summarized ?? '…'}</b> summarized</span>
            <span><b>{total ? Math.round((finished / total) * 100) : 0}%</b> finished</span>
            <span>{o?.skipped ?? 0} too short</span>
            <span>{o?.proposed_facts ?? 0} facts waiting</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-1 text-xs">{o?.outcomes.map((x) => <span key={x.key}><Chip outcome={x.key} /> {x.n}</span>)}</div>
          <div className="mt-2 text-xs text-[var(--ink-dim)]">Written by {o?.writers.length ? o.writers.map((w) => `${w.key} (${w.n}, ${formatTokens(Number(w.input) + Number(w.output))} tokens)`).join('; ') : 'nothing yet'}</div>
        </div>
        <table className="w-full text-xs">
          <thead className="text-left text-[var(--ink-dim)]"><tr><th>Day</th><th className="text-right">Sessions</th><th className="text-right">Stuck</th><th className="text-right">Errors / session</th><th>Tokens</th></tr></thead>
          <tbody>{o?.days.map((d) => (
            <tr key={d.day} className="border-t border-[var(--rule)]">
              <td>{String(d.day).slice(0, 10)}</td><td className="text-right">{d.sessions}</td><td className="text-right">{d.stuck || ''}</td>
              <td className="text-right">{Number(d.errors_per_session).toFixed(1)}</td>
              <td className="w-32"><div className="h-2 bg-[var(--ink-dim)]" style={{ width: `${Math.max(2, (Number(d.tokens) / maxTokens) * 100)}%` }} title={`${formatTokens(Number(d.tokens))} tokens`} /></td>
            </tr>
          ))}</tbody>
        </table>
      </section>

      <section aria-label="Summaries list">
        <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span role="group" aria-label="Range" className="flex gap-1">
            {RANGES.map((r) => (
              <button key={r.days} type="button" aria-pressed={days === r.days} onClick={() => update((n) => { if (r.days === 2) n.delete('sd'); else n.set('sd', String(r.days)); })}
                className={`rounded border px-1 ${days === r.days ? 'border-[var(--ink)] bg-[var(--paper-sunk)]' : 'border-[var(--rule)]'}`}>{r.label}</button>
            ))}
          </span>
          <span className="flex flex-wrap gap-1"><span className="text-[var(--ink-dim)]">outcome</span>
            {OUTCOMES.map((x) => <button key={x} type="button" aria-pressed={outcome.includes(x)} onClick={() => toggle('s_outcome', x)}
              className={`rounded border px-1 ${outcome.includes(x) ? 'border-[var(--ink)] bg-[var(--paper-sunk)]' : 'border-[var(--rule)]'}`}>{x}</button>)}
          </span>
          {harnesses.length > 1 || harness.length ? (
            <span className="flex flex-wrap gap-1"><span className="text-[var(--ink-dim)]">harness</span>
              {[...new Set([...harnesses, ...harness])].map((h) => <button key={h} type="button" aria-pressed={harness.includes(h)} onClick={() => toggle('s_harness', h)}
                className={`rounded border px-1 ${harness.includes(h) ? 'border-[var(--ink)] bg-[var(--paper-sunk)]' : 'border-[var(--rule)]'}`}>{h}</button>)}
            </span>
          ) : null}
          <form onSubmit={(e) => { e.preventDefault(); update((n) => { if (q.trim()) n.set('s_q', q.trim()); else n.delete('s_q'); }); }}>
            <input aria-label="Search summaries" className="rounded border border-[var(--rule)] bg-[var(--paper)] px-2 py-0.5" placeholder="search text" value={q} onChange={(e) => setQ(e.target.value)} />
          </form>
        </div>
        {list.isLoading ? <p className="text-sm text-[var(--ink-dim)]">Loading…</p> : null}
        {list.error ? <p role="alert" className="text-sm text-red-600">{String(list.error)}</p> : null}
        {!list.isLoading && !list.data?.summaries.length ? <p className="text-sm text-[var(--ink-dim)]">No summaries in this range. They are written after a session has been quiet for a while.</p> : null}
        {list.data?.summaries.map((s) => <Card key={s.id} s={s} />)}
      </section>

      <Facts />
    </div>
  );
}
