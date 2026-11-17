import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { bytes, dataApi, type DataPanel, type DataQueryResult } from '../lib/dataApi.js';
import { ago, zoned } from '../lib/time.js';

/**
 * /data: every table, connector, scheduled job and dashboard (docs/data.md).
 * The vault owns its tables and connectors; this page only shows them.
 */

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'tables', label: 'Tables' },
  { key: 'connectors', label: 'Connectors' },
  { key: 'jobs', label: 'Jobs' },
  { key: 'dashboards', label: 'Dashboards' },
] as const;
type Tab = (typeof TABS)[number]['key'];

const fmt = (n: number) => n.toLocaleString();

export default function Data() {
  const { tab = 'overview' } = useParams();
  const active = (TABS.some((t) => t.key === tab) ? tab : 'overview') as Tab;
  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-6">
      <h1 className="text-lg font-semibold tracking-tight">Data</h1>
      <nav className="mt-3 flex flex-wrap gap-1 border-b border-[var(--rule)] text-sm">
        {TABS.map((t) => (
          <Link key={t.key} to={t.key === 'overview' ? '/data' : `/data/${t.key}`}
            className={`-mb-px border-b-2 px-3 py-1.5 ${active === t.key ? 'border-[var(--accent)] font-medium' : 'border-transparent text-[var(--ink-dim)]'}`}>
            {t.label}
          </Link>
        ))}
      </nav>
      <div className="mt-4">
        {active === 'overview' && <Overview />}
        {active === 'tables' && <Tables />}
        {active === 'connectors' && <Connectors />}
        {active === 'jobs' && <Jobs />}
        {active === 'dashboards' && <Dashboards />}
      </div>
    </div>
  );
}

function Status({ q }: { q: { isLoading: boolean; error: unknown } }) {
  if (q.isLoading) return <p className="text-sm text-[var(--ink-dim)]">Loading…</p>;
  if (q.error) return <p className="text-sm text-red-600">{(q.error as Error).message}</p>;
  return null;
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded border border-[var(--rule)] p-3">
      <div className="text-xs text-[var(--ink-dim)]">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-[var(--ink-dim)]">{sub}</div>}
    </div>
  );
}

function Overview() {
  const q = useQuery({ queryKey: ['data-overview'], queryFn: dataApi.overview });
  if (!q.data) return <Status q={q} />;
  const o = q.data;
  const c = o.connectors;
  return (
    <div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Database" value={bytes(o.dbBytes)} />
        <Stat label="Your data (schema data)" value={bytes(o.dataBytes)} sub={`${o.dataTables} tables`} />
        <Stat label="Connectors" value={`${c.ok}/${c.total} ok`} sub={[c.failing && `${c.failing} failing`, c.never && `${c.never} never run`, c.broken && `${c.broken} broken`].filter(Boolean).join(', ') || undefined} />
        <Stat label="Next run" value={o.nextDue ? zoned(o.nextDue) : 'none scheduled'} />
      </div>
      <p className="mt-4 text-xs text-[var(--ink-dim)]">Data folder: <code>{o.dataDir}</code></p>
    </div>
  );
}

