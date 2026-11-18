import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { projectsApi, STAGES, type ProjectRow, type Stage } from '../Projects.api.js';
import { ArchivedChip, STAGE_LABEL, StageChip } from './parts.js';

/**
 * The default view of `/projects`: finite projects across every area, filtered by area,
 * stage and due date. The filters live in the URL (`?area=&stage=&due=&archived=1`), so a
 * filtered list can be linked. Data: GET /api/projects.
 */

const DUE = ['overdue', 'week', 'month', 'none'] as const;
type Due = (typeof DUE)[number];
const DUE_LABEL: Record<Due, string> = { overdue: 'Overdue', week: 'Due in 7 days', month: 'Due in 30 days', none: 'No due date' };
/** A project that shipped or was parked is no longer late. */
const CLOSED: Stage[] = ['live', 'done', 'parked'];

const plusDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export function dueMatches(p: Pick<ProjectRow, 'due' | 'stage'>, due: Due, today: string): boolean {
  if (due === 'none') return p.due === null;
  if (p.due === null) return false;
  if (due === 'overdue') return p.due < today && !CLOSED.includes(p.stage);
  return p.due >= today && p.due <= plusDays(today, due === 'week' ? 7 : 30);
}

const select = 'max-w-full rounded border border-[var(--rule)] bg-transparent px-1 py-0.5 text-sm';

export default function ProjectList() {
  const [params, setParams] = useSearchParams();
  const area = params.get('area') ?? '';
  const stage = (STAGES as readonly string[]).includes(params.get('stage') ?? '') ? (params.get('stage') as Stage) : '';
  const due = (DUE as readonly string[]).includes(params.get('due') ?? '') ? (params.get('due') as Due) : '';
  const archived = params.get('archived') === '1';
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const list = useQuery({ queryKey: ['projects', 'list', archived], queryFn: () => projectsApi.list(archived), refetchInterval: 60_000, placeholderData: keepPreviousData });
  const all = list.data?.projects ?? [];
  const today = new Date().toISOString().slice(0, 10);
  const areas = [...new Set([...all.map((p) => p.area), ...(area ? [area] : [])])].sort();
  const rows = all
    .filter((p) => (!area || p.area === area) && (!stage || p.stage === stage) && (!due || dueMatches(p, due, today)))
    .sort((x, y) => (x.due ?? '9999').localeCompare(y.due ?? '9999') || x.area.localeCompare(y.area) || x.title.localeCompare(y.title));

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <select aria-label="Area" className={select} value={area} onChange={(e) => set('area', e.target.value)}>
          <option value="">All areas</option>
          {areas.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <select aria-label="Stage" className={select} value={stage} onChange={(e) => set('stage', e.target.value)}>
          <option value="">Any stage</option>
          {STAGES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
        </select>
        <select aria-label="Due" className={select} value={due} onChange={(e) => set('due', e.target.value)}>
          <option value="">Any due date</option>
          {DUE.map((d) => <option key={d} value={d}>{DUE_LABEL[d]}</option>)}
        </select>
        <label className="text-[var(--ink-dim)]">
          <input type="checkbox" className="mr-1" checked={archived} onChange={(e) => set('archived', e.target.checked ? '1' : '')} />
          Archived
        </label>
        {list.data && <span className="text-xs text-[var(--ink-faint)]">{rows.length} of {all.length}</span>}
      </div>
      {list.isError && <p>⚠ {list.error.message}</p>}
      {list.data && rows.length === 0 && <p className="text-sm text-[var(--ink-dim)]">{all.length ? 'No project matches these filters.' : 'No projects yet. Add one with `cli-projects add <area>/<project> --outcome "..."`.'}</p>}
      <ul aria-label="Projects" className="rounded border border-[var(--rule)] empty:hidden">
        {rows.map((p) => {
          const late = dueMatches(p, 'overdue', today);
          return (
            <li key={`${p.area}/${p.slug}`} className="min-w-0 border-t border-[var(--rule)] px-3 py-2 first:border-t-0">
              <div className="flex flex-wrap items-center gap-2">
                <Link to={`/projects/${p.area}/${p.slug}`} className="font-medium text-[var(--accent)] hover:underline">{p.title}</Link>
                <StageChip stage={p.stage} />
                {p.archived_at && <ArchivedChip />}
                <Link to={`/areas/${p.area}`} className="text-xs text-[var(--ink-dim)] hover:underline">{p.area}</Link>
                <span className={`text-xs ${late ? 'text-[var(--warn)]' : 'text-[var(--ink-dim)]'}`}>{p.due ? `due ${p.due}${late ? ' (overdue)' : ''}` : 'no due date'}</span>
                {p.owner && <span className="text-xs text-[var(--ink-dim)]">{p.owner}</span>}
              </div>
              {p.outcome && p.outcome !== p.title && <div className="text-sm break-words text-[var(--ink-dim)]">Outcome: {p.outcome}</div>}
              {p.next_action && <div className="text-sm break-words text-[var(--ink-dim)]">Next: {p.next_action}</div>}
              {p.needs_owner && <div className="text-xs break-words text-[var(--warn)]">⚑ Needs you: {p.needs_owner}</div>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
