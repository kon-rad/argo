import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, NavLink, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, type OrgApproval, type OrgChannel, type OrgChartAgent, type OrgMessage, type OrgWakeup, type UsageFacetValue } from '../../lib/api.js';
import { formatTokens } from '../usage/format.js';
import { ago, zoned } from '../../lib/time.js';
import { useStickToBottom } from '../../lib/useStickToBottom.js';
import { ChatInput } from '../../components/ChatInput.js';
import { VaultMarkdown } from '../../components/VaultMarkdown.js';

/**
 * The agent company: Argo's named agents on teams, talking in channels and DMs
 * stored in the server's Postgres (org_* tables), read here as the owner.
 * Channels is the default view (Discord-shaped: channels left, messages middle,
 * members right); Org chart lists teams and agents with their wake budget;
 * Live is every channel as one feed, and `?kiosk=1` strips the chrome for the
 * TV. An agent's page shows its definition, inbox, runs, posts and memory file.
 */

const tab = ({ isActive }: { isActive: boolean }): string =>
  `px-3 py-1.5 text-sm border-b-2 ${isActive ? 'border-[var(--accent)] text-[var(--ink)]' : 'border-transparent text-[var(--ink-dim)] hover:text-[var(--ink)]'}`;
const POLL_MS = 5000;
const KIND_LABEL: Record<string, string> = {
  message: '', status: 'status', decision: 'decision', handoff: 'handoff', 'question-for-owner': 'question for you',
  standup: 'stand-up', reflection: 'reflection', reply: '',
};

/** A stable colour per team so an author's chip says where they sit without a legend. */
export function teamColor(team: string | null): string {
  if (!team) return 'var(--ink-dim)';
  let h = 0;
  for (const c of team) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 50% 42%)`;
}

export function channelLabel(slug: string): string {
  if (slug.startsWith('dm:')) return slug.slice(3).split(':').join(' ↔ ');
  return `#${slug}`;
}

function useTeams(): Map<string, string | null> {
  const chart = useQuery({ queryKey: ['org', 'chart'], queryFn: api.orgChart, staleTime: 60_000 });
  return useMemo(() => new Map((chart.data?.agents ?? []).map((a) => [a.name, a.team_slug])), [chart.data]);
}

function AuthorChip({ name, team }: { name: string; team: string | null }) {
  return (
    <Link to={`/org/agents/${name}`} className="rounded px-1.5 py-0.5 text-[0.7rem] font-medium text-white" style={{ background: teamColor(team) }}>
      {name}
    </Link>
  );
}

function KindChip({ kind, urgent }: { kind: string; urgent: boolean }) {
  const label = KIND_LABEL[kind] ?? kind;
  if (!label && !urgent) return null;
  const strong = kind === 'question-for-owner' || kind === 'handoff' || urgent;
  return (
    <span className={`rounded border px-1 text-[0.65rem] ${strong ? 'border-[var(--warn)] text-[var(--warn)]' : 'border-[var(--rule)] text-[var(--ink-dim)]'}`}>
      {urgent ? 'URGENT ' : ''}{label}
    </span>
  );
}

function MessageCard({ m, teams, showChannel, big }: { m: OrgMessage; teams: Map<string, string | null>; showChannel?: boolean; big?: boolean }) {
  return (
    <article className={`rounded border border-[var(--rule)] bg-[var(--paper)] ${big ? 'p-4 text-lg' : 'p-2 text-sm'}`} data-testid="org-message">
      <div className="flex flex-wrap items-center gap-2">
        <AuthorChip name={m.author} team={teams.get(m.author) ?? null} />
        <KindChip kind={m.kind} urgent={m.urgent} />
        {showChannel && <Link to={`/org?channel=${encodeURIComponent(m.channel_slug)}`} className="text-xs text-[var(--accent)]">{channelLabel(m.channel_slug)}</Link>}
        <span className="text-xs text-[var(--ink-faint)]" title={zoned(m.created_at, 'Asia/Tokyo')}>{ago(m.created_at)}</span>
        <span className="text-xs text-[var(--ink-faint)]">#{m.id}</span>
        {m.task_id && <Link to={`/agents/board/${m.task_id}`} className="text-xs text-[var(--accent)]">task {m.task_id}</Link>}
        {m.project_slug && (
          <Link to="/projects?view=board" className="text-xs text-[var(--accent)]">
            {m.project_slug}{m.feature_slug ? ` / ${m.feature_slug}` : ''}
          </Link>
        )}
      </div>
      <VaultMarkdown text={m.body} breaks className="mt-1 break-words text-sm" />
    </article>
  );
}

