import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, type HubAgent, type KanbanTask } from '../../lib/api.js';
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

  if (board.isError) return <HubError error={board.error} />;
  const tasks = board.data?.tasks ?? [];
  const doneCutoff = Date.now() / 1000 - 7 * 86400;

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
                    <li key={t.id}>
                      <button type="button" onClick={() => navigate(`/agents/board/${t.id}`)}
                        className={`w-full rounded border px-2 py-1.5 text-left text-sm hover:bg-[var(--paper-sunk)] ${taskId === t.id ? 'border-[var(--accent)]' : 'border-[var(--rule)]'}`}>
                        <div className="line-clamp-3">{t.title}</div>
                        <div className="mt-1 flex items-center gap-2 text-xs text-[var(--ink-dim)]">
                          <AgentChip name={t.assignee} />
                          {t.status === 'running' && <span className="animate-pulse">●</span>}
                          <span className="ml-auto tabular-nums">{age(t.completed_at ?? t.started_at ?? t.created_at)}</span>
                        </div>
                      </button>
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

function NewTask({ board, onCreated }: { board: string; onCreated: (id: string) => void }) {
  const queryClient = useQueryClient();
  const agents = useQuery({ queryKey: ['hub-agents'], queryFn: api.hubAgents, staleTime: 60_000 });
  const tg = useQuery({ queryKey: ['telegram'], queryFn: api.telegram, staleTime: 30_000 });
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [assignee, setAssignee] = useState('');
  const lanes = agents.data?.lanes ?? [];
  const profiles = (agents.data?.profiles ?? []).filter((p) => !MONEY.has(p.name) && p.name !== 'default');
  // Default agent from the nav toggle: the Claude writer or the Hermes researcher.
  const fallback = tg.data?.default === 'hermes' ? 'researcher' : 'cc-writer';
  const chosen = assignee || fallback;
  const create = useMutation({
    mutationFn: () => api.createTask({ board, title, body, assignee: chosen }),
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
        </select>
        <button type="submit" disabled={!title.trim() || create.isPending}
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
            {t.body && <div className="prose max-w-none text-sm"><ReactMarkdown remarkPlugins={[remarkGfm]}>{t.body}</ReactMarkdown></div>}
            {t.result && (
              <section className="rounded border border-[var(--rule)] p-2">
                <h3 className="text-xs font-semibold uppercase text-[var(--ink-dim)]">Result</h3>
                <div className="prose max-w-none text-sm"><ReactMarkdown remarkPlugins={[remarkGfm]}>{t.result}</ReactMarkdown></div>
                {detail.data?.latest_summary && detail.data.latest_summary !== t.result && (
                  <p className="mt-1 text-xs text-[var(--ink-dim)]">Handoff: {detail.data.latest_summary}</p>
                )}
              </section>
            )}
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
                    <div className="whitespace-pre-wrap">{c.body}</div>
                  </li>
                ))}
              </ul>
              <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (comment.trim()) send.mutate(); }}>
                <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder={`Comment as ${meta.data?.owner ?? 'owner'}`}
                  className="min-w-0 flex-1 rounded border border-[var(--rule)] bg-[var(--paper)] px-2 py-1 text-sm" />
                <button type="submit" disabled={!comment.trim() || send.isPending} className="rounded border border-[var(--rule)] px-2 text-xs">Send</button>
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
