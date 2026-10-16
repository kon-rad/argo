import { lazy, Suspense, useCallback, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import type { FullMapHandle, Layers } from '../components/map/FullMap.js';
import { ageDays, formatValue, mapApi, nodeColor, type MapMetric } from '../lib/mapData.js';

/**
 * Brain map: the second brain as one 3D scene. Mission at the centre, goals
 * and divisions on rings, projects and features around their division, the
 * vault's notes settled around them, and the live numbers as satellites.
 * `?kiosk=1` is the lean TV view for a Raspberry Pi.
 */

// Separate chunks: the Pi never downloads 3d-force-graph, the desktop never the kiosk scene.
const KioskMap = lazy(() => import('../components/map/KioskMap.js'));
const FullMap = lazy(() => import('../components/map/FullMap.js').then((m) => ({ default: m.FullMap })));

const KIND_LABEL: Record<string, string> = {
  mission: 'Mission', goal: 'Goal', division: 'Division', project: 'Project', feature: 'Feature', note: 'Note', metric: 'Metric',
};

function Sparkline({ series }: { series: { day: string; value: number }[] }) {
  if (series.length < 2) return null;
  const vals = series.map((p) => p.value);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const pts = series.map((p, i) => `${(i / (series.length - 1)) * 200},${40 - ((p.value - min) / (max - min || 1)) * 36 - 2}`).join(' ');
  return (
    <svg viewBox="0 0 200 40" className="mt-2 h-10 w-full" aria-label="30-day trend">
      <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth="2" />
    </svg>
  );
}

function MetricCard({ m }: { m: MapMetric }) {
  const age = ageDays(m);
  const stale = age !== null && age > 2;
  return (
    <div className="rounded border border-[var(--rule)] bg-[var(--paper)] px-3 py-2 text-sm">
      <div className="text-xs text-[var(--ink-dim)]">{m.label}</div>
      <div className="font-semibold tabular-nums">{formatValue(m)}</div>
      {m.target !== null && m.value !== null && (
        <div className="text-xs text-[var(--ink-dim)]">{((m.value / m.target) * 100).toFixed(2)}% of {m.target.toLocaleString('en-US')}{m.goal ? ` (${m.goal})` : ''}</div>
      )}
      {age !== null && <div className={`text-xs ${stale ? 'text-[var(--warn)]' : 'text-[var(--ink-faint)]'}`}>{age === 0 ? 'today' : `${age} d old`}{m.source ? ` · ${m.source}` : ''}</div>}
      <Sparkline series={m.series} />
    </div>
  );
}

function SidePanel({ id, metrics, onClose, onPick }: { id: string; metrics: MapMetric[]; onClose: () => void; onPick: (id: string) => void }) {
  const q = useQuery({ queryKey: ['map-node', id], queryFn: () => mapApi.node(id) });
  const d = q.data;
  const metric = d?.node.kind === 'metric' ? metrics.find((m) => m.key === d.node.ref) : undefined;
  const open = d?.node.kind === 'note' && d.node.ref
    ? `/file/${d.node.ref}`
    : d?.node.kind === 'project' || d?.node.kind === 'feature' || d?.node.kind === 'division' ? '/projects'
    : d?.node.kind === 'mission' && d.node.ref ? `/file/${d.node.ref}` : null;
  return (
    <aside className="absolute right-0 top-0 z-10 flex h-full w-[min(380px,100%)] flex-col gap-3 overflow-y-auto border-l border-[var(--rule)] bg-[var(--paper)] p-4 text-[var(--ink)]" data-testid="map-panel">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs uppercase tracking-wide text-[var(--ink-dim)]">{d ? KIND_LABEL[d.node.kind] : ''}</div>
          <h2 className="text-lg font-semibold leading-snug">{d?.node.label ?? '...'}</h2>
          {d?.node.ref && d.node.kind === 'note' && <div className="break-all font-mono text-xs text-[var(--ink-faint)]">{d.node.ref}</div>}
        </div>
        <button type="button" onClick={onClose} className="text-sm text-[var(--ink-dim)] hover:text-[var(--ink)]" aria-label="Close">✕</button>
      </div>
      {open && <Link to={open} className="self-start rounded bg-[var(--accent)] px-3 py-1 text-sm text-white">Open</Link>}
      {d?.node.meta['stage'] !== undefined && <div className="text-sm">Stage: <b>{String(d.node.meta['stage'])}</b></div>}
      {d?.node.meta['status'] !== undefined && <div className="text-sm">Status: {String(d.node.meta['status'])}</div>}
      {metric && <MetricCard m={metric} />}
      {d?.preview && <pre className="max-h-64 overflow-hidden whitespace-pre-wrap rounded bg-[var(--paper-sunk)] p-2 text-xs text-[var(--ink-dim)]">{d.preview}</pre>}
      {d && d.neighbours.length > 0 && (
        <div>
          <div className="mb-1 text-xs uppercase tracking-wide text-[var(--ink-dim)]">Connected ({d.neighbours.length})</div>
          <ul className="space-y-0.5 text-sm">
            {d.neighbours.map((n) => (
              <li key={n.id}>
                <button type="button" onClick={() => onPick(n.id)} className="text-left hover:underline">
                  <span className="text-[var(--ink-faint)]">{KIND_LABEL[n.kind]} · </span>{n.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </aside>
  );
}

export default function MapPage() {
  const [params] = useSearchParams();
  if (params.get('kiosk') === '1') return <Suspense fallback={null}><KioskMap /></Suspense>;
  return <FullMapPage />;
}

function FullMapPage() {
  const graph = useQuery({ queryKey: ['map-graph'], queryFn: mapApi.graph, refetchInterval: 10 * 60_000 });
  const metrics = useQuery({ queryKey: ['map-metrics'], queryFn: () => mapApi.metrics(false), refetchInterval: 60_000 });
  const [layers, setLayers] = useState<Layers>({ notes: true, links: true, structure: true, metrics: true });
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const mapRef = useRef<FullMapHandle>(null);
  const onSelect = useCallback((id: string | null) => setSelected(id), []);
  const pick = useCallback((id: string) => { setSelected(id); mapRef.current?.focus(id); }, []);

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q.length < 2 || !graph.data) return [];
    return graph.data.nodes.filter((n) => n.label.toLowerCase().includes(q) || (n.ref ?? '').toLowerCase().includes(q)).slice(0, 8);
  }, [search, graph.data]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const n of graph.data?.nodes ?? []) c[n.kind] = (c[n.kind] ?? 0) + 1;
    return c;
  }, [graph.data]);

  const divisions = graph.data?.nodes.filter((n) => n.kind === 'division') ?? [];
  const headline = (metrics.data?.metrics ?? []).filter((m) => m.headline);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-[var(--rule)] px-4 py-2 text-sm">
        <h1 className="font-semibold">Brain map</h1>
        <div className="relative">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && matches[0]) { pick(matches[0].id); setSearch(''); } }}
            placeholder="Find a note, project, goal..."
            className="w-64 rounded border border-[var(--rule)] bg-[var(--paper)] px-2 py-1"
          />
          {matches.length > 0 && (
            <ul className="absolute left-0 top-full z-20 mt-1 w-80 rounded border border-[var(--rule)] bg-[var(--paper)] shadow">
              {matches.map((n) => (
                <li key={n.id}>
                  <button type="button" className="block w-full truncate px-2 py-1 text-left hover:bg-[var(--paper-sunk)]" onClick={() => { pick(n.id); setSearch(''); }}>
                    <span className="text-[var(--ink-faint)]">{KIND_LABEL[n.kind]} · </span>{n.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {(Object.keys(layers) as (keyof Layers)[]).map((k) => (
          <label key={k} className="flex items-center gap-1">
            <input type="checkbox" checked={layers[k]} onChange={(e) => setLayers({ ...layers, [k]: e.target.checked })} />
            {k}
          </label>
        ))}
        <span className="text-xs text-[var(--ink-faint)]">
          {counts['note'] ?? 0} notes · {counts['project'] ?? 0} projects · {counts['feature'] ?? 0} features
          {graph.data ? ` · layout v${graph.data.version}` : ''}
        </span>
        <Link to="/map?kiosk=1" className="ml-auto underline">TV view</Link>
      </div>
      <div className="relative min-h-0 flex-1">
        {graph.isError && <div className="p-6 text-sm text-[var(--ink-dim)]">Map unavailable: {(graph.error as Error).message}</div>}
        {graph.data && (
          <Suspense fallback={<div className="p-6 text-sm text-[var(--ink-dim)]">Loading the 3D view...</div>}><FullMap ref={mapRef} graph={graph.data} metrics={metrics.data?.metrics ?? []} layers={layers} selected={selected} onSelect={onSelect} /></Suspense>
        )}
        <div className="pointer-events-none absolute bottom-3 left-3 flex max-w-[60%] flex-wrap gap-2">
          {divisions.map((d) => (
            <button type="button" key={d.id} onClick={() => pick(d.id)} className="pointer-events-auto flex items-center gap-1 rounded bg-black/50 px-2 py-0.5 text-xs text-white">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: nodeColor(d) }} />
              {d.label}
            </button>
          ))}
        </div>
        {!selected && headline.length > 0 && (
          <div className="absolute right-3 top-3 grid w-56 gap-2">
            {headline.map((m) => <MetricCard key={m.key} m={m} />)}
          </div>
        )}
        {selected && <SidePanel id={selected} metrics={metrics.data?.metrics ?? []} onClose={() => setSelected(null)} onPick={pick} />}
      </div>
    </div>
  );
}
