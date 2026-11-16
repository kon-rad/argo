import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ChatInput } from '../../components/ChatInput.js';
import EventFeed from '../../components/EventFeed.js';
import { VaultMarkdown } from '../../components/VaultMarkdown.js';
import { api, type OrgChart } from '../../lib/api.js';
import { projectsApi, type TrackerArea } from '../Projects.api.js';
import { boardApi, BOARD_STATUSES, type BoardCard, type BoardCardDetail, type BoardStatus } from './api.js';
import { useEventLog } from '../../lib/useEventLog.js';
import { CardNotes, useCardNotesFor } from '../../components/CardNotes.js';

/**
 * The board module's page: the kanban record in the engine (docs/board-design.md). Columns over the card statuses,
 * filters by board, area, assignee and kind, a card panel with its contract, comments, dependencies and runs. Live
 * through the server's SSE feed (pg_notify), so nothing polls. Writes act as the owner.
 */

const COLUMNS: { key: string; label: string; statuses: BoardStatus[] }[] = [
  { key: 'todo', label: 'To do', statuses: ['triage', 'todo', 'scheduled'] },
  { key: 'ready', label: 'Ready', statuses: ['ready'] },
  { key: 'running', label: 'Running', statuses: ['running', 'review'] },
  { key: 'blocked', label: 'Blocked', statuses: ['blocked'] },
  { key: 'done', label: 'Done', statuses: ['done', 'archived'] },
];

/** Sort options for the cards inside each column. Newest created first is the default. */
export const SORTS = [
  { key: 'newest', label: 'Newest first' },
  { key: 'oldest', label: 'Oldest first' },
  { key: 'updated', label: 'Recently updated' },
  { key: 'priority', label: 'Priority (p1 first)' },
] as const;
export type SortKey = (typeof SORTS)[number]['key'];

export function sortCards(cards: BoardCard[], sort: string | null | undefined): BoardCard[] {
  const t = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : 0);
  const byNewest = (a: BoardCard, b: BoardCard): number => t(b.created_at) - t(a.created_at);
  const cmp: Record<SortKey, (a: BoardCard, b: BoardCard) => number> = {
    newest: byNewest,
    oldest: (a, b) => -byNewest(a, b),
    updated: (a, b) => t(b.updated_at) - t(a.updated_at) || byNewest(a, b),
    priority: (a, b) => a.priority - b.priority || byNewest(a, b),
  };
  return [...cards].sort(cmp[(SORTS.some((o) => o.key === sort) ? sort : 'newest') as SortKey]);
}

const KINDS = ['work', 'spec', 'build', 'review', 'verify', 'doc', 'status', 'improve', 'revert'];

export const age = (iso: string | null): string => {
  if (!iso) return '';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return 'now';
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 129600) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};

/** Hermes profiles and Claude lanes have their own colours by name; roster bots are the org's. */
export function runtimeOf(chart: OrgChart | null | undefined, name: string | null): string {
  if (!name) return 'none';
  return chart?.agents.find((a) => a.name === name)?.runtime ?? (name.startsWith('cc-') ? 'claude-code' : 'hermes');
}

export function AgentChip({ name, chart }: { name: string | null; chart?: OrgChart | null }) {
  const rt = runtimeOf(chart, name);
  const color = rt === 'claude-code' ? 'var(--claude)' : rt === 'hermes' ? 'var(--hermes)' : rt === 'none' ? 'var(--ink-faint)' : 'var(--accent)';
  return (
    <span className="rounded px-1.5 py-0.5 text-[0.7rem] font-medium text-white" style={{ background: color }} title={rt}>
      {name ?? 'unassigned'}
    </span>
  );
}

/** The tracker's areas a card can be tagged with: the active ones, by slug, each with its projects. */
function useTrackerAreas(): TrackerArea[] {
  const report = useQuery({ queryKey: ['projects', 'report'], queryFn: projectsApi.report, staleTime: 60_000, retry: false });
  return useMemo(() => (report.data?.areas ?? []).filter((a) => a.status === 'active').sort((a, b) => a.slug.localeCompare(b.slug)), [report.data]);
}

