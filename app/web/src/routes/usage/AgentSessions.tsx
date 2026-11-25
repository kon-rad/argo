import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type AgentSessionFilters, type AgentSessionRow } from '../../lib/api.js';
import DataTable from '../../components/DataTable.js';
import { shortStamp, span, startedStamp } from '../../lib/time.js';
import { clampLine, contextLabel, formatTokens, localDateTime, personaLabel, zonedDateTime } from './format.js';

const DIMS = ['type', 'persona', 'harness', 'host', 'profile', 'provider', 'channel', 'tool'] as const;
const DIM_LABELS: Record<Dim, string> = { type: 'type', persona: 'bot persona', harness: 'harness', host: 'machine', profile: 'profile',
  provider: 'provider', channel: 'channel', tool: 'tool' };
type Dim = typeof DIMS[number];
const PAGE = 50;

/** The list's own filters live in `s_*` URL params so they don't mix with the chart filters above. */
function readFilters(sp: URLSearchParams): AgentSessionFilters {
  const f: AgentSessionFilters = {};
  for (const d of DIMS) {
    const v = sp.get(`s_${d}`);
    if (v) f[d] = v.split(',').filter(Boolean);
  }
  const q = sp.get('s_q');
  if (q) f.q = q;
  if (sp.get('s_cron') === '1') f.cron = true;
  if (sp.get('s_errors') === '1') f.errors = true;
  if (sp.get('s_sub') === '1') f.subagents = true;
  return f;
}

export function sessionLink(s: Pick<AgentSessionRow, 'host' | 'external_id' | 'source'>): string {
  return `/usage/session/${s.host}/${encodeURIComponent(s.external_id)}?source=${encodeURIComponent(s.source)}`;
}

/**
 * The Session cell: one line under 100 characters. A skill run is named after the skill and the time it started
 * ("daily-update · Nov 10 07:13"), since every day's run has the same name. Null when nothing usable was found.
 */
export function sessionName(s: Pick<AgentSessionRow, 'display_title' | 'title_source' | 'started_at'>, tz: string): string | null {
  if (!s.display_title) return null;
  const when = s.title_source === 'skill' && s.started_at ? shortStamp(s.started_at, tz) : '';
  if (!when) return clampLine(s.display_title);
  return `${clampLine(s.display_title, 99 - when.length - 3)} · ${when}`;
}

const dim = 'text-[var(--ink-faint)]';

