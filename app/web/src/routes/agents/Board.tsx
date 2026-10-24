import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { VaultMarkdown } from '../../components/VaultMarkdown.js';
import { api, fileHref, type HubAgent, type KanbanTask } from '../../lib/api.js';
import { collectVaultRefs } from '../../lib/vaultRefs.js';
import { ChatInput } from '../../components/ChatInput.js';
import { useEventLog } from '../../lib/useEventLog.js';
import EventFeed from '../../components/EventFeed.js';
import HubError from './HubError.js';

/**
 * The Hermes kanban board, shared by Hermes profiles and the Claude Code lanes (cc-*, run by cc-dispatcher).
 * Read and written through agent-hub, which calls the `hermes kanban` CLI. Claude tasks show their worker's live
 * stream-json log; Hermes tasks show comments and events.
 */

const COLUMNS: { key: string; label: string; statuses: string[] }[] = [
  { key: 'todo', label: 'To do', statuses: ['triage', 'todo', 'scheduled'] },
  { key: 'ready', label: 'Ready', statuses: ['ready'] },
  { key: 'running', label: 'Running', statuses: ['running', 'review'] },
  { key: 'blocked', label: 'Blocked', statuses: ['blocked'] },
  { key: 'done', label: 'Done', statuses: ['done'] },
];
const MONEY = new Set(['trader', 'portfolio', 'wallet']);

export const family = (assignee: string | null): 'claude' | 'hermes' => (assignee?.startsWith('cc-') ? 'claude' : 'hermes');

export function AgentChip({ name }: { name: string | null }) {
  const f = family(name);
  return (
    <span className="rounded px-1.5 py-0.5 text-[0.7rem] font-medium text-white" style={{ background: `var(--${f})` }}>
      {name ?? 'unassigned'}
    </span>
  );
}

const age = (epoch: number | null): string => {
  if (!epoch) return '';
  const s = Date.now() / 1000 - epoch;
  if (s < 90) return 'now';
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 129600) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};