export function ProjectChip({ area, project, to }: { area: string; project: string | null; to: string }) {
  return (
    <Link to={to} title={`Cards in ${area}`} className="truncate rounded bg-[var(--paper-sunk)] px-1.5 py-0.5 font-medium text-[var(--accent)] hover:underline">
      {area}{project ? `/${project}` : ''}
    </Link>
  );
}

/** The live feed: one invalidation per board event, scoped to the card it names. */
function useBoardLive(board: string | undefined) {
  const qc = useQueryClient();
  const [live, setLive] = useState(false);
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const es = new EventSource('/api/board/events');
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    es.onmessage = (ev) => {
      try {
        const n = JSON.parse(ev.data as string) as { card: string; board: string | null };
        if (board && n.board && n.board !== board) return;
        void qc.invalidateQueries({ queryKey: ['board', 'cards'] });
        void qc.invalidateQueries({ queryKey: ['board', 'card', n.card] });
        void qc.invalidateQueries({ queryKey: ['board', 'boards'] });
      } catch {
        /* a comment line */
      }
    };
    return () => es.close();
  }, [qc, board]);
  return live;
}

export default function Board() {
  const navigate = useNavigate();
  const { cardId } = useParams();
  const [params, setParams] = useSearchParams();
  const board = params.get('board') ?? undefined;
  // `?project=<area>` is the link shape from before the PARA rename; old bookmarks keep working.
  const area = params.get('area') ?? params.get('project') ?? undefined;
  const assignee = params.get('assignee') ?? undefined;
  const kind = params.get('kind') ?? undefined;
  const q = params.get('q') ?? '';
  const ids = params.get('id') ?? undefined;
  const sort = params.get('sort') ?? 'newest';
  const set = (k: string, v: string): void => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const [showNew, setShowNew] = useState(false);
  const live = useBoardLive(board);
  const boards = useQuery({ queryKey: ['board', 'boards'], queryFn: boardApi.boards, staleTime: 60_000 });
  const chart = useQuery({ queryKey: ['org', 'chart'], queryFn: api.orgChart, staleTime: 60_000, retry: false });
  const cards = useQuery({
    queryKey: ['board', 'cards', { board, area, assignee, kind, q, ids }],
    queryFn: () => boardApi.cards({ board, area, assignee, kind, q: q.trim() || undefined, id: ids }),
    refetchInterval: live ? false : 15_000,
  });
  const list = cards.data?.cards ?? [];
  const notes = useCardNotesFor(list.map((c) => ({ id: c.id, text: [c.title, c.body, c.result].filter(Boolean).join('\n\n') })));
  const tracker = useTrackerAreas();
  // The tracker's live areas, plus any slug a loaded card still carries (a parked area's card stays filterable).
  const areas = useMemo(
    () => [...new Set([...tracker.map((p) => p.slug), ...list.map((c) => c.area_slug).filter((p): p is string => !!p)])].sort(),
    [tracker, list],
  );
  const projectHref = (slug: string): string => `/board?${new URLSearchParams({ area: slug }).toString()}`;
  const assignees = useMemo(() => [...new Set(list.map((c) => c.assignee ?? 'none'))].sort(), [list]);

  if (cards.isError) return <p className="p-4 text-sm text-[var(--warn)]">⚠ {cards.error.message}</p>;

  const select = (label: string, value: string | undefined, options: { value: string; label: string }[], onChange: (v: string) => void) => (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value)} aria-label={label} className="rounded border border-[var(--rule)] bg-[var(--paper)] px-2 py-1 text-xs">
      <option value="">{label}</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--rule)] px-3 py-2 text-sm">
          {select('All boards', board, (boards.data?.boards ?? []).map((b) => ({ value: b.slug, label: `${b.name} (${b.open})` })), (v) => set('board', v))}
          {select('Any area', area, areas.map((p) => ({ value: p, label: p })), (v) => set('area', v))}
          {select('Anyone', assignee, assignees.map((a) => ({ value: a, label: a })), (v) => set('assignee', v))}
          {select('Any kind', kind, KINDS.map((k) => ({ value: k, label: k })), (v) => set('kind', v))}
          <select value={sort} onChange={(e) => set('sort', e.target.value === 'newest' ? '' : e.target.value)} aria-label="Sort by" className="rounded border border-[var(--rule)] bg-[var(--paper)] px-2 py-1 text-xs">
            {SORTS.map((o) => <option key={o.key} value={o.key}>Sort: {o.label}</option>)}
          </select>
          <input value={q} onChange={(e) => set('q', e.target.value)} placeholder="Search or t_1d4c…" aria-label="Search cards"
            title="Words search the text; a ticket number (t_1d4c0eff, #1d4c or 1d4c0eff) finds the card by id"
            className="w-40 rounded border border-[var(--rule)] bg-[var(--paper)] px-2 py-1 text-xs" />
          {ids && (
            <span className="flex items-center gap-1 rounded bg-[var(--paper-sunk)] px-2 py-0.5 text-xs">
              Only {ids.split(',').join(', ')}
              <button type="button" onClick={() => set('id', '')} aria-label="Show all cards" className="text-[var(--ink-dim)] hover:text-[var(--ink)]">✕</button>
            </span>
          )}
          <span className="text-xs text-[var(--ink-faint)]">{list.length} cards · {live ? 'live' : 'refreshes every 15 s'}</span>
          <button type="button" onClick={() => setShowNew((v) => !v)} className="ml-auto rounded bg-[var(--accent)] px-3 py-1 text-xs font-medium text-white">
            {showNew ? 'Close' : 'New card'}
          </button>
        </div>
        {showNew && <NewCard board={board} chart={chart.data ?? null} onCreated={(id) => { setShowNew(false); navigate(`/board/${id}${location.search}`); }} />}
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
          {COLUMNS.map((col) => {
            const rows = sortCards(list.filter((c) => col.statuses.includes(c.status)), sort);
            return (
              <section key={col.key} className="flex w-64 shrink-0 flex-col" aria-label={col.label}>
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--ink-dim)]">
                  {col.label} <span className="font-normal text-[var(--ink-faint)]">{rows.length}</span>
                  {col.key === 'done' && <span className="font-normal normal-case text-[var(--ink-faint)]"> · last 7 days</span>}
                </h2>
                <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto">
                  {rows.map((c) => (
                    <li key={c.id} className={`rounded border hover:bg-[var(--paper-sunk)] ${cardId === c.id ? 'border-[var(--accent)]' : 'border-[var(--rule)]'}`}>
                      <button type="button" onClick={() => navigate(`/board/${c.id}${location.search}`)} className="w-full px-2 py-1.5 text-left text-sm">
                        <div className="line-clamp-3">{c.ship_now && <span title="ship-now">🚀 </span>}{c.title}</div>
                        <div className="mt-1 flex items-center gap-2 text-xs text-[var(--ink-dim)]">
                          <AgentChip name={c.assignee} chart={chart.data} />
                          {c.kind !== 'work' && <span className="rounded bg-[var(--paper-sunk)] px-1">{c.kind}{c.rounds ? ` r${c.rounds}` : ''}</span>}
                          {c.status === 'running' && <span className="animate-pulse">●</span>}
                          {c.block_kind && <span title={c.block_reason ?? ''}>⛔ {c.block_kind}</span>}
                          <span className="ml-auto tabular-nums">{age(c.completed_at ?? c.started_at ?? c.created_at)}</span>
                        </div>
                      </button>
                      {/* Outside the button so the id selects like text and the chip is a real link. */}
                      <div className="flex min-w-0 items-center gap-1.5 px-2 pb-1.5 text-[0.65rem] text-[var(--ink-faint)]">
                        <span className="select-all font-mono">{c.id}</span>
                        {c.area_slug && <ProjectChip area={c.area_slug} project={c.project_slug} to={projectHref(c.area_slug)} />}
                      </div>
                      <CardNotes refs={notes.refsByTask.get(c.id) ?? []} resolved={notes.resolved} />
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      </div>
      {cardId && <CardPanel id={cardId} chart={chart.data ?? null} onClose={() => navigate(`/board${location.search}`)} />}
    </div>
  );
}

function NewCard({ board, chart, onCreated }: { board: string | undefined; chart: OrgChart | null; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [assignee, setAssignee] = useState('');
  const [area, setArea] = useState('');
  const [project, setProject] = useState('');
  const [kind, setKind] = useState('work');
  const [priority, setPriority] = useState(3);
  const areas = useTrackerAreas();
  const projects = areas.find((p) => p.slug === area)?.projects ?? [];
  const bots = (chart?.agents ?? []).filter((a) => a.runtime !== 'human');
  const byRuntime = new Map<string, typeof bots>();
  for (const b of bots) byRuntime.set(b.runtime, [...(byRuntime.get(b.runtime) ?? []), b]);
  const create = useMutation({
    mutationFn: () => boardApi.create({ board, title, body: body || undefined, assignee: assignee || null, area: area || undefined, project: project || undefined, kind, priority }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['board'] });
      onCreated(r.card.id);
    },
  });
  return (
    <form aria-label="New card" className="space-y-2 border-b border-[var(--rule)] bg-[var(--paper-sunk)] p-3" onSubmit={(e) => { e.preventDefault(); if (title.trim()) create.mutate(); }}>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What should be done?" maxLength={200} aria-label="Card title"
        className="w-full rounded border border-[var(--rule)] bg-[var(--paper)] px-2 py-1.5 text-sm" autoFocus />
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} placeholder="Details, links, where to put the result (optional)" aria-label="Card body"
        className="w-full rounded border border-[var(--rule)] bg-[var(--paper)] px-2 py-1.5 text-sm" />
      <div className="flex flex-wrap items-center gap-2">
        <select value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Agent" className="max-w-full rounded border border-[var(--rule)] bg-[var(--paper)] px-2 py-1 text-xs">
          <option value="">unassigned (my backlog)</option>
          {[...byRuntime].map(([rt, list]) => (
            <optgroup key={rt} label={rt}>{list.map((a) => <option key={a.name} value={a.name}>{a.name}{a.team_slug ? ` · ${a.team_slug}` : ''} — {a.role.slice(0, 40)}</option>)}</optgroup>
          ))}
        </select>
        <select aria-label="Area" value={area} onChange={(e) => { setArea(e.target.value); setProject(''); }} className="rounded border border-[var(--rule)] bg-[var(--paper)] px-2 py-1 text-xs">
          <option value="">area (optional)</option>
          {areas.map((p) => <option key={p.slug} value={p.slug}>{p.slug}</option>)}
        </select>
        <select aria-label="Project" value={project} onChange={(e) => setProject(e.target.value)} disabled={!area} className="rounded border border-[var(--rule)] bg-[var(--paper)] px-2 py-1 text-xs">
          <option value="">project (optional)</option>
          {projects.map((f) => <option key={f.slug} value={f.slug}>{f.slug}</option>)}
        </select>
        <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)} className="rounded border border-[var(--rule)] bg-[var(--paper)] px-2 py-1 text-xs">
          {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <select aria-label="Priority" value={priority} onChange={(e) => setPriority(Number(e.target.value))} className="rounded border border-[var(--rule)] bg-[var(--paper)] px-2 py-1 text-xs">
          {[1, 2, 3, 4, 5].map((p) => <option key={p} value={p}>p{p}</option>)}
        </select>
        <button type="submit" disabled={!title.trim() || create.isPending} className="rounded bg-[var(--accent)] px-3 py-1 text-xs font-medium text-white disabled:opacity-50">
          {create.isPending ? 'Creating…' : assignee ? `Give it to ${assignee}` : 'Add to the backlog'}
        </button>
        {create.isError && <span className="text-xs text-[var(--warn)]">⚠ {create.error.message}</span>}
      </div>
    </form>
  );
}