function Row({ s, tz }: { s: AgentSessionRow; tz: string }) {
  const name = sessionName(s, tz);
  const dur = span(s.started_at, s.ended_at);
  const persona = personaLabel(s);
  const ctx = contextLabel(s);
  return (
    <tr className="border-t border-[var(--rule)] align-top">
      <td className="whitespace-nowrap tabular-nums" title={s.started_at ? `${s.started_at} (${tz})` : 'start not recorded'}>{s.started_at ? startedStamp(s.started_at, tz) : <span className={dim}>unknown</span>}</td>
      <td className="whitespace-nowrap tabular-nums" title="elapsed from the first to the last recorded step, not time spent working">{dur ?? <span className={dim}>-</span>}</td>
      <td>{s.host}</td>
      <td>{s.session_type && s.session_type !== 'unknown' ? s.session_type : <span className={dim} title="nothing recorded how this session was started">unknown</span>}
        {s.runtime_entrypoint ? <div className="text-xs text-[var(--ink-dim)]">runtime: {s.runtime_entrypoint}</div> : null}
        {s.outer_trigger ? <div className="text-xs text-[var(--ink-dim)]">trigger: {s.outer_trigger}</div> : null}</td>
      <td>{persona.known ? persona.text : <span className={dim}>{persona.text}</span>}
        {s.channel_bot && s.channel_bot !== s.persona ? <div className="text-xs text-[var(--ink-dim)]">bot {s.channel_bot}</div> : null}</td>
      <td>{s.harness}{s.profile && s.profile !== 'main' ? <span className="text-xs text-[var(--ink-dim)]"> · {s.profile}</span> : null}
        {s.channel ? <span className="ml-1 rounded border border-[var(--rule)] px-1 text-xs text-[var(--ink-dim)]" title={s.channel === 'telegram' ? 'a Telegram chat' : `via ${s.channel}`}>{s.channel}{s.channel_bot ? ` · ${s.channel_bot}` : ''}</span> : null}</td>
      <td className="max-w-[28rem] truncate max-md:order-first max-md:col-span-2" title={name ?? undefined}><Link className="underline" to={sessionLink(s)}>{name ?? <span className={dim} title="no usable title recorded">{s.external_id.slice(0, 12)}</span>}</Link>
        {s.parent_external_id ? <span className="text-xs text-[var(--ink-dim)]"> ({s.harness === 'claude-code' ? 'subagent' : 'continued'})</span> : null}</td>
      <td>{s.task_ids?.length ? s.task_ids.map((id) => <Link key={id} to={`/board/${encodeURIComponent(id)}`} className="block whitespace-nowrap text-xs underline">{id}</Link>) : <span className="text-[var(--ink-faint)]" title={s.task_unresolved_reason ?? undefined}>No verified link</span>}</td>
      <td className="text-xs">{s.models.join(', ')}{s.provider ? <div className="text-[var(--ink-dim)]">{s.provider}</div> : null}</td>
      <td className="text-right">{s.steps}</td>
      <td className="text-right">{s.tool_calls}{s.errors ? <span className="text-red-600" title="tool calls that failed"> ✗{s.errors}</span> : null}</td>
      <td className="text-right" title={`cache write ${formatTokens(s.cache_write)} · cache read ${formatTokens(s.cache_read)} · reasoning ${formatTokens(s.reasoning)}`}>
        {formatTokens(s.input)} / {formatTokens(s.output)}</td>
      <td className="whitespace-nowrap text-right" title="input + cache write + cache read + output">{formatTokens(s.input + s.cache_write + s.cache_read + s.output)}</td>
      <td className="whitespace-nowrap text-right"><details className="group relative inline-block text-left">
        <summary className="cursor-pointer list-none underline decoration-dotted underline-offset-2" aria-label={`Context info for ${name ?? s.external_id}`}>{ctx ?? <span className={dim}>not recorded</span>} <span aria-hidden="true">ⓘ</span></summary>
        <span className="absolute z-10 mt-1 max-w-64 rounded border border-[var(--rule)] bg-[var(--paper)] p-2 text-left text-xs shadow">Latest recorded main call prompt size over recorded context window. This is not the session token total. {ctx ? (s.context_at ? `Recorded at ${startedStamp(s.context_at, tz)} (${tz}).` : 'Recorded; timestamp unavailable.') : 'Context values were not recorded.'}</span>
      </details></td>
      <td className="text-right">{s.harness !== 'claude-code' && s.cost_usd != null ? `${Number(s.cost_usd).toFixed(2)} USD` : ''}</td>
      <td className="text-right">{s.subagents || ''}</td>
    </tr>
  );
}