export default function Board() {
  const navigate = useNavigate();
  const { taskId } = useParams();
  const [boardName, setBoardName] = useState('exo');
  const [showNew, setShowNew] = useState(false);
  const boards = useQuery({ queryKey: ['hub-boards'], queryFn: api.boards, staleTime: 60_000 });
  const board = useQuery({ queryKey: ['hub-board', boardName], queryFn: () => api.board(boardName), refetchInterval: 5000 });

  const tasks = board.data?.tasks ?? [];
  const doneCutoff = Date.now() / 1000 - 7 * 86400;
  const { refsByTask, resolved: notes } = useCardNotes(tasks);

  if (board.isError) return <HubError error={board.error} />;

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--rule)] px-3 py-2 text-sm">
          <select value={boardName} onChange={(e) => setBoardName(e.target.value)} aria-label="Board"
            className="rounded border border-[var(--rule)] bg-[var(--paper)] px-2 py-1 text-xs">
            {(boards.data?.boards ?? [{ slug: 'exo', name: 'Exo' }]).map((b) => (
              <option key={b.slug} value={b.slug}>{b.name}</option>
            ))}
          </select>
          <span className="text-xs text-[var(--ink-faint)]">{tasks.length} tasks · refreshes every 5 s</span>
          <button type="button" onClick={() => setShowNew((v) => !v)}
            className="ml-auto rounded bg-[var(--accent)] px-3 py-1 text-xs font-medium text-white">
            {showNew ? 'Close' : 'New task'}
          </button>
        </div>
        {showNew && <NewTask board={boardName} onCreated={(id) => { setShowNew(false); navigate(`/agents/board/${id}`); }} />}
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
          {COLUMNS.map((col) => {
            let rows = tasks.filter((t) => col.statuses.includes(t.status));
            if (col.key === 'done') rows = rows.filter((t) => (t.completed_at ?? t.created_at) > doneCutoff);
            rows.sort((a, b) => (b.completed_at ?? b.started_at ?? b.created_at) - (a.completed_at ?? a.started_at ?? a.created_at));
            return (
              <section key={col.key} className="flex w-64 shrink-0 flex-col">
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--ink-dim)]">
                  {col.label} <span className="font-normal text-[var(--ink-faint)]">{rows.length}</span>
                  {col.key === 'done' && <span className="font-normal normal-case text-[var(--ink-faint)]"> · last 7 days</span>}
                </h2>
                <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto">
                  {rows.map((t) => (
                    <li key={t.id} className={`rounded border hover:bg-[var(--paper-sunk)] ${taskId === t.id ? 'border-[var(--accent)]' : 'border-[var(--rule)]'}`}>
                      <button type="button" onClick={() => navigate(`/agents/board/${t.id}`)} className="w-full px-2 py-1.5 text-left text-sm">
                        <div className="line-clamp-3">{t.title}</div>
                        <div className="mt-1 flex items-center gap-2 text-xs text-[var(--ink-dim)]">
                          <AgentChip name={t.assignee} />
                          {t.status === 'running' && <span className="animate-pulse">●</span>}
                          <span className="ml-auto tabular-nums">{age(t.completed_at ?? t.started_at ?? t.created_at)}</span>
                        </div>
                      </button>
                      <CardNotes refs={refsByTask.get(t.id) ?? []} resolved={notes} />
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      </div>
      {taskId && <TaskPanel id={taskId} board={boardName} onClose={() => navigate('/agents/board')} />}
    </div>
  );
}

/** The vault notes a card's title, body or result names, by card; resolved in batches of 100 for the whole board. */
function useCardNotes(tasks: KanbanTask[]) {
  return useCardNotesFor(tasks.map((t) => ({ id: t.id, text: [t.title, t.body, t.result].filter(Boolean).join('\n\n') })));
}

/** The same, for any list of cards with a text to scan (the board module's page uses it too). */
export function useCardNotesFor(items: { id: string; text: string }[]) {
  const key = items.map((i) => `${i.id}:${i.text.length}`).join('|');
  const refsByTask = useMemo(
    () => new Map(items.map((i) => [i.id, collectVaultRefs(i.text)])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  const all = useMemo(() => [...new Set([...refsByTask.values()].flat())].sort(), [refsByTask]);
  const resolved = useQuery({
    queryKey: ['vault-resolve-board', all],
    queryFn: async () => {
      const out: Record<string, string | null> = {};
      for (let i = 0; i < all.length; i += 100) Object.assign(out, (await api.resolveRefs(all.slice(i, i + 100))).resolved);
      return out;
    },
    enabled: all.length > 0,
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });
  return { refsByTask, resolved: resolved.data ?? {} };
}

/** Links on a card tile to the notes it references; refs that aren't vault files are left out. */
export function CardNotes({ refs, resolved }: { refs: string[]; resolved: Record<string, string | null> }) {
  const paths = [...new Set(refs.map((r) => resolved[r]).filter((p): p is string => !!p))];
  if (!paths.length) return null;
  return (
    <div className="flex flex-wrap gap-1 px-2 pb-1.5" aria-label="Referenced notes">
      {paths.slice(0, 4).map((p) => (
        <Link key={p} to={fileHref(p)} title={p}
          className="max-w-full truncate rounded bg-[var(--paper-sunk)] px-1.5 py-0.5 text-[0.7rem] text-[var(--accent)] underline-offset-2 hover:underline">
          {p.split('/').pop()}
        </Link>
      ))}
      {paths.length > 4 && <span className="text-[0.7rem] text-[var(--ink-faint)]">+{paths.length - 4} more</span>}
    </div>
  );
}

function NewTask({ board, onCreated }: { board: string; onCreated: (id: string) => void }) {
  const queryClient = useQueryClient();
  const agents = useQuery({ queryKey: ['hub-agents'], queryFn: api.hubAgents, staleTime: 60_000 });
  const tg = useQuery({ queryKey: ['telegram'], queryFn: api.telegram, staleTime: 30_000 });
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [assignee, setAssignee] = useState('');
  const [project, setProject] = useState('');
  const [feature, setFeature] = useState('');
  const lanes = agents.data?.lanes ?? [];
  const bots = agents.data?.bots ?? [];
  const isBot = bots.some((b) => b.name === assignee);
  const projects = useQuery({ queryKey: ['projects', 'report'], queryFn: api.projectsReport, staleTime: 60_000, enabled: isBot });
  const features = projects.data?.projects.find((p) => p.slug === project)?.features ?? [];
  const profiles = (agents.data?.profiles ?? []).filter((p) => !MONEY.has(p.name) && p.name !== 'default');
  // Default agent from the nav toggle: the Claude writer or the Hermes researcher.
  const fallback = tg.data?.default === 'hermes' ? 'researcher' : 'cc-writer';
  const chosen = assignee || fallback;
  const create = useMutation({
    mutationFn: () => api.createTask({ board, title, body, assignee: chosen, ...(isBot ? { project, feature: feature || undefined } : {}) }),
    onSuccess: (t) => {
      void queryClient.invalidateQueries({ queryKey: ['hub-board', board] });
      onCreated(t.id);
    },
  });
  const option = (a: HubAgent) => (
    <option key={a.name} value={a.name}>{a.name}{a.description ? ` — ${a.description.slice(0, 60)}` : ''}</option>
  );
  return (
    <form className="space-y-2 border-b border-[var(--rule)] bg-[var(--paper-sunk)] p-3"
      onSubmit={(e) => { e.preventDefault(); if (title.trim()) create.mutate(); }}>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What should be done?" maxLength={200}
        className="w-full rounded border border-[var(--rule)] bg-[var(--paper)] px-2 py-1.5 text-sm" autoFocus />
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} placeholder="Details, links, where to put the result (optional)"
        className="w-full rounded border border-[var(--rule)] bg-[var(--paper)] px-2 py-1.5 text-sm" />
      <div className="flex flex-wrap items-center gap-2">
        <select value={chosen} onChange={(e) => setAssignee(e.target.value)} aria-label="Agent"
          className="max-w-full rounded border border-[var(--rule)] bg-[var(--paper)] px-2 py-1 text-xs">
          <optgroup label="Claude Code">{lanes.map(option)}</optgroup>
          <optgroup label="Hermes">{profiles.map(option)}</optgroup>
          {bots.length > 0 && <optgroup label="Bots (the org)">{bots.map((a) => <option key={a.name} value={a.name}>{a.name}{a.team ? ` · ${a.team}` : ''}{a.description ? ` — ${a.description.slice(0, 40)}` : ''}</option>)}</optgroup>}
        </select>
        {isBot && (
          <>
            <select aria-label="Project" value={project} onChange={(e) => { setProject(e.target.value); setFeature(''); }}
              className="rounded border border-[var(--rule)] bg-[var(--paper)] px-2 py-1 text-xs">
              <option value="">project (required for a bot)…</option>
              {(projects.data?.projects ?? []).map((p) => <option key={p.slug} value={p.slug}>{p.slug}</option>)}
            </select>
            <select aria-label="Feature" value={feature} onChange={(e) => setFeature(e.target.value)} disabled={!project}
              className="rounded border border-[var(--rule)] bg-[var(--paper)] px-2 py-1 text-xs">
              <option value="">feature (optional)</option>
              {features.map((f) => <option key={f.slug} value={f.slug}>{f.slug}</option>)}
            </select>
          </>
        )}
        <button type="submit" disabled={!title.trim() || create.isPending || (isBot && !project)}
          className="rounded bg-[var(--accent)] px-3 py-1 text-xs font-medium text-white disabled:opacity-50">
          {create.isPending ? 'Creating…' : `Give it to ${chosen}`}
        </button>
        {create.isError && <span className="text-xs text-[var(--warn)]">⚠ {create.error.message}</span>}
      </div>
    </form>
  );
}

function TaskPanel({ id, board, onClose }: { id: string; board: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: ['hub-task', board, id], queryFn: () => api.task(id, board), refetchInterval: 5000 });
  const meta = useQuery({ queryKey: ['meta'], queryFn: api.meta, staleTime: Infinity });
  const t: KanbanTask | undefined = detail.data?.task;
  const isClaude = family(t?.assignee ?? null) === 'claude';
  const log = useEventLog(isClaude ? `task:${id}` : null, (off) => api.taskLog(id, off), t?.status === 'running');
  const [comment, setComment] = useState('');
  const send = useMutation({
    mutationFn: () => api.commentTask(id, board, comment),
    onSuccess: () => {
      setComment('');
      void queryClient.invalidateQueries({ queryKey: ['hub-task', board, id] });
    },
  });

  return (
    <aside className="flex w-full max-w-xl shrink-0 flex-col border-l border-[var(--rule)] max-md:fixed max-md:inset-0 max-md:z-20 max-md:max-w-none max-md:bg-[var(--paper)]">
      <div className="flex items-center gap-2 border-b border-[var(--rule)] px-3 py-2">
        <code className="text-xs text-[var(--ink-faint)]">{id}</code>
        {t && <AgentChip name={t.assignee} />}
        {t && <span className="text-xs text-[var(--ink-dim)]">{t.status}</span>}
        <button type="button" onClick={onClose} className="ml-auto text-sm text-[var(--ink-dim)] hover:text-[var(--ink)]" aria-label="Close">✕</button>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
        {detail.isError && <HubError error={detail.error} />}
        {t && (
          <>
            <h2 className="text-base font-semibold">{t.title}</h2>
            {t.body && <VaultMarkdown text={t.body} />}
            {t.result && (
              <section className="rounded border border-[var(--rule)] p-2">
                <h3 className="text-xs font-semibold uppercase text-[var(--ink-dim)]">Result</h3>
                <VaultMarkdown text={t.result} />
                {detail.data?.latest_summary && detail.data.latest_summary !== t.result && (
                  <VaultMarkdown text={`Handoff: ${detail.data.latest_summary}`} className="mt-1 text-xs text-[var(--ink-dim)]" />
                )}
              </section>
            )}
            {t.status !== 'done' && t.status !== 'archived' && t.status !== 'running' && <AssignForm id={id} board={board} current={t.assignee} />}
            {(detail.data?.children.length ?? 0) > 0 && (
              <p className="text-xs">Child tasks: {detail.data!.children.map((c) => (
                <Link key={c} to={`/agents/board/${c}`} className="mr-2 text-[var(--accent)] underline">{c}</Link>
              ))}</p>
            )}
            {isClaude && (
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase text-[var(--ink-dim)]">Worker log</h3>
                {log.events.length === 0 ? <p className="text-xs text-[var(--ink-faint)]">{t.status === 'ready' ? 'Waiting for cc-dispatcher to pick it up (polls every 30 s).' : 'No log yet.'}</p>
                  : <EventFeed events={log.events} working={t.status === 'running'} />}
              </section>
            )}
            <section>
              <h3 className="mb-1 text-xs font-semibold uppercase text-[var(--ink-dim)]">Comments</h3>
              <ul className="space-y-1">
                {detail.data?.comments.map((c, i) => (
                  <li key={i} className="text-sm">
                    <b className="font-medium">{c.author}</b>{' '}
                    <span className="text-xs text-[var(--ink-faint)]">{age(c.created_at)}</span>
                    <VaultMarkdown text={c.body} breaks />
                  </li>
                ))}
              </ul>
              <form className="mt-2 flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (comment.trim() && !send.isPending) send.mutate(); }}>
                <ChatInput value={comment} onChange={setComment} label="Comment" placeholder={`Comment as ${meta.data?.owner ?? 'owner'} (Enter sends, Shift+Enter for a new line)`}
                  onSubmit={() => { if (comment.trim() && !send.isPending) send.mutate(); }} />
                <button type="submit" disabled={!comment.trim() || send.isPending} className="rounded border border-[var(--rule)] px-3 py-2 text-sm">Send</button>
              </form>
            </section>
            <details className="text-xs text-[var(--ink-dim)]">
              <summary className="cursor-pointer">Events ({detail.data?.events.length ?? 0})</summary>
              <ul className="mt-1 space-y-0.5">
                {detail.data?.events.map((e, i) => <li key={i}>{age(e.created_at)} · {e.kind}</li>)}
              </ul>
            </details>
          </>
        )}
      </div>
    </aside>
  );
}

/**
 * Moves an open card to a lane, a Hermes profile or a bot. A bot's card needs the tracker project (and
 * optionally a feature): the hub runs `cli-org task assign`, which writes the link row, sets the feature's
 * owner, comments the closing commands on the card and mentions the bot in its team channel.
 */
function AssignForm({ id, board, current }: { id: string; board: string; current: string | null }) {
  const queryClient = useQueryClient();
  const agents = useQuery({ queryKey: ['hub-agents'], queryFn: api.hubAgents, staleTime: 60_000 });
  const [assignee, setAssignee] = useState('');
  const [project, setProject] = useState('');
  const [feature, setFeature] = useState('');
  const bots = agents.data?.bots ?? [];
  const isBot = bots.some((b) => b.name === assignee);
  const projects = useQuery({ queryKey: ['projects', 'report'], queryFn: api.projectsReport, staleTime: 60_000, enabled: isBot });
  const features = projects.data?.projects.find((p) => p.slug === project)?.features ?? [];
  const assign = useMutation({
    mutationFn: () => api.assignTask(id, { board, assignee, ...(isBot ? { project, feature: feature || undefined } : {}) }),
    onSuccess: () => {
      setAssignee('');
      void queryClient.invalidateQueries({ queryKey: ['hub-task', board, id] });
      void queryClient.invalidateQueries({ queryKey: ['hub-board', board] });
    },
  });
  return (
    <form className="flex flex-wrap items-center gap-2 rounded border border-[var(--rule)] p-2 text-xs"
      onSubmit={(e) => { e.preventDefault(); if (assignee && (!isBot || project)) assign.mutate(); }}>
      <label className="text-[var(--ink-dim)]" htmlFor={`assign-${id}`}>Give to</label>
      <select id={`assign-${id}`} value={assignee} onChange={(e) => { setAssignee(e.target.value); setProject(''); setFeature(''); }}
        className="rounded border border-[var(--rule)] bg-[var(--paper)] px-2 py-1">
        <option value="">{current ? `now ${current}…` : 'unassigned…'}</option>
        {bots.length > 0 && <optgroup label="Bots (the org)">{bots.map((a) => <option key={a.name} value={a.name}>{a.name}{a.team ? ` · ${a.team}` : ''}</option>)}</optgroup>}
        <optgroup label="Claude Code lanes">{(agents.data?.lanes ?? []).map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}</optgroup>
        <optgroup label="Hermes profiles">{(agents.data?.profiles ?? []).filter((a) => !MONEY.has(a.name)).map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}</optgroup>
        {current && <option value="none">nobody (unassign)</option>}
      </select>
      {isBot && (
        <>
          <select aria-label="Project" value={project} onChange={(e) => { setProject(e.target.value); setFeature(''); }}
            className="rounded border border-[var(--rule)] bg-[var(--paper)] px-2 py-1">
            <option value="">project (required)…</option>
            {(projects.data?.projects ?? []).map((p) => <option key={p.slug} value={p.slug}>{p.slug}</option>)}
          </select>
          <select aria-label="Feature" value={feature} onChange={(e) => setFeature(e.target.value)} disabled={!project}
            className="rounded border border-[var(--rule)] bg-[var(--paper)] px-2 py-1">
            <option value="">feature (optional)…</option>
            {features.map((f) => <option key={f.slug} value={f.slug}>{f.slug}</option>)}
          </select>
        </>
      )}
      <button type="submit" disabled={!assignee || assign.isPending || (isBot && !project)}
        className="rounded bg-[var(--accent)] px-2 py-1 font-medium text-white disabled:opacity-50">
        {assign.isPending ? 'Giving…' : 'Give'}
      </button>
      {assign.isError && <span className="text-[var(--danger,#b00)]">{(assign.error as Error).message}</span>}
      {assign.isSuccess && <span className="text-[var(--ink-dim)]">done</span>}
    </form>
  );
}
