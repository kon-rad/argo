import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import {
  api, USAGE_DIMENSION_LABELS, USAGE_DIMENSIONS,
  type CreditProvider, type PlanCurrent, type UsageCredits, type UsageDimension, type UsageFacets, type UsageFilters, type UsageRun, type UsageSeriesRow,
} from '../../lib/api.js';
import LineChart from '../../components/charts/LineChart.js';
import StackedBars, { type BarSeries } from '../../components/charts/StackedBars.js';
import { bucketEnd, formatTokens, money, planText, TYPE_SERIES } from './format.js';
import { zoned } from '../../lib/time.js';

const RANGES = [{ label: '24 h', days: 1 }, { label: '7 d', days: 7 }, { label: '30 d', days: 30 }, { label: '90 d', days: 90 }];
const GROUP_COLORS = ['var(--chart-bar)', 'var(--ink)', '#c2410c', '#15803d', '#7c3aed', '#0e7490', '#b45309', '#be123c', '#4d7c0f', '#6d28d9'];
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
type Group = 'type' | UsageDimension;
const GROUPS: Group[] = ['type', ...USAGE_DIMENSIONS];

function PlanCard({ title, plan }: { title: string; plan: PlanCurrent | null }) {
  const t = planText(plan);
  const used = plan?.used_pct ?? null;
  return (
    <div className="rounded border border-[var(--rule)] p-3">
      <div className="text-xs text-[var(--ink-dim)]">{title}</div>
      <div className="text-2xl font-semibold">{t.main}</div>
      {used !== null && (
        <div className="my-1 h-2 rounded bg-[var(--paper-sunk)]">
          <div className="h-2 rounded bg-[var(--chart-bar)]" style={{ width: `${Math.min(100, used)}%` }} />
        </div>
      )}
      <div className="text-xs text-[var(--ink-dim)]">{t.sub}</div>
    </div>
  );
}

const PROVIDER_NAMES: Record<CreditProvider, string> = { openrouter: 'OpenRouter', fal: 'fal.ai', gemini: 'Gemini API' };
const CREDIT_HINTS: Record<CreditProvider, string> = {
  openrouter: 'From the OpenRouter credits API every 15 min.',
  fal: 'From the fal billing API every 15 min (needs FAL_BILLING_KEY, a Billing or Read-only key).',
  gemini: 'Google has no balance API. Copy it from AI Studio, then: secondbrain credits set gemini <balance>',
};

function CreditCard({ entry, history }: { entry: UsageCredits['providers'][number]; history: UsageCredits['history'] }) {
  const ok = entry.last_ok;
  const failed = entry.latest && entry.latest.status !== 'ok' ? entry.latest : null;
  const mine = history.filter((h) => h.provider === entry.provider && h.currency === ok?.currency);
  const first = mine[0];
  const change = ok && first && first.observed_at !== mine[mine.length - 1]?.observed_at ? ok.balance! - first.balance : null;
  return (
    <div className="rounded border border-[var(--rule)] p-3">
      <div className="text-xs text-[var(--ink-dim)]">{PROVIDER_NAMES[entry.provider]} credits</div>
      <div className="text-2xl font-semibold">{ok ? `${money(ok.balance, ok.currency)} left` : 'No reading yet'}</div>
      {ok && ok.total_credits !== null && (
        <div className="text-xs text-[var(--ink-dim)]">{money(ok.total_usage, ok.currency)} used of {money(ok.total_credits, ok.currency)} bought</div>
      )}
      {change !== null && (
        <div className="text-xs text-[var(--ink-dim)]">{change <= 0 ? `${money(-change, ok!.currency)} spent` : `${money(change, ok!.currency)} added`} since {new Date(first!.observed_at).toLocaleDateString()}</div>
      )}
      {ok && (
        <div className="text-xs text-[var(--ink-dim)]">as of {new Date(ok.observed_at).toLocaleString()} ({ok.origin === 'manual' ? 'entered by hand' : 'API'}){ok.note ? `, ${ok.note}` : ''}</div>
      )}
      {failed && <div className="text-xs text-red-600">Latest reading: {failed.status}, {failed.error}</div>}
      {(!ok || entry.provider === 'gemini') && <div className="mt-1 text-xs text-[var(--ink-faint)]">{CREDIT_HINTS[entry.provider]}</div>}
    </div>
  );
}