export default function AgentSessions({ from, to, tz }: { from: string; to: string; tz: string }) {
  const [sp, setSp] = useSearchParams();
  const filters = readFilters(sp);
  const [offset, setOffset] = useState(0);
  const [q, setQ] = useState(filters.q ?? '');
  const key = JSON.stringify(filters);
  const list = useQuery({ queryKey: ['agent-sessions', from, to, key, offset], queryFn: () => api.agentSessions(from, to, filters, offset) });
  const facets = useQuery({ queryKey: ['agent-session-facets', from, to], queryFn: () => api.agentSessionFacets(from, to) });

  const update = (fn: (n: URLSearchParams) => void) => {
    const n = new URLSearchParams(sp);
    fn(n);
    setOffset(0);
    setSp(n, { replace: true });
  };
  const choose = (d: Dim, v: string) => update((n) => { if (v) n.set(`s_${d}`, v); else n.delete(`s_${d}`); });
  const flag = (name: string, on: boolean) => update((n) => { if (on) n.set(name, '1'); else n.delete(name); });
  const dateTime = (key: 'sessionFrom' | 'sessionTo', value: string) => {
    const instant = value ? zonedDateTime(value, tz) : null;
    if (value && !instant) return;
    update((n) => { if (instant) n.set(key, instant); else n.delete(key); });
  };
  const reset = () => update((n) => {
    for (const key of [...n.keys()]) if (key.startsWith('s_') || key === 'sessionFrom' || key === 'sessionTo') n.delete(key);
  });
  const total = list.data?.total ?? 0;
  const optionsFor = (d: Dim) => {
    const visible = [...(facets.data?.facets[d] ?? [])];
    // Every active URL filter remains removable, including values absent from this range's facets.
    for (const value of filters[d] ?? []) {
      if (!visible.some(f => f.value === value)) visible.push({ value, n: 0 });
    }
    return visible;
  };

  return (
    <section>
      <h2 className="text-sm font-semibold">Sessions</h2>
      <p className="text-xs text-[var(--ink-dim)]">Every Claude Code, Codex, Hermes and zen-agent session on every machine, Telegram chats included (filter by type or bot persona). Times are {tz}. Open one to read its prompts, thinking, tool calls and responses.</p>
      <div className="my-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <label className="flex items-center gap-1">From <input aria-label="Sessions from" type="datetime-local" className="rounded border border-[var(--rule)] bg-[var(--paper)] px-1 py-0.5" value={localDateTime(sp.get('sessionFrom') ?? from, tz)} onChange={(e) => dateTime('sessionFrom', e.target.value)} /></label>
        <label className="flex items-center gap-1">To <input aria-label="Sessions to" type="datetime-local" className="rounded border border-[var(--rule)] bg-[var(--paper)] px-1 py-0.5" value={localDateTime(sp.get('sessionTo') ?? to, tz)} onChange={(e) => dateTime('sessionTo', e.target.value)} /></label>
        <form onSubmit={(e) => { e.preventDefault(); update((n) => { if (q.trim()) n.set('s_q', q.trim()); else n.delete('s_q'); }); }}>
          <input aria-label="Search sessions" className="rounded border border-[var(--rule)] bg-[var(--paper)] px-2 py-0.5" placeholder="search text or session ID"
            value={q} onChange={(e) => setQ(e.target.value)} />
        </form>
        {DIMS.map((d) => (facets.data?.facets[d]?.length ?? 0) > (d === 'persona' ? 0 : 1) || filters[d]?.length ? (
          <label key={d} className="flex items-center gap-1">{DIM_LABELS[d]}
            <select aria-label={`Filter by ${DIM_LABELS[d]}`} className="max-w-48 rounded border border-[var(--rule)] bg-[var(--paper)] px-1 py-0.5" value={filters[d]?.[0] ?? ''} onChange={(e) => choose(d, e.target.value)}>
              <option value="">All</option>{optionsFor(d).map((f) => <option key={f.value} value={f.value}>{f.value} ({f.n})</option>)}
            </select>
          </label>
        ) : null)}
        <label className="flex items-center gap-1"><input type="checkbox" checked={!!filters.cron} onChange={(e) => flag('s_cron', e.target.checked)} />cron jobs</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={!!filters.errors} onChange={(e) => flag('s_errors', e.target.checked)} />with errors</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={!!filters.subagents} onChange={(e) => flag('s_sub', e.target.checked)} />subagents as rows</label>
        <button type="button" className="underline" onClick={reset}>Reset filters</button>
      </div>
      <DataTable label="Sessions" phone="cards" className="w-full text-sm">
        <thead className="text-left text-xs text-[var(--ink-dim)]"><tr>
          <th title={`YYYYMMDD HH:mm, ${tz}`}>Started</th><th>Duration</th><th>Machine</th><th>Type</th><th>Bot persona</th><th>Agent</th><th>Session</th><th>Ticket</th><th>Model</th><th className="text-right">Steps</th>
          <th className="text-right">Tool calls</th><th className="text-right" title="summed over every call">Tokens in / out</th><th className="text-right" title="input + cache write + cache read + output">Total</th><th className="text-right">Context</th><th className="text-right">USD (Hermes)</th><th className="text-right">Subagents</th>
        </tr></thead>
        <tbody>
          {(list.data?.sessions ?? []).map((s) => <Row key={s.id} s={s} tz={tz} />)}
          {list.data && total === 0 && <tr><td colSpan={16} className="py-2 text-xs text-[var(--ink-faint)]">No sessions in this range.</td></tr>}
        </tbody>
      </DataTable>
      {list.isError && <p className="text-xs text-red-600">Could not load sessions: {(list.error as Error).message}</p>}
      {total > 0 && (
        <div className="mt-1 flex items-center gap-2 text-xs">
          <button type="button" className="underline disabled:opacity-40" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</button>
          <span>{offset + 1} to {Math.min(offset + PAGE, total)} of {total}</span>
          <button type="button" className="underline disabled:opacity-40" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>Next</button>
        </div>
      )}
    </section>
  );
}