function Contract({ c }: { c: BoardCard['contract'] }) {
  const entries = Object.entries(c ?? {}).filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && !v.length));
  if (!entries.length) return null;
  return (
    <section className="rounded border border-[var(--rule)] p-2 text-sm" aria-label="Contract">
      <h3 className="text-xs font-semibold uppercase text-[var(--ink-dim)]">Contract</h3>
      <dl className="mt-1 space-y-1">
        {entries.map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs font-medium capitalize">{k}</dt>
            <dd className="text-[var(--ink-dim)]">
              {Array.isArray(v) ? <ul className="list-disc pl-4">{v.map((x, i) => <li key={i}>{String(x)}</li>)}</ul>
                : typeof v === 'object' ? Object.entries(v as Record<string, unknown>).map(([a, b]) => `${a}: ${String(b)}`).join(' · ') : String(v)}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function CardPanel({ id, chart, onClose }: { id: string; chart: OrgChart | null; onClose: () => void }) {
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ['board', 'card', id], queryFn: () => boardApi.card(id) });
  const meta = useQuery({ queryKey: ['meta'], queryFn: api.meta, staleTime: Infinity });
  const d: BoardCardDetail | undefined = detail.data;
  const c = d?.card;
  const isClaude = runtimeOf(chart, c?.assignee ?? null) === 'claude-code' && (meta.data?.modules ?? []).includes('agents');
  const log = useEventLog(isClaude && c ? `card:${id}` : null, (off) => boardApi.log(id, off), c?.status === 'running');
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['board', 'card', id] });
    void qc.invalidateQueries({ queryKey: ['board', 'cards'] });
  };
  const [comment, setComment] = useState('');
  const [assignee, setAssignee] = useState<string | null>(null);
  const send = useMutation({ mutationFn: () => boardApi.comment(id, comment), onSuccess: () => { setComment(''); refresh(); } });
  const move = useMutation({ mutationFn: (status: BoardStatus) => boardApi.move(id, status), onSuccess: refresh });
  const finish = useMutation({ mutationFn: (outcome: 'done' | 'partial') => boardApi.finish(id, { outcome }), onSuccess: refresh });
  const assign = useMutation({ mutationFn: (to: string | null) => boardApi.assign(id, { assignee: to }), onSuccess: () => { setAssignee(null); refresh(); } });
  const flag = useMutation({ mutationFn: (ship_now: boolean) => boardApi.flags(id, { ship_now }), onSuccess: refresh });
  const tag = useMutation({ mutationFn: (t: { area: string | null; project: string | null }) => boardApi.tag(id, t), onSuccess: refresh });
  const err = [send, move, finish, assign, flag, tag].find((m) => m.isError)?.error;
  const bots = (chart?.agents ?? []).filter((a) => a.runtime !== 'human');
  const tracker = useTrackerAreas();
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void navigator.clipboard?.writeText(id).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => undefined);
  };
  // The card's own area stays in the list even when the tracker parked it, so the select shows the truth.
  const areaOptions = c?.area_slug && !tracker.some((p) => p.slug === c.area_slug) ? [c.area_slug, ...tracker.map((p) => p.slug)] : tracker.map((p) => p.slug);
  const projectOptions = tracker.find((p) => p.slug === c?.area_slug)?.projects.map((f) => f.slug) ?? [];
  if (c?.project_slug && !projectOptions.includes(c.project_slug)) projectOptions.unshift(c.project_slug);
  return (
    <aside className="flex w-full max-w-xl shrink-0 flex-col border-l border-[var(--rule)] max-md:fixed max-md:inset-0 max-md:z-20 max-md:max-w-none max-md:bg-[var(--paper)]" aria-label="Card">
      <div className="flex items-center gap-2 border-b border-[var(--rule)] px-3 py-2">
        <span className="select-all font-mono text-xs text-[var(--ink-dim)]">{id}</span>
        <button type="button" onClick={copy} aria-label={`Copy ${id}`} title="Copy the ticket number" className="rounded border border-[var(--rule)] px-1.5 text-[0.65rem] text-[var(--ink-dim)] hover:text-[var(--ink)]">
          {copied ? 'copied' : 'copy'}
        </button>
        {c && <AgentChip name={c.assignee} chart={chart} />}
        {c && <span className="text-xs text-[var(--ink-dim)]">{c.status}{c.block_kind ? ` · ${c.block_kind}` : ''}</span>}
        <button type="button" onClick={onClose} className="ml-auto text-sm text-[var(--ink-dim)] hover:text-[var(--ink)]" aria-label="Close">✕</button>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
        {detail.isError && <p className="text-sm text-[var(--warn)]">⚠ {detail.error.message}</p>}
        {c && (
          <>
            <h2 className="text-base font-semibold">{c.ship_now && <span title="ship-now">🚀 </span>}{c.title}</h2>
            <p className="text-xs text-[var(--ink-dim)]">
              {c.board_slug} · {c.kind}{c.work_type ? ` · ${c.work_type}` : ''}{c.needs ? ` · needs ${c.needs}` : ''} · p{c.priority} · by {c.created_by} {age(c.created_at)} ago
              {c.area_slug && <> · <Link className="text-[var(--accent)]" to={`/projects?view=board`}>{c.area_slug}{c.project_slug ? `/${c.project_slug}` : ''}</Link></>}
              {c.repo && <> · repo {c.repo}</>}{c.graph && <> · {c.graph}/{c.node}</>}{c.rounds ? <> · round {c.rounds}</> : null}
            </p>
            <div className="flex flex-wrap items-center gap-2 text-xs" aria-label="Area">
              <span className="text-[var(--ink-dim)]">Area</span>
              <select aria-label="Card area" value={c.area_slug ?? ''}
                onChange={(e) => tag.mutate({ area: e.target.value || null, project: null })}
                className="rounded border border-[var(--rule)] bg-[var(--paper)] px-2 py-1">
                <option value="">none</option>
                {areaOptions.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
              <select aria-label="Card project" value={c.project_slug ?? ''} disabled={!c.area_slug}
                onChange={(e) => tag.mutate({ area: c.area_slug, project: e.target.value || null })}
                className="rounded border border-[var(--rule)] bg-[var(--paper)] px-2 py-1">
                <option value="">no project</option>
                {projectOptions.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
            {c.block_reason && <p className="rounded border border-[var(--warn)] p-2 text-sm">⛔ {c.block_kind}: {c.block_reason}</p>}
            {c.body && <VaultMarkdown text={c.body} />}
            <Contract c={c.contract} />
            {c.result && (
              <section className="rounded border border-[var(--rule)] p-2">
                <h3 className="text-xs font-semibold uppercase text-[var(--ink-dim)]">Result</h3>
                <VaultMarkdown text={c.result} />
              </section>
            )}
            {(d!.depends_on.length > 0 || d!.dependants.length > 0) && (
              <p className="text-xs">
                {d!.depends_on.length > 0 && <>Waits for: {d!.depends_on.map((x) => <Link key={x.id} to={`/board/${x.id}`} className="mr-2 text-[var(--accent)] underline" title={x.title}>{x.id} [{x.status}]</Link>)}</>}
                {d!.dependants.length > 0 && <>Waited for by: {d!.dependants.map((x) => <Link key={x.id} to={`/board/${x.id}`} className="mr-2 text-[var(--accent)] underline" title={x.title}>{x.id} [{x.status}]</Link>)}</>}
              </p>
            )}
            {c.status !== 'done' && c.status !== 'archived' && (
              <div className="flex flex-wrap items-center gap-2 text-xs" aria-label="Actions">
                <select aria-label="Move to" value="" onChange={(e) => e.target.value && move.mutate(e.target.value as BoardStatus)} className="rounded border border-[var(--rule)] bg-[var(--paper)] px-2 py-1">
                  <option value="">move to…</option>
                  {BOARD_STATUSES.filter((s) => s !== c.status && s !== 'running').map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <select aria-label="Reassign" value={assignee ?? c.assignee ?? ''} onChange={(e) => { setAssignee(e.target.value); assign.mutate(e.target.value || null); }} className="rounded border border-[var(--rule)] bg-[var(--paper)] px-2 py-1">
                  <option value="">unassigned</option>
                  {bots.map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
                </select>
                {c.status === 'running' && <button type="button" onClick={() => finish.mutate('done')} className="rounded border border-[var(--rule)] px-2 py-1">mark done</button>}
                {c.status === 'running' && <button type="button" onClick={() => finish.mutate('partial')} className="rounded border border-[var(--rule)] px-2 py-1">release to ready</button>}
                {!c.ship_now && <button type="button" onClick={() => flag.mutate(true)} className="rounded border border-[var(--rule)] px-2 py-1" title="Ship without asking">ship-now</button>}
              </div>
            )}
            {err && <p className="text-xs text-[var(--warn)]">⚠ {err.message}</p>}
            {isClaude && (
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase text-[var(--ink-dim)]">Worker log</h3>
                {log.events.length === 0 ? <p className="text-xs text-[var(--ink-faint)]">{c.status === 'ready' ? 'Waiting for its lane to claim it.' : 'No log yet.'}</p>
                  : <EventFeed events={log.events} working={c.status === 'running'} />}
              </section>
            )}
            <section>
              <h3 className="mb-1 text-xs font-semibold uppercase text-[var(--ink-dim)]">Comments</h3>
              <ul className="space-y-1">
                {d!.comments.map((m) => (
                  <li key={m.id} className="text-sm">
                    <b className="font-medium">{m.author}</b> <span className="text-xs text-[var(--ink-faint)]">{age(m.created_at)}</span>
                    <VaultMarkdown text={m.body} breaks />
                  </li>
                ))}
              </ul>
              <form className="mt-2 flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (comment.trim() && !send.isPending) send.mutate(); }}>
                <ChatInput value={comment} onChange={setComment} label="Comment" placeholder={`Comment as ${meta.data?.owner ?? 'owner'} (Enter sends, Shift+Enter for a new line)`}
                  onSubmit={() => { if (comment.trim() && !send.isPending) send.mutate(); }} />
                <button type="submit" disabled={!comment.trim() || send.isPending} className="rounded border border-[var(--rule)] px-3 py-2 text-sm">Send</button>
              </form>
            </section>
            {d!.runs.length > 0 && (
              <details className="text-xs text-[var(--ink-dim)]" open>
                <summary className="cursor-pointer">Runs ({d!.runs.length})</summary>
                <ul className="mt-1 space-y-0.5">
                  {d!.runs.map((r) => (
                    <li key={r.id}>
                      {r.agent_name} ({r.runtime}) {age(r.claimed_at)} ago · {r.finished_at ? `${r.outcome} after ${Math.max(1, Math.round((Date.parse(r.finished_at) - Date.parse(r.claimed_at)) / 60000))} min` : `running, lease until ${new Date(r.lease_until).toLocaleTimeString()}`}
                      {r.tokens ? ` · ${r.tokens.toLocaleString()} tokens` : ''}{r.turns ? ` · ${r.turns} turns` : ''}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <details className="text-xs text-[var(--ink-dim)]">
              <summary className="cursor-pointer">Events ({d!.events.length})</summary>
              <ul className="mt-1 space-y-0.5">
                {d!.events.map((e) => <li key={e.id}>{age(e.at)} · {e.kind}{e.actor ? ` · ${e.actor}` : ''}{e.payload?.['to'] ? ` → ${String(e.payload['to'])}` : ''}</li>)}
              </ul>
            </details>
          </>
        )}
      </div>
    </aside>
  );
}