function Tables() {
  const q = useQuery({ queryKey: ['data-tables'], queryFn: dataApi.tables });
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  if (!q.data) return <Status q={q} />;
  const rows = q.data.tables.filter((t) => all || t.schema === 'data');
  return (
    <div>
      <label className="mb-2 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show engine tables too ({q.data.tables.length})
      </label>
      {rows.length === 0 && <p className="text-sm text-[var(--ink-dim)]">No tables in schema data yet. Add a migration and run <code>secondbrain data migrate</code>.</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-[var(--ink-dim)]">
            <tr><th className="py-1 pr-3">Table</th><th className="pr-3 text-right">Rows</th><th className="pr-3 text-right">Size</th><th>Owner</th></tr>
          </thead>
          <tbody>
            {rows.map((t) => {
              const id = `${t.schema}.${t.name}`;
              return (
                <tr key={id} className="border-t border-[var(--rule)] align-top">
                  <td className="py-1 pr-3">
                    <button className="text-left font-mono text-xs hover:underline" onClick={() => setOpen(open === id ? null : id)}>{id}</button>
                    {open === id && <TableDetail schema={t.schema} name={t.name} />}
                  </td>
                  <td className="pr-3 text-right tabular-nums">{t.rowsEstimated ? '~' : ''}{fmt(t.rows)}</td>
                  <td className="pr-3 text-right tabular-nums">{bytes(t.bytes)}</td>
                  <td className="text-xs text-[var(--ink-dim)]">{t.owner ?? ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TableDetail({ schema, name }: { schema: string; name: string }) {
  const q = useQuery({ queryKey: ['data-table', schema, name], queryFn: () => dataApi.table(schema, name) });
  if (!q.data) return <Status q={q} />;
  return (
    <div className="my-2 max-w-[90vw] md:max-w-3xl">
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {q.data.columns.map((c) => (
          <span key={c.name} className="font-mono">{c.key ? '🔑 ' : ''}{c.name} <span className="text-[var(--ink-dim)]">{c.type}{c.nullable ? '' : ' not null'}</span></span>
        ))}
      </div>
      {q.data.latest && <div className="mt-2"><ResultTable r={q.data.latest} /></div>}
    </div>
  );
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function ResultTable({ r }: { r: DataQueryResult }) {
  return (
    <div className="max-h-96 overflow-auto rounded border border-[var(--rule)]">
      <table className="text-xs">
        <thead className="sticky top-0 bg-[var(--paper,white)]"><tr>{r.columns.map((c) => <th key={c} className="px-2 py-1 text-left font-medium">{c}</th>)}</tr></thead>
        <tbody>
          {r.rows.map((row, i) => (
            <tr key={i} className="border-t border-[var(--rule)]">
              {row.map((v, j) => <td key={j} className="max-w-xs truncate px-2 py-1 font-mono" title={cellText(v)}>{cellText(v)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {r.truncated && <p className="px-2 py-1 text-xs text-[var(--ink-dim)]">First {r.row_count} rows.</p>}
    </div>
  );
}

function Connectors() {
  const q = useQuery({ queryKey: ['data-connectors'], queryFn: dataApi.connectors });
  if (!q.data) return <Status q={q} />;
  const { connectors, errors } = q.data;
  return (
    <div className="space-y-4">
      {connectors.length === 0 && errors.length === 0 && (
        <p className="text-sm text-[var(--ink-dim)]">No connectors yet. An agent adds one with the <code>data-connector</code> skill.</p>
      )}
      {connectors.map((c) => {
        const last = c.lastRuns[0];
        return (
          <section key={c.name} className="rounded border border-[var(--rule)] p-3">
            <div className="flex flex-wrap items-baseline gap-x-3">
              <h2 className="font-medium">{c.name}</h2>
              <span className="text-xs text-[var(--ink-dim)]">
                {!c.enabled ? 'disabled' : c.schedule ? `every ${c.schedule.every}${c.schedule.at ? ` at ${c.schedule.at} UTC` : ''}` : 'manual'}
                {c.nextDue && ` · next ${zoned(c.nextDue)}`}
              </span>
              {last && <span className={`text-xs ${last.status === 'ok' ? 'text-green-700' : last.status === 'failed' ? 'text-red-600' : ''}`}>{last.status} {ago(last.startedAt)}</span>}
            </div>
            {c.description && <p className="mt-1 text-sm">{c.description}</p>}
            <p className="mt-1 text-xs text-[var(--ink-dim)]">Writes {c.tables.map((t) => `data.${t}`).join(', ') || 'nothing'} · run now: <code>{c.runCommand}</code></p>
            {c.missingEnv.length > 0 && <p className="mt-1 text-xs text-red-600">Missing keys on this server: {c.missingEnv.join(', ')}</p>}
            {c.lastRuns.length > 0 && (
              <div className="mt-2 overflow-x-auto">
                <table className="text-xs">
                  <tbody>
                    {c.lastRuns.map((r) => (
                      <tr key={r.id} className="border-t border-[var(--rule)] align-top">
                        <td className="py-1 pr-3 whitespace-nowrap">{zoned(r.startedAt)}</td>
                        <td className="pr-3">{r.status}{r.args.length ? ` (${r.args.join(' ')})` : ''}</td>
                        <td className="pr-3 font-mono">{Object.entries(r.rows).map(([t, n]) => `${t} ${fmt(n)}`).join(', ')}</td>
                        <td className="max-w-md break-words text-red-600">{r.error?.split('\n')[0]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}
      {errors.map((e) => (
        <section key={e.name} className="rounded border border-red-300 p-3 text-sm">
          <h2 className="font-medium">{e.name}</h2>
          <p className="text-red-600">connector.json is broken: {e.error}</p>
        </section>
      ))}
    </div>
  );
}

function Jobs() {
  const q = useQuery({ queryKey: ['data-jobs'], queryFn: dataApi.jobs });
  if (!q.data) return <Status q={q} />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-[var(--ink-dim)]">
          <tr><th className="py-1 pr-3">Job</th><th className="pr-3">Owner</th><th className="pr-3">Schedule</th><th className="pr-3">Next</th><th>Command</th></tr>
        </thead>
        <tbody>
          {q.data.jobs.map((j) => (
            <tr key={`${j.kind}:${j.name}`} className="border-t border-[var(--rule)]">
              <td className="py-1 pr-3 font-mono text-xs">{j.name}</td>
              <td className="pr-3 text-xs">{j.kind === 'connector' ? 'connector' : j.owner}</td>
              <td className="pr-3 font-mono text-xs">{j.schedule}</td>
              <td className="pr-3 text-xs whitespace-nowrap">{j.nextDue ? zoned(j.nextDue) : ''}</td>
              <td className="font-mono text-xs">{j.command}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Dashboards() {
  const q = useQuery({ queryKey: ['data-dashboards'], queryFn: dataApi.dashboards });
  const [pick, setPick] = useState<string | null>(null);
  if (!q.data) return <Status q={q} />;
  const list = q.data.dashboards;
  if (list.length === 0) return <p className="text-sm text-[var(--ink-dim)]">No dashboards yet. An agent adds one with the <code>data-dashboard</code> skill.</p>;
  const current = pick ?? list[0]!.name;
  return (
    <div>
      <div className="flex flex-wrap gap-2 text-sm">
        {list.map((d) => (
          <button key={d.name} onClick={() => setPick(d.name)}
            className={`rounded border px-2 py-0.5 ${current === d.name ? 'border-[var(--accent)]' : 'border-[var(--rule)]'}`}>
            {d.title}{d.error ? ' (invalid)' : ''}
          </button>
        ))}
      </div>
      <Dashboard name={current} />
    </div>
  );
}

function Dashboard({ name }: { name: string }) {
  const q = useQuery({ queryKey: ['data-dashboard', name], queryFn: () => dataApi.dashboard(name) });
  if (!q.data) return <div className="mt-4"><Status q={q} /></div>;
  return (
    <div className="mt-4">
      {q.data.description && <p className="mb-3 text-sm">{q.data.description}</p>}
      <div className="grid gap-4 md:grid-cols-2">
        {q.data.panels.map((p, i) => <Panel key={i} p={p} />)}
      </div>
    </div>
  );
}

function Panel({ p }: { p: DataPanel }) {
  const wide = p.chart === 'table' || p.chart === 'line' || p.chart === 'bar';
  return (
    <section className={`rounded border border-[var(--rule)] p-3 ${wide ? 'md:col-span-2' : ''}`}>
      <h3 className="text-sm font-medium">{p.title}</h3>
      {p.error && <p className="mt-1 text-xs text-red-600">{p.error}</p>}
      {p.result && p.chart === 'number' && <div className="mt-1 text-3xl font-semibold tabular-nums">{cellText(p.result.rows[0]?.[0])}</div>}
      {p.result && p.chart === 'table' && <div className="mt-2"><ResultTable r={p.result} /></div>}
      {p.result && (p.chart === 'line' || p.chart === 'bar') && <Chart p={p} r={p.result} />}
    </section>
  );
}

const COLORS = ['#2563eb', '#db2777', '#16a34a', '#ea580c', '#7c3aed'];

/** A plain SVG chart: x is the `x` column (time or category), one series per `y` column. */
function Chart({ p, r }: { p: DataPanel; r: DataQueryResult }) {
  const xi = Math.max(0, r.columns.indexOf(p.x ?? r.columns[0]!));
  const ys = (p.y?.length ? p.y : r.columns.filter((_, i) => i !== xi)).map((c) => r.columns.indexOf(c)).filter((i) => i >= 0);
  const n = r.rows.length;
  if (n === 0 || ys.length === 0) return <p className="mt-1 text-xs text-[var(--ink-dim)]">No rows.</p>;
  const vals = r.rows.flatMap((row) => ys.map((i) => Number(row[i]))).filter((v) => Number.isFinite(v));
  const max = Math.max(0, ...vals);
  const min = Math.min(0, ...vals);
  const W = 900, H = 200, L = 56, B = 22;
  const sx = (k: number) => L + (n === 1 ? (W - L) / 2 : (k / (n - 1)) * (W - L));
  const sy = (v: number) => (H - B) * (1 - (v - min) / Math.max(1e-9, max - min));
  const label = (v: unknown) => { const s = cellText(v); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s.slice(0, 12); };
  const bw = Math.max(1, ((W - L) / n) * 0.8 / ys.length);
  return (
    <div className="mt-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={p.title}>
        {[max, (max + min) / 2, min].map((v, i) => (
          <g key={i}>
            <line x1={L} x2={W} y1={sy(v)} y2={sy(v)} stroke="var(--rule)" />
            <text x={L - 6} y={sy(v) + 4} textAnchor="end" fontSize="11" fill="var(--ink-dim)">{Math.round(v).toLocaleString()}</text>
          </g>
        ))}
        {ys.map((yi, s) => p.chart === 'line'
          ? <path key={yi} fill="none" stroke={COLORS[s % COLORS.length]} strokeWidth={2}
              d={r.rows.map((row, k) => `${k ? 'L' : 'M'}${sx(k).toFixed(1)},${sy(Number(row[yi]) || 0).toFixed(1)}`).join(' ')} />
          : r.rows.map((row, k) => {
              const v = Number(row[yi]) || 0;
              const x = L + ((W - L) / n) * k + ((W - L) / n) * 0.1 + bw * s;
              return <rect key={`${yi}-${k}`} x={x} width={bw} y={Math.min(sy(v), sy(0))} height={Math.abs(sy(0) - sy(v))} fill={COLORS[s % COLORS.length]} />;
            }))}
        <text x={L} y={H - 4} fontSize="11" fill="var(--ink-dim)">{label(r.rows[0]![xi])}</text>
        <text x={W} y={H - 4} fontSize="11" textAnchor="end" fill="var(--ink-dim)">{label(r.rows[n - 1]![xi])}</text>
      </svg>
      {ys.length > 1 && (
        <div className="flex flex-wrap gap-3 text-xs">
          {ys.map((yi, s) => <span key={yi}><span style={{ color: COLORS[s % COLORS.length] }}>■</span> {r.columns[yi]}</span>)}
        </div>
      )}
    </div>
  );
}