function toSeries(rows: UsageSeriesRow[], group: string): { buckets: string[]; series: BarSeries[] } {
  const buckets = [...new Set(rows.map((r) => r.bucket))].sort();
  const index = new Map(buckets.map((b, i) => [b, i]));
  if (group === 'type') {
    return { buckets, series: TYPE_SERIES.map((s) => {
      const values = buckets.map(() => 0);
      for (const r of rows) {
        const i = index.get(r.bucket)!;
        values[i] = (values[i] ?? 0) + Number(r[s.key]);
      }
      return { key: s.key, label: s.label, color: s.color, values };
    }) };
  }
  const totals = new Map<string, number>();
  for (const r of rows) totals.set(r.key, (totals.get(r.key) ?? 0) + Number(r.input) + Number(r.cache_write) + Number(r.cache_read) + Number(r.output));
  const keys = [...totals.keys()].sort((a, b) => totals.get(b)! - totals.get(a)!);
  return { buckets, series: keys.map((k, i) => {
    const values = buckets.map(() => 0);
    for (const r of rows) {
      if (r.key !== k) continue;
      const j = index.get(r.bucket)!;
      values[j] = (values[j] ?? 0) + Number(r.input) + Number(r.cache_write) + Number(r.cache_read) + Number(r.output);
    }
    return { key: k, label: k, color: GROUP_COLORS[i % GROUP_COLORS.length]!, values };
  }) };
}

/** Filters live in the URL (`?agent=atlas,rune&action=post`), so a view can be linked, shared and put on the kiosk. */
function readFilters(sp: URLSearchParams): UsageFilters {
  const f: UsageFilters = {};
  for (const d of USAGE_DIMENSIONS) {
    const v = sp.get(d);
    if (v) f[d] = v.split(',').filter(Boolean);
  }
  return f;
}

function isGroup(v: string | null): v is Group {
  return v !== null && (GROUPS as string[]).includes(v);
}

/** Lets a cell add its value as a filter. */
function Pick({ dim, value, children, onPick }: { dim: UsageDimension; value: string | null | undefined; children?: React.ReactNode; onPick: (d: UsageDimension, v: string) => void }) {
  if (!value) return <>{children ?? ''}</>;
  return (
    <button type="button" className="text-left hover:underline" title={`Filter ${USAGE_DIMENSION_LABELS[dim]} = ${value}`} onClick={() => onPick(dim, value)}>
      {children ?? value}
    </button>
  );
}

function FilterBar({ filters, facets, onAdd, onRemove, onClear }: {
  filters: UsageFilters; facets: UsageFacets | undefined;
  onAdd: (d: UsageDimension, v: string) => void; onRemove: (d: UsageDimension, v: string) => void; onClear: () => void;
}) {
  const [dim, setDim] = useState<UsageDimension | ''>('');
  const chips = USAGE_DIMENSIONS.flatMap((d) => (filters[d] ?? []).map((v) => ({ d, v })));
  const values = dim ? (facets?.facets?.[dim] ?? []).filter((x) => !(filters[dim] ?? []).includes(x.value)) : [];
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" aria-label="Filters">
      <span className="text-xs text-[var(--ink-dim)]">Filter</span>
      {chips.map(({ d, v }) => (
        <span key={`${d}=${v}`} className="inline-flex items-center gap-1 rounded-full border border-[var(--rule)] bg-[var(--paper-sunk)] px-2 py-0.5 text-xs">
          <span className="text-[var(--ink-dim)]">{USAGE_DIMENSION_LABELS[d]}</span> {v}
          <button type="button" aria-label={`Remove filter ${USAGE_DIMENSION_LABELS[d]} ${v}`} className="ml-1 text-[var(--ink-dim)] hover:text-[var(--ink)]" onClick={() => onRemove(d, v)}>×</button>
        </span>
      ))}
      <select aria-label="Add filter" value={dim} onChange={(e) => setDim(e.target.value as UsageDimension | '')} className="rounded border border-[var(--rule)] bg-transparent px-1 py-0.5 text-xs">
        <option value="">add filter…</option>
        {USAGE_DIMENSIONS.map((d) => <option key={d} value={d}>{USAGE_DIMENSION_LABELS[d]}</option>)}
      </select>
      {dim && (
        <select aria-label={`${USAGE_DIMENSION_LABELS[dim]} value`} value="" onChange={(e) => { if (e.target.value) { onAdd(dim, e.target.value); setDim(''); } }}
          className="max-w-[16rem] rounded border border-[var(--rule)] bg-transparent px-1 py-0.5 text-xs">
          <option value="">{values.length ? `${USAGE_DIMENSION_LABELS[dim]}…` : 'nothing in range'}</option>
          {values.map((x) => <option key={x.value} value={x.value}>{x.value} ({formatTokens(x.tokens)})</option>)}
        </select>
      )}
      {chips.length > 0 && <button type="button" className="text-xs text-[var(--ink-dim)] underline" onClick={onClear}>clear</button>}
    </div>
  );
}