/** Messages in order, replies folded under their root when the root is on the page. */
function MessageList({ messages, teams, showChannel, big }: { messages: OrgMessage[]; teams: Map<string, string | null>; showChannel?: boolean; big?: boolean }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const roots = messages.filter((m) => !m.thread_id || !messages.some((r) => r.id === m.thread_id));
  const replies = new Map<number, OrgMessage[]>();
  for (const m of messages) {
    if (m.thread_id && messages.some((r) => r.id === m.thread_id)) replies.set(m.thread_id, [...(replies.get(m.thread_id) ?? []), m]);
  }
  if (!messages.length) return <p className="p-3 text-sm text-[var(--ink-faint)]">No messages yet.</p>;
  return (
    <div className="space-y-2">
      {roots.map((m) => {
        const rs = replies.get(m.id) ?? [];
        const shown = open.has(m.id);
        return (
          <div key={m.id}>
            <MessageCard m={m} teams={teams} showChannel={showChannel} big={big} />
            {rs.length > 0 && (
              <div className="ml-6 mt-1">
                <button type="button" className="text-xs text-[var(--accent)]" onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(m.id)) n.delete(m.id); else n.add(m.id); return n; })}>
                  {shown ? 'hide' : 'show'} {rs.length} {rs.length === 1 ? 'reply' : 'replies'}
                </button>
                {shown && <div className="mt-1 space-y-1">{rs.map((r) => <MessageCard key={r.id} m={r} teams={teams} big={big} />)}</div>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Composer({ channel, thread, onDone }: { channel: string; thread?: number; onDone?: () => void }) {
  const qc = useQueryClient();
  const [body, setBody] = useState('');
  const send = useMutation({
    mutationFn: () => api.orgPost({ channel, body, thread }),
    onSuccess: () => {
      setBody('');
      void qc.invalidateQueries({ queryKey: ['org'] });
      onDone?.();
    },
  });
  const submit = (): void => {
    if (body.trim() && !send.isPending) send.mutate();
  };
  return (
    <form
      className="flex items-end gap-2 border-t border-[var(--rule)] p-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <ChatInput
        label={`Message ${channelLabel(channel)}`}
        placeholder={`Post in ${channelLabel(channel)} as yourself (Enter posts, Shift+Enter for a new line)`}
        value={body}
        onChange={setBody}
        onSubmit={submit}
      />
      <button type="submit" disabled={!body.trim() || send.isPending} className="rounded bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50">
        Post
      </button>
      {send.isError && <span className="self-center text-xs text-[var(--warn)]">{send.error.message}</span>}
    </form>
  );
}

const GROUPS: { kind: OrgChannel['kind']; label: string }[] = [
  { kind: 'team', label: 'Teams' },
  { kind: 'shared', label: 'Shared' },
  { kind: 'dm', label: 'DMs' },
];

function Channels() {
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const teams = useTeams();
  const channels = useQuery({ queryKey: ['org', 'channels'], queryFn: api.orgChannels, refetchInterval: POLL_MS });
  const list = channels.data?.channels ?? [];
  const wanted = params.get('channel');
  const current = wanted && list.some((c) => c.slug === wanted) ? wanted : list.find((c) => c.slug === 'all-hands')?.slug ?? list[0]?.slug ?? null;
  const [showMembers, setShowMembers] = useState(false);
  const [q, setQ] = useState('');
  const search = useQuery({ queryKey: ['org', 'search', q], queryFn: () => api.orgSearch(q), enabled: q.trim().length > 1 });

  const messages = useQuery({
    queryKey: ['org', 'messages', current],
    queryFn: () => api.orgMessages({ channel: current!, limit: 100 }),
    enabled: current !== null,
    refetchInterval: POLL_MS,
  });
  const members = useQuery({ queryKey: ['org', 'members', current], queryFn: () => api.orgMembers(current!), enabled: current !== null, staleTime: 60_000 });

  // Opening a channel clears its unread dot (the owner's own read cursor on the board).
  const newest = messages.data?.cursor ?? 0;
  const unread = list.find((c) => c.slug === current)?.unread ?? 0;
  useEffect(() => {
    if (!current || !unread || !messages.data) return;
    void api.orgMarkRead(current).then(() => qc.invalidateQueries({ queryKey: ['org', 'channels'] }));
  }, [current, unread, newest, messages.data, qc]);

  const pick = (slug: string): void => setParams({ channel: slug });
  const searching = q.trim().length > 1;
  // Opens at the newest message; a search result list reads from the top instead.
  const scroller = useStickToBottom(searching ? null : `channel:${current}:${messages.isSuccess}`);

  if (channels.isError) return <p className="p-4 text-sm">⚠ {channels.error.message}</p>;
  return (
    <div className="flex h-full min-h-0">
      <aside className="hidden w-56 shrink-0 overflow-y-auto border-r border-[var(--rule)] p-2 md:block" aria-label="Channels">
        {GROUPS.map((g) => {
          const rows = list.filter((c) => c.kind === g.kind);
          if (!rows.length) return null;
          return (
            <div key={g.kind} className="mb-3">
              <div className="mb-1 px-1 text-[0.65rem] font-semibold uppercase tracking-wide text-[var(--ink-faint)]">{g.label}</div>
              {rows.map((c) => (
                <button
                  key={c.slug}
                  type="button"
                  onClick={() => pick(c.slug)}
                  className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm ${c.slug === current ? 'bg-[var(--paper-sunk)] text-[var(--ink)]' : 'text-[var(--ink-dim)] hover:text-[var(--ink)]'}`}
                  title={c.purpose ?? undefined}
                >
                  <span className="min-w-0 flex-1 truncate">{channelLabel(c.slug)}</span>
                  {c.unread > 0 && <span className="rounded-full bg-[var(--accent)] px-1.5 text-[0.65rem] font-medium text-white" aria-label={`${c.unread} unread`}>{c.unread}</span>}
                </button>
              ))}
            </div>
          );
        })}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--rule)] px-3 py-2 text-sm">
          <select aria-label="Channel" value={current ?? ''} onChange={(e) => pick(e.target.value)} className="rounded border border-[var(--rule)] bg-[var(--paper)] px-2 py-1 text-xs md:hidden">
            {list.map((c) => (
              <option key={c.slug} value={c.slug}>{channelLabel(c.slug)}{c.unread ? ` (${c.unread})` : ''}</option>
            ))}
          </select>
          {current && <span className="hidden font-semibold md:inline">{channelLabel(current)}</span>}
          <span className="hidden text-xs text-[var(--ink-dim)] md:inline">{list.find((c) => c.slug === current)?.purpose ?? ''}</span>
          <input aria-label="Search messages" className="ml-auto w-40 rounded border border-[var(--rule)] bg-transparent px-2 py-1 text-xs" placeholder="search the board" value={q} onChange={(e) => setQ(e.target.value)} />
          <button type="button" className="text-xs text-[var(--accent)] lg:hidden" onClick={() => setShowMembers((v) => !v)}>
            {members.data ? `${members.data.members.length} members` : 'members'}
          </button>
        </div>
        <div ref={scroller.ref} className="min-h-0 flex-1 overflow-y-auto p-3" data-testid="channel-messages">
          {searching ? (
            <>
              <div className="mb-2 text-xs text-[var(--ink-dim)]">{search.data ? `${search.data.messages.length} matches for "${q}"` : 'searching…'}</div>
              <MessageList messages={search.data?.messages ?? []} teams={teams} showChannel />
            </>
          ) : messages.isError ? (
            <p className="text-sm">⚠ {messages.error.message}</p>
          ) : (
            <MessageList messages={messages.data?.messages ?? []} teams={teams} />
          )}
        </div>
        {current && <Composer channel={current} onDone={scroller.pin} />}
      </div>

      {current && (
        <aside className={`${showMembers ? 'block' : 'hidden'} w-48 shrink-0 overflow-y-auto border-l border-[var(--rule)] p-2 lg:block`} aria-label="Members">
          <div className="mb-1 px-1 text-[0.65rem] font-semibold uppercase tracking-wide text-[var(--ink-faint)]">Members</div>
          {(members.data?.members ?? []).map((m) => (
            <div key={m.agent_name} className="flex items-center gap-2 px-1 py-0.5 text-xs">
              <AuthorChip name={m.agent_name} team={m.team_slug} />
              <span className="min-w-0 truncate text-[var(--ink-dim)]">{m.role}</span>
            </div>
          ))}
        </aside>
      )}
    </div>
  );
}

function Chart() {
  const chart = useQuery({ queryKey: ['org', 'chart'], queryFn: api.orgChart, refetchInterval: 30_000 });
  if (chart.isError) return <p className="p-4 text-sm">⚠ {chart.error.message}</p>;
  const d = chart.data;
  if (!d) return null;
  const human = d.agents.find((a) => a.runtime === 'human');
  const card = (a: OrgChartAgent) => (
    <Link key={a.name} to={`/org/agents/${a.name}`} className="block rounded border border-[var(--rule)] bg-[var(--paper)] p-2 text-sm hover:border-[var(--accent)]">
      <div className="flex items-center gap-2">
        <span className="rounded px-1.5 py-0.5 text-[0.7rem] font-medium text-white" style={{ background: teamColor(a.team_slug) }}>{a.name}</span>
        <span className="font-medium">{a.role}</span>
        {a.is_lead && <span className="text-[0.65rem] text-[var(--ink-faint)]">lead</span>}
      </div>
      <div className="mt-1 text-xs text-[var(--ink-dim)]">
        {a.runtime}{a.model ? ` · ${a.model}` : ''}{a.reports_to ? ` · reports to ${a.reports_to}` : ''}
      </div>
      {a.runtime !== 'human' && a.activity && (
        <div className="mt-1 text-xs text-[var(--ink-dim)]">
          last wake {a.activity.last_wake ? ago(a.activity.last_wake) : 'never'} · {a.activity.wakes_today}{a.caps ? `/${a.caps.wakes_per_day}` : ''} wakes today
          {a.activity.open_wakeups ? ` · ${a.activity.open_wakeups} waiting` : ''}
          {a.activity.unread ? ` · ${a.activity.unread} unread` : ''}
        </div>
      )}
    </Link>
  );
  return (
    <div className="h-full overflow-y-auto p-4">
      {human && <div className="mb-4 max-w-sm">{card(human)}</div>}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {d.teams.map((t) => {
          const members = d.agents.filter((a) => a.team_slug === t.slug);
          const lead = members.find((a) => a.is_lead);
          return (
            <section key={t.slug} className="rounded border border-[var(--rule)] p-2">
              <h2 className="mb-2 flex items-center gap-2 font-semibold tracking-tight">
                <span className="inline-block h-3 w-3 rounded-full" style={{ background: teamColor(t.slug) }} aria-hidden />
                {t.name}
                <Link to={`/org?channel=${t.slug}`} className="ml-auto text-xs font-normal text-[var(--accent)]">#{t.slug}</Link>
              </h2>
              <div className="space-y-2">
                {lead && card(lead)}
                {members.filter((a) => !a.is_lead).map(card)}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function Live() {
  const [params] = useSearchParams();
  const kiosk = params.get('kiosk') === '1';
  const teams = useTeams();
  const feed = useQuery({ queryKey: ['org', 'messages', 'live'], queryFn: () => api.orgMessages({ limit: kiosk ? 12 : 60 }), refetchInterval: POLL_MS });
  const list = feed.data?.messages ?? [];
  const live = useStickToBottom(`live:${feed.isSuccess}`);
  const body = feed.isError ? <p className="p-4">⚠ {feed.error.message}</p> : <MessageList messages={kiosk ? [...list].reverse() : list} teams={teams} showChannel big={kiosk} />;
  if (kiosk) {
    return (
      <div className="fixed inset-0 z-50 overflow-hidden bg-[var(--paper)] p-6" data-testid="kiosk">
        <div className="mb-3 flex items-baseline gap-3">
          <h1 className="text-2xl font-semibold">Argo · company board</h1>
          <span className="text-sm text-[var(--ink-dim)]">newest first · refreshes every 5 s</span>
        </div>
        {body}
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-[var(--rule)] px-3 py-2 text-xs text-[var(--ink-dim)]">
        Every channel, newest at the bottom, refreshes every 5 s.
        <Link to="/org/live?kiosk=1" className="ml-auto underline">TV mode</Link>
      </div>
      <div ref={live.ref} className="min-h-0 flex-1 overflow-y-auto p-3">{body}</div>
    </div>
  );
}

/**
 * Ship approvals: what the bots want to merge or deploy, waiting on the owner. Approving here is the same yes as
 * "approve <id>" on Telegram; a denial needs a reason the bot can act on. Shared facts are listed under it.
 */
function Approvals() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['org', 'approvals'], queryFn: () => api.orgApprovals(), refetchInterval: POLL_MS });
  const facts = useQuery({ queryKey: ['org', 'facts'], queryFn: () => api.orgFacts() });
  const [why, setWhy] = useState<Record<number, string>>({});
  const decide = useMutation({
    mutationFn: (v: { id: number; decision: 'approve' | 'deny'; note?: string }) => api.orgDecide(v.id, v.decision, v.note),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['org', 'approvals'] }),
  });
  const row = (a: OrgApproval) => (
    <li key={a.id} className="rounded border border-[var(--rule)] bg-[var(--paper)] p-2 text-sm" data-testid="approval">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-mono text-xs">#{a.id}</span>
        <span className={a.status === 'pending' ? 'font-semibold' : 'text-[var(--ink-dim)]'}>{a.status}{a.ship_now ? ' (ship-now)' : ''}</span>
        <Link className="text-[var(--accent)]" to={`/org/agents/${a.requested_by}`}>{a.requested_by}</Link>
        <Link className="text-xs text-[var(--accent)]" to={`/agents/board/${a.task_id}`}>{a.task_id}</Link>
        {a.pr_url && <a className="text-xs text-[var(--accent)] underline" href={a.pr_url} target="_blank" rel="noreferrer">PR</a>}
        {a.deploy_target && <span className="text-xs">deploy {a.deploy_target}</span>}
        <span className="ml-auto text-xs text-[var(--ink-dim)]">{ago(a.created_at)}</span>
      </div>
      <p className="mt-1 whitespace-pre-wrap">{a.summary}</p>
      {a.status === 'pending' ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <button className="rounded bg-[var(--accent)] px-2 py-1 text-xs text-white disabled:opacity-50" disabled={decide.isPending}
            onClick={() => decide.mutate({ id: a.id, decision: 'approve' })}>Approve</button>
          <input className="min-w-0 flex-1 rounded border border-[var(--rule)] bg-transparent px-2 py-1 text-xs" placeholder="why not (for a denial)"
            value={why[a.id] ?? ''} onChange={(e) => setWhy({ ...why, [a.id]: e.target.value })} />
          <button className="rounded border border-[var(--rule)] px-2 py-1 text-xs disabled:opacity-50" disabled={decide.isPending || !why[a.id]?.trim()}
            onClick={() => decide.mutate({ id: a.id, decision: 'deny', note: why[a.id] })}>Deny</button>
        </div>
      ) : a.decided_by ? <p className="mt-1 text-xs text-[var(--ink-dim)]">{a.decided_by}{a.note ? `: ${a.note}` : ''}</p> : null}
    </li>
  );
  const items = list.data ?? [];
  return (
    <div className="h-full overflow-y-auto p-3">
      <h2 className="mb-2 text-sm font-semibold">Waiting on you</h2>
      {list.isError ? <p>⚠ {list.error.message}</p> : null}
      {decide.isError ? <p className="text-sm">⚠ {decide.error.message}</p> : null}
      <ul className="space-y-2">{items.filter((a) => a.status === 'pending').map(row)}</ul>
      {!items.some((a) => a.status === 'pending') && <p className="text-sm text-[var(--ink-dim)]">Nothing to approve.</p>}
      <h2 className="mb-2 mt-5 text-sm font-semibold">Decided</h2>
      <ul className="space-y-2">{items.filter((a) => a.status !== 'pending').slice(0, 20).map(row)}</ul>
      <h2 className="mb-2 mt-5 text-sm font-semibold">Shared facts</h2>
      <ul className="space-y-1 text-sm">
        {(facts.data ?? []).map((f) => (
          <li key={f.id}><span className="font-mono text-xs">#{f.id}</span> <b>{f.subject}</b>: {f.claim} <span className="text-xs text-[var(--ink-dim)]">({f.confidence}, {f.source}, {f.author})</span></li>
        ))}
      </ul>
    </div>
  );
}

/** Seven days of the bot's tokens by what woke it and what it did; the link opens /usage filtered to it. */
function UsageStrip({ name }: { name: string }) {
  const [from, to] = useMemo(() => {
    const end = new Date(Math.ceil(Date.now() / 3600_000) * 3600_000);
    return [new Date(end.getTime() - 7 * 86400_000).toISOString(), end.toISOString()];
  }, []);
  const q = useQuery({ queryKey: ['usage-facets', from, to, name], queryFn: () => api.usageFacets(from, to, { agent: [name] }), retry: false, staleTime: 60_000 });
  const facets = q.data?.facets;
  const row = (label: string, xs: UsageFacetValue[] | undefined) => (xs?.length ? (
    <div className="text-xs"><span className="text-[var(--ink-dim)]">{label}: </span>{xs.map((x) => `${x.value} ${formatTokens(x.tokens)}`).join(' · ')}</div>
  ) : null);
  if (!q.data || !q.data.total?.calls) return <p className="text-sm text-[var(--ink-faint)]">No model calls in the last 7 days.</p>;
  return (
    <div className="space-y-1">
      <div className="text-sm">{formatTokens(q.data.total.tokens)} tokens in {q.data.total.calls} calls, last 7 days. <Link className="text-[var(--accent)]" to={`/usage?days=7&agent=${encodeURIComponent(name)}&group=action`}>Open in Usage</Link></div>
      {row('woken by', facets?.reason)}
      {row('did', facets?.action)}
      {row('projects', facets?.project)}
      {row('work', facets?.work_type)}
    </div>
  );
}

function RunRow({ w }: { w: OrgWakeup }) {
  const state = w.done_at ? 'done' : w.claimed_at ? 'running' : 'waiting';
  return (
    <li className="text-xs">
      <span className="text-[var(--ink-faint)]">{ago(w.created_at)}</span> <b>{w.reason}</b>{w.ref ? ` ${w.ref}` : ''} · {state}
      {w.claimed_by && <span className="text-[var(--ink-faint)]"> · {w.claimed_by}</span>}
      {w.result && <div className="ml-3 whitespace-pre-wrap text-[var(--ink-dim)]">{w.result.slice(0, 300)}</div>}
    </li>
  );
}

function AgentPage() {
  const { name = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const teams = useTeams();
  const page = useQuery({ queryKey: ['org', 'agent', name], queryFn: () => api.orgAgent(name), refetchInterval: 15_000 });
  // The kanban lives behind agent-hub on the droplet; on the Mac this answers 503 and the section stays empty.
  const board = useQuery({ queryKey: ['hub-board', 'exo'], queryFn: () => api.board('exo'), retry: false, staleTime: 30_000 });
  const links = useQuery({ queryKey: ['org', 'tasks', name], queryFn: () => api.orgTasks({ agent: name }), retry: false, staleTime: 30_000 });
  const projects = useQuery({ queryKey: ['projects', 'report'], queryFn: api.projectsReport, staleTime: 60_000, retry: false });
  const [dmText, setDmText] = useState('');
  const [cardTitle, setCardTitle] = useState('');
  const [cardProject, setCardProject] = useState('');
  const [cardFeature, setCardFeature] = useState('');
  const giveCard = useMutation({
    mutationFn: () => api.createTask({ board: 'exo', title: cardTitle, body: '', assignee: name, project: cardProject, feature: cardFeature || undefined }),
    onSuccess: () => {
      setCardTitle('');
      void qc.invalidateQueries({ queryKey: ['org'] });
      void qc.invalidateQueries({ queryKey: ['hub-board'] });
    },
  });
  const sendDm = useMutation({
    mutationFn: () => api.orgDm({ to: name, body: dmText }),
    onSuccess: (m) => {
      setDmText('');
      void qc.invalidateQueries({ queryKey: ['org'] });
      navigate(`/org?channel=${encodeURIComponent(m.channel_slug)}`);
    },
  });
  if (page.isError) return <p className="p-4 text-sm">⚠ {page.error.message}</p>;
  const p = page.data;
  if (!p) return null;
  const tasks = (board.data?.tasks ?? []).filter((t) => t.assignee === name);
  const linkOf = new Map((links.data?.tasks ?? []).map((l) => [l.task_id, l]));
  // Cards the kanban does not list (agent-hub down, or the Mac) still show from their link rows.
  const cardRows = [
    ...tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, link: linkOf.get(t.id) ?? null })),
    ...(links.data?.tasks ?? []).filter((l) => !tasks.some((t) => t.id === l.task_id)).map((l) => ({ id: l.task_id, title: l.title, status: 'card', link: l })),
  ];
  const projectList = projects.data?.projects ?? [];
  const featureList = projectList.find((pr) => pr.slug === cardProject)?.features ?? [];
  const section = (title: string, children: React.ReactNode) => (
    <section className="rounded border border-[var(--rule)] p-3">
      <h2 className="mb-2 font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <span className="rounded px-2 py-1 text-sm font-medium text-white" style={{ background: teamColor(p.agent.team_slug) }}>{p.agent.name}</span>
        <h1 className="text-lg font-semibold tracking-tight">{p.agent.role}</h1>
        <span className="text-sm text-[var(--ink-dim)]">
          {p.team ? `${p.team.name}${p.is_lead ? ', lead' : ''}` : 'no team'} · {p.agent.runtime}{p.agent.model ? ` · ${p.agent.model}` : ''}
          {p.agent.reports_to && ` · reports to `}
          {p.agent.reports_to && <Link className="text-[var(--accent)]" to={`/org/agents/${p.agent.reports_to}`}>{p.agent.reports_to}</Link>}
        </span>
        {p.caps && (
          <span className="text-xs text-[var(--ink-faint)]">
            {p.caps.wakes_per_day} wakes/day · {p.caps.cooldown_minutes} min cooldown · {p.caps.max_runtime_minutes} min max
            {p.caps.routines.length ? ` · ${p.caps.routines.map((r) => `${r.name} ${r.at ?? r.on ?? ''}`).join(', ')}` : ''}
          </span>
        )}
      </div>
      {p.reports.length > 0 && (
        <div className="mb-3 text-sm text-[var(--ink-dim)]">
          Reports: {p.reports.map((r, i) => <span key={r}>{i > 0 && ', '}<Link className="text-[var(--accent)]" to={`/org/agents/${r}`}>{r}</Link></span>)}
        </div>
      )}
      {p.agent.runtime !== 'human' && (
        <form
          className="mb-4 flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (dmText.trim() && !sendDm.isPending) sendDm.mutate();
          }}
        >
          <ChatInput label={`DM ${name}`} placeholder={`DM ${name} as yourself (wakes it; Enter sends, Shift+Enter for a new line)`} value={dmText} onChange={setDmText}
            onSubmit={() => { if (dmText.trim() && !sendDm.isPending) sendDm.mutate(); }} />
          <button type="submit" disabled={!dmText.trim() || sendDm.isPending} className="rounded bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50">Send</button>
          {sendDm.isError && <span className="self-center text-xs text-[var(--warn)]">{sendDm.error.message}</span>}
        </form>
      )}
      {p.agent.runtime !== 'human' && (
        <form
          className="mb-4 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (cardTitle.trim() && cardProject) giveCard.mutate();
          }}
        >
          <input aria-label={`Card for ${name}`} className="min-w-0 flex-1 rounded border border-[var(--rule)] bg-transparent px-2 py-1 text-sm" placeholder={`Give ${name} a card (one card, one bot, one project)`} maxLength={200} value={cardTitle} onChange={(e) => setCardTitle(e.target.value)} />
          <select aria-label="Project" className="rounded border border-[var(--rule)] bg-transparent px-1 py-1 text-xs" value={cardProject} onChange={(e) => { setCardProject(e.target.value); setCardFeature(''); }}>
            <option value="">project…</option>
            {projectList.map((pr) => <option key={pr.slug} value={pr.slug}>{pr.slug}</option>)}
          </select>
          <select aria-label="Feature" className="rounded border border-[var(--rule)] bg-transparent px-1 py-1 text-xs" value={cardFeature} onChange={(e) => setCardFeature(e.target.value)} disabled={!cardProject}>
            <option value="">feature (optional)</option>
            {featureList.map((f) => <option key={f.slug} value={f.slug}>{f.slug}</option>)}
          </select>
          <button type="submit" disabled={!cardTitle.trim() || !cardProject || giveCard.isPending} className="rounded bg-[var(--accent)] px-3 py-1 text-sm font-medium text-white disabled:opacity-50">Give card</button>
          {giveCard.isError && <span className="self-center text-xs text-[var(--warn)]">{giveCard.error.message}</span>}
          {giveCard.isSuccess && <span className="self-center text-xs text-[var(--ink-dim)]">card {giveCard.data.id} created</span>}
        </form>
      )}
      <div className="grid gap-3 lg:grid-cols-2">
        {section('Inbox', p.open_wakeups.length ? <ul className="space-y-1">{p.open_wakeups.map((w) => <RunRow key={w.id} w={w} />)}</ul> : <p className="text-sm text-[var(--ink-faint)]">Nothing waiting.</p>)}
        {section(`Channels`, (
          <ul className="flex flex-wrap gap-2 text-sm">
            {p.channels.map((c) => (
              <li key={c.slug}><Link className="text-[var(--accent)]" to={`/org?channel=${encodeURIComponent(c.slug)}`}>{channelLabel(c.slug)}</Link>{c.unread ? <span className="text-xs text-[var(--ink-dim)]"> ({c.unread} unread)</span> : null}</li>
            ))}
          </ul>
        ))}
        {section(`Runs (${p.runs.length})`, p.runs.length ? <ul className="space-y-1">{p.runs.map((w) => <RunRow key={w.id} w={w} />)}</ul> : <p className="text-sm text-[var(--ink-faint)]">Never woken.</p>)}
        {p.agent.runtime !== 'human' && section('Tokens', <UsageStrip name={name} />)}
        {section(`Cards (${cardRows.length})`, cardRows.length ? (
          <ul className="space-y-1 text-sm">
            {cardRows.map((t) => (
              <li key={t.id}>
                <Link className="text-[var(--accent)]" to={`/agents/board/${t.id}`}>{t.title}</Link>
                <span className="text-xs text-[var(--ink-dim)]"> {t.status}</span>
                {t.link?.project_slug && <span className="text-xs text-[var(--ink-dim)]"> · <Link className="text-[var(--accent)]" to="/projects?view=board">{t.link.project_slug}{t.link.feature_slug ? `/${t.link.feature_slug}` : ''}</Link></span>}
              </li>
            ))}
          </ul>
        ) : board.isError ? (
          <p className="text-xs text-[var(--ink-faint)]">No cards; the kanban itself is on the droplet.</p>
        ) : (
          <p className="text-sm text-[var(--ink-faint)]">No cards. Give one above.</p>
        ))}
        <div className="lg:col-span-2">{section('Posts', <MessageList messages={[...p.posts].reverse()} teams={teams} showChannel />)}</div>
        <div className="lg:col-span-2">
          {section(`Memory file (${p.memory_path}, read-only)`, p.memory ? (
            <article className="prose max-w-none text-sm"><ReactMarkdown remarkPlugins={[remarkGfm]}>{p.memory}</ReactMarkdown></article>
          ) : (
            <p className="text-sm text-[var(--ink-faint)]">No memory file yet; the agent writes it on its first wake (it reaches this machine with the vault).</p>
          ))}
        </div>
        <div className="lg:col-span-2">
          {section('Definition (compiled from .agents/org.yaml)', p.prompt ? (
            <article className="prose max-w-none text-sm"><ReactMarkdown remarkPlugins={[remarkGfm]}>{p.prompt}</ReactMarkdown></article>
          ) : (
            <p className="text-sm text-[var(--ink-faint)]">No compiled definition in this vault checkout.</p>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function Org() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <nav className="flex shrink-0 gap-1 border-b border-[var(--rule)] px-3" aria-label="Org">
        <NavLink to="/org" end className={tab}>Channels</NavLink>
        <NavLink to="/org/chart" className={tab}>Org chart</NavLink>
        <NavLink to="/org/live" className={tab}>Live</NavLink>
        <NavLink to="/org/approvals" className={tab}>Approvals</NavLink>
      </nav>
      <div className="min-h-0 flex-1">
        <Routes>
          <Route index element={<Channels />} />
          <Route path="chart" element={<Chart />} />
          <Route path="live" element={<Live />} />
          <Route path="approvals" element={<Approvals />} />
          <Route path="agents/:name" element={<AgentPage />} />
        </Routes>
      </div>
    </div>
  );
}
