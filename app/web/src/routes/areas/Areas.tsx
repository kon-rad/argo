import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { projectsApi, type AreaIndexRow } from '../Projects.api.js';
import { ArchivedChip, StatusChip } from './parts.js';

/**
 * `/areas`: what you run. Active areas grouped by division, each with its open project
 * count, its owner and, when it defines KPIs, how many are at target. Parked and archived
 * areas sit behind their own toggles. Data: GET /api/areas?view=index.
 */

function kpiLine(k: NonNullable<AreaIndexRow['kpis']>): string {
  if (k.with_target === 0) return `${k.total} ${k.total === 1 ? 'KPI' : 'KPIs'}, no reading against a target yet`;
  return `KPIs: ${k.on_target} of ${k.with_target} at target`;
}

function AreaCard({ a }: { a: AreaIndexRow }) {
  return (
    <li className="min-w-0 rounded border border-[var(--rule)] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Link to={`/areas/${a.slug}`} className="font-semibold text-[var(--accent)] hover:underline">{a.title}</Link>
        {a.archived_at ? <ArchivedChip /> : <StatusChip status={a.status} />}
        {a.health && <span className="text-xs text-[var(--ink-dim)]">health {a.health}</span>}
      </div>
      {a.description && <p className="mt-1 text-sm break-words text-[var(--ink-dim)]">{a.description}</p>}
      <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-[var(--ink-dim)]">
        <span>{a.active_projects} active {a.active_projects === 1 ? 'project' : 'projects'}</span>
        <span>owner {a.owner ?? 'none'}</span>
        {a.kpis && <span>{kpiLine(a.kpis)}</span>}
      </div>
      {a.needs_owner && <div className="mt-1 text-xs break-words text-[var(--warn)]">⚑ Needs you: {a.needs_owner}</div>}
    </li>
  );
}

export default function Areas() {
  const [parked, setParked] = useState(false);
  const [archived, setArchived] = useState(false);
  const index = useQuery({ queryKey: ['projects', 'areas'], queryFn: projectsApi.areaIndex, refetchInterval: 60_000 });
  const all = index.data?.areas ?? [];
  const nParked = all.filter((a) => !a.archived_at && a.status === 'parked').length;
  const nArchived = all.filter((a) => a.archived_at).length;
  const visible = all.filter((a) => (a.archived_at ? archived : a.status === 'parked' ? parked : true));

  // Divisions in the order the server sends them; areas with none go last.
  const groups: { key: string; name: string; areas: AreaIndexRow[] }[] = [];
  for (const a of visible) {
    const key = a.division ?? '';
    let g = groups.find((x) => x.key === key);
    if (!g) groups.push((g = { key, name: a.division_name ?? a.division ?? 'No division', areas: [] }));
    g.areas.push(a);
  }

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1">
        <h1 className="text-lg font-semibold tracking-tight">Areas</h1>
        <label className="text-sm text-[var(--ink-dim)]">
          <input type="checkbox" className="mr-1" checked={parked} onChange={(e) => setParked(e.target.checked)} />
          Parked ({nParked})
        </label>
        <label className="text-sm text-[var(--ink-dim)]">
          <input type="checkbox" className="mr-1" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
          Archived ({nArchived})
        </label>
        <Link to="/projects" className="text-sm text-[var(--accent)] hover:underline md:ml-auto">Projects across areas</Link>
      </div>
      {index.isError && <p>⚠ {index.error.message}</p>}
      {index.data && all.length === 0 && (
        <p className="text-sm text-[var(--ink-dim)]">No areas in this database yet. Add one with `cli-areas add`, then its projects with `cli-projects add`.</p>
      )}
      {index.data && all.length > 0 && visible.length === 0 && <p className="text-sm text-[var(--ink-dim)]">No active areas. The parked and archived ones are behind the toggles above.</p>}
      <div className="space-y-4">
        {groups.map((g) => (
          <section key={g.key} aria-label={g.name}>
            <h2 className="mb-2 text-sm font-semibold text-[var(--ink-dim)]">{g.name} <span className="font-normal">({g.areas.length})</span></h2>
            <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {g.areas.map((a) => <AreaCard key={a.slug} a={a} />)}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