function who(r: UsageRun): { dim: UsageDimension; value: string } | null {
  if (r.agent_name) return { dim: 'agent', value: r.agent_name };
  if (r.lane) return { dim: 'lane', value: r.lane };
  return null;
}

export default function Usage() {
  const [sp, setSp] = useSearchParams();
  const days = Number(sp.get('days')) || 1;
  const group: Group = isGroup(sp.get('group')) ? (sp.get('group') as Group) : 'type';
  const hourly = sp.get('bucket') !== 'day';
  const filters = useMemo(() => readFilters(sp), [sp]);
  const [selected, setSelected] = useState<number | null>(null);
  const bucket: 'hour' | 'day' = hourly && days <= 31 ? 'hour' : 'day';
  const [from, to] = useMemo(() => {
    const end = new Date(Math.ceil(Date.now() / 3600_000) * 3600_000);
    return [new Date(end.getTime() - days * 86400_000).toISOString(), end.toISOString()];
  }, [days]);

  const update = (fn: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(sp);
    fn(next);
    setSelected(null);
    setSp(next, { replace: true });
  };
  const setDays = (d: number) => update((n) => { if (d === 1) n.delete('days'); else n.set('days', String(d)); });
  const setGroup = (g: Group) => update((n) => { if (g === 'type') n.delete('group'); else n.set('group', g); });
  const setHourly = (h: boolean) => update((n) => { if (h) n.delete('bucket'); else n.set('bucket', 'day'); });
  const addFilter = (d: UsageDimension, v: string) => update((n) => {
    const cur = (n.get(d) ?? '').split(',').filter(Boolean);
    if (!cur.includes(v)) cur.push(v);
    n.set(d, cur.join(','));
  });
  const removeFilter = (d: UsageDimension, v: string) => update((n) => {
    const cur = (n.get(d) ?? '').split(',').filter((x) => x && x !== v);
    if (cur.length) n.set(d, cur.join(',')); else n.delete(d);
  });
  const clearFilters = () => update((n) => { for (const d of USAGE_DIMENSIONS) n.delete(d); });
  const filterKey = JSON.stringify(filters);

  const plan = useQuery({ queryKey: ['usage-plan', from, to], queryFn: () => api.usagePlan(from, to), refetchInterval: 60_000 });
  const credits = useQuery({ queryKey: ['usage-credits'], queryFn: () => api.usageCredits(), refetchInterval: 300_000 });
  const series = useQuery({ queryKey: ['usage-series', from, to, bucket, group, filterKey], queryFn: () => api.usageSeries({ from, to, bucket, tz, group }, filters) });
  const { buckets, series: bars } = useMemo(() => toSeries(series.data?.rows ?? [], group), [series.data, group]);
  const sel = selected !== null && buckets[selected] ? buckets[selected]! : null;
  const selFrom = sel ?? from;
  const selTo = sel ? bucketEnd(sel, bucket, tz) : to;
  const facets = useQuery({ queryKey: ['usage-facets', selFrom, selTo, filterKey], queryFn: () => api.usageFacets(selFrom, selTo, filters) });
  const sessions = useQuery({ queryKey: ['usage-sessions', selFrom, selTo, filterKey], queryFn: () => api.usageSessions(selFrom, selTo, filters) });
  const runs = useQuery({ queryKey: ['usage-runs', selFrom, selTo, filterKey], queryFn: () => api.usageRuns(selFrom, selTo, filters) });
  const orgWakes = useQuery({ queryKey: ['usage-org-wakes', selFrom, selTo], queryFn: () => api.usageOrgWakes(selFrom, selTo) });
  const fmtBucket = (b: string) => new Date(b).toLocaleString([], bucket === 'hour'
    ? { month: 'short', day: 'numeric', hour: '2-digit' } : { month: 'short', day: 'numeric' });
  const history = plan.data?.history ?? [];
  const breakdown = group !== 'type' ? (facets.data?.facets?.[group] ?? []) : [];
  const total = facets.data?.total?.tokens ?? 0;
  const tokensOf = (r: UsageRun) => (r.calls == null ? null : Number(r.input ?? 0) + Number(r.cache_write ?? 0) + Number(r.cache_read ?? 0) + Number(r.output ?? 0));

  return (
    <div className="h-full overflow-auto p-4 space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <PlanCard title="Claude plan, 5-hour window" plan={plan.data?.current.five_hour ?? null} />
        <PlanCard title="Claude plan, 7-day window" plan={plan.data?.current.seven_day ?? null} />
      </div>

      <section>
        <h2 className="text-sm font-semibold">API credits</h2>
        <div className="mt-1 grid gap-3 sm:grid-cols-3">
          {(credits.data?.providers ?? []).map((c) => <CreditCard key={c.provider} entry={c} history={credits.data!.history} />)}
          {credits.isError && <div className="text-sm text-red-600">Credits did not load.</div>}
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        {RANGES.map((r) => (
          <button key={r.label} type="button" onClick={() => setDays(r.days)}
            className={`rounded px-2 py-1 ${days === r.days ? 'bg-[var(--paper-sunk)] text-[var(--ink)]' : 'text-[var(--ink-dim)]'}`}>{r.label}</button>
        ))}
        <label className="ml-3">
          <input type="checkbox" checked={bucket === 'hour'} disabled={days > 31} onChange={(e) => setHourly(e.target.checked)} /> per hour
        </label>
        <select aria-label="Group by" value={group} onChange={(e) => setGroup(e.target.value as Group)} className="ml-3 rounded border border-[var(--rule)] bg-transparent px-1">
          <option value="type">by token type</option>
          {USAGE_DIMENSIONS.map((d) => <option key={d} value={d}>by {USAGE_DIMENSION_LABELS[d]}</option>)}
        </select>
        <span className="ml-auto text-xs text-[var(--ink-dim)]">time zone {tz}</span>
      </div>

      <FilterBar filters={filters} facets={facets.data} onAdd={addFilter} onRemove={removeFilter} onClear={clearFilters} />

      <section>
        <StackedBars buckets={buckets} series={bars} selected={selected} onSelect={(i) => setSelected(selected === i ? null : i)}
          formatBucket={fmtBucket} formatValue={formatTokens} />
        <div className="flex flex-wrap gap-3 text-xs text-[var(--ink-dim)]">
          {bars.map((s) => (
            group === 'type' || s.key === 'unlabelled'
              ? <span key={s.key}><span className="inline-block h-2 w-2" style={{ background: s.color }} /> {s.label}</span>
              : <button key={s.key} type="button" className="hover:underline" onClick={() => addFilter(group, s.key)}><span className="inline-block h-2 w-2" style={{ background: s.color }} /> {s.label}</button>
          ))}
          {sel && <span>Showing {fmtBucket(sel)}. Click the bar again to clear.</span>}
        </div>
      </section>

      {group !== 'type' && (
        <section>
          <h2 className="text-sm font-semibold">Tokens by {USAGE_DIMENSION_LABELS[group]}</h2>
          <p className="text-xs text-[var(--ink-dim)]">{formatTokens(total)} tokens in {facets.data?.total?.calls ?? 0} calls{sel ? ` in ${fmtBucket(sel)}` : ''}. Click a row to filter on it.</p>
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead className="text-left text-xs text-[var(--ink-dim)]"><tr>
              <th>{USAGE_DIMENSION_LABELS[group]}</th><th className="text-right">Calls</th><th className="text-right">Tokens</th><th className="text-right">Share</th>
              <th className="text-right">Output</th><th className="text-right">Per call</th>
            </tr></thead>
            <tbody>
              {breakdown.map((x) => (
                <tr key={x.value} className="border-t border-[var(--rule)]">
                  <td><Pick dim={group} value={x.value === 'unlabelled' ? null : x.value} onPick={addFilter}>{x.value}</Pick></td>
                  <td className="text-right">{x.calls}</td>
                  <td className="text-right">{formatTokens(x.tokens)}</td>
                  <td className="text-right">{total ? `${Math.round((x.tokens / total) * 100)}%` : ''}</td>
                  <td className="text-right">{formatTokens(x.output)}</td>
                  <td className="text-right">{x.calls ? formatTokens(x.tokens / x.calls) : ''}</td>
                </tr>
              ))}
              {breakdown.length === 0 && <tr><td colSpan={6} className="py-2 text-xs text-[var(--ink-faint)]">Nothing in this range.</td></tr>}
            </tbody>
          </table></div>
        </section>
      )}

      <section>
        <h2 className="text-sm font-semibold">Plan used over time (%)</h2>
        <LineChart label="Plan usage" yMax={100} xMin={Date.parse(from)} xMax={Date.parse(to)} lines={[
          { key: '5h', color: 'var(--chart-line)', points: history.filter((h) => h.window === 'five_hour').map((h) => ({ x: Date.parse(h.observed_at), y: h.used_pct })) },
          { key: '7d', color: 'var(--ink)', points: history.filter((h) => h.window === 'seven_day').map((h) => ({ x: Date.parse(h.observed_at), y: h.used_pct })) },
        ]} />
      </section>

      <section>
        <h2 className="text-sm font-semibold">Runs (bots and lanes)</h2>
        <p className="text-xs text-[var(--ink-dim)]">One row per <code>claude -p</code> run. Click a bot, reason, project or work type to filter on it.</p>
        <div className="overflow-x-auto"><table className="w-full text-sm">
          <thead className="text-left text-xs text-[var(--ink-dim)]"><tr>
            <th>When</th><th>Who</th><th>Woken by</th><th>Card</th><th>Project</th><th>Work</th>
            <th className="text-right">Tokens</th><th className="text-right">Output</th><th className="text-right">Turns</th><th className="text-right">Min</th><th>Verify</th>
          </tr></thead>
          <tbody>
            {(runs.data?.runs ?? []).map((r) => {
              const w = who(r);
              const t = tokensOf(r);
              return (
                <tr key={`${r.host}|${r.run_id ?? r.session_id}`} className="border-t border-[var(--rule)]">
                  <td><Link className="underline" to={`/usage/session/${r.host}/${encodeURIComponent(r.session_id)}?source=claude-code`}>{r.started_at ? zoned(r.started_at, tz) : (r.run_id ?? r.session_id.slice(0, 8))}</Link></td>
                  <td>{w ? <Pick dim={w.dim} value={w.value} onPick={addFilter}>{r.agent_name ? <Link className="underline" to={`/org/agents/${r.agent_name}`} onClick={(e) => e.stopPropagation()}>{r.agent_name}</Link> : r.lane}</Pick> : ''}{r.resumed ? <span className="text-xs text-[var(--ink-faint)]" title="resumed its session"> ↻</span> : null}</td>
                  <td><Pick dim="reason" value={r.reason} onPick={addFilter} /></td>
                  <td>{r.task_id ? <Link className="underline" to={`/agents/board/${r.task_id}`} title={r.card_title ?? ''}>{r.task_id}</Link> : ''}</td>
                  <td><Pick dim="project" value={r.project_slug} onPick={addFilter}>{r.project_slug}{r.feature_slug ? `/${r.feature_slug}` : ''}</Pick></td>
                  <td><Pick dim="work_type" value={r.work_type} onPick={addFilter} /></td>
                  <td className="text-right">{t === null ? '' : formatTokens(t)}</td>
                  <td className="text-right">{r.output == null ? '' : formatTokens(Number(r.output))}</td>
                  <td className="text-right">{r.num_turns ?? ''}</td>
                  <td className="text-right">{r.duration_ms === null ? '' : (r.duration_ms / 60000).toFixed(1)}</td>
                  <td title={r.verify_output ?? ''}>{r.verify_name === null ? '' : `${r.verify_passed ? 'passed' : 'failed'} ${r.verify_name}${r.verify_metric === null ? '' : ` (${r.verify_metric})`}`}</td>
                </tr>
              );
            })}
            {runs.data?.runs?.length === 0 && <tr><td colSpan={11} className="py-2 text-xs text-[var(--ink-faint)]">No runs in this range.</td></tr>}
          </tbody>
        </table></div>
      </section>

      <section>
        <h2 className="text-sm font-semibold">Sessions</h2>
        <div className="overflow-x-auto"><table className="w-full text-sm">
          <thead className="text-left text-xs text-[var(--ink-dim)]"><tr>
            <th>Session</th><th>Surface</th><th>Who</th><th>Project</th><th>Task</th><th className="text-right">Calls</th><th className="text-right">Input</th>
            <th className="text-right">Cache write</th><th className="text-right">Cache read</th><th className="text-right">Output</th><th className="text-right">USD (Hermes)</th>
          </tr></thead>
          <tbody>
            {(sessions.data?.sessions ?? []).map((s) => (
              <tr key={`${s.source}|${s.host}|${s.external_id}`} className="border-t border-[var(--rule)]">
                <td><Link className="underline" to={`/usage/session/${s.host}/${encodeURIComponent(s.external_id)}?source=${s.source}`}>
                  {s.title ?? s.external_id.slice(0, 12)}</Link></td>
                <td><Pick dim="surface" value={s.surface} onPick={addFilter} /></td>
                <td><Pick dim="agent" value={s.agent_name} onPick={addFilter} /></td>
                <td><Pick dim="project" value={s.project_slug} onPick={addFilter} /></td>
                <td>{s.task_id ? `${s.task_id} (${s.lane ?? s.agent_name ?? '?'})` : ''}</td>
                <td className="text-right">{s.calls}</td>
                <td className="text-right">{formatTokens(Number(s.input))}</td>
                <td className="text-right">{formatTokens(Number(s.cache_write))}</td>
                <td className="text-right">{formatTokens(Number(s.cache_read))}</td>
                <td className="text-right">{formatTokens(Number(s.output))}</td>
                <td className="text-right">{s.cost_usd === null ? '' : `$${Number(s.cost_usd).toFixed(2)}`}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </section>

      <section>
        <h2 className="text-sm font-semibold">Agent wakes (the company board)</h2>
        <p className="text-xs text-[var(--ink-dim)]">Each wake is one <code>claude -p</code> run against the shared daily cap. Open = waiting or running. Tokens are the bot's calls in this range.</p>
        <div className="overflow-x-auto"><table className="w-full text-sm">
          <thead className="text-left text-xs text-[var(--ink-dim)]"><tr>
            <th>Agent</th><th>Team</th><th className="text-right">Wakes</th><th className="text-right">Done</th><th className="text-right">Open</th>
            <th className="text-right">Routine</th><th className="text-right">DM</th><th className="text-right">Mention</th><th className="text-right">Card</th>
            <th className="text-right">Tokens</th><th className="text-right">Avg min</th><th>Last</th>
          </tr></thead>
          <tbody>
            {(orgWakes.data?.agents ?? []).map((a) => (
              <tr key={a.agent_name} className="border-t border-[var(--rule)]">
                <td><Link className="underline" to={`/org/agents/${a.agent_name}`}>{a.agent_name}</Link> <span className="text-xs text-[var(--ink-dim)]">{a.role}</span>
                  {' '}<button type="button" className="text-xs text-[var(--ink-dim)] hover:underline" onClick={() => addFilter('agent', a.agent_name)}>filter</button></td>
                <td>{a.team_slug ?? ''}</td>
                <td className="text-right">{a.wakes}</td><td className="text-right">{a.done}</td><td className="text-right">{a.open}</td>
                <td className="text-right">{a.routine}</td><td className="text-right">{a.dm ?? ''}</td><td className="text-right">{a.mention ?? ''}</td><td className="text-right">{a.task ?? ''}</td>
                <td className="text-right">{a.tokens == null ? '' : formatTokens(Number(a.tokens))}</td>
                <td className="text-right">{a.avg_minutes ?? ''}</td>
                <td>{a.last_wake ? zoned(a.last_wake, tz) : ''}</td>
              </tr>
            ))}
            {orgWakes.data?.agents?.length === 0 && (
              <tr><td colSpan={12} className="py-2 text-xs text-[var(--ink-faint)]">No wakes in this range.</td></tr>
            )}
          </tbody>
        </table></div>
      </section>
    </div>
  );
}
