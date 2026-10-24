import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { VaultMarkdown } from '../../components/VaultMarkdown.js';
import { api, type AgentMessage, type AgentSession } from '../../lib/api.js';
import { ago, zoned } from '../../lib/time.js';

/**
 * The Agents page's History tab. Every Hermes conversation: Telegram chats with each bot, cron runs,
 * subagent delegations and API calls. Copied from Hermes on the droplet by
 * `secondbrain agents-sync` (every 10 minutes), kept even after Hermes prunes
 * its own copy. Times show in the zone Hermes was set to, with the zone named.
 */

const PLATFORMS: { key: string; label: string }[] = [
  { key: 'telegram', label: 'Telegram' },
  { key: 'cron', label: 'Cron' },
  { key: 'subagent', label: 'Subagents' },
  { key: 'api_server', label: 'API' },
  { key: '', label: 'All' },
];

function sessionName(s: AgentSession): string {
  if (s.platform === 'telegram') return `${s.display_name ?? 'Telegram'}${s.chat_type ? ` (${s.chat_type})` : ''}`;
  return s.title ?? s.external_id;
}

export default function History() {
  const navigate = useNavigate();
  const { id } = useParams();
  const selected = id ? Number(id) : null;
  const [platform, setPlatform] = useState('telegram');
  const [profile, setProfile] = useState('');

  const chats = useQuery({
    queryKey: ['agent-chats', platform, profile],
    queryFn: () => api.agentChats({ platform: platform || undefined, profile: profile || undefined }),
  });
  const facets = chats.data?.facets ?? [];
  const count = (p: string) => facets.filter((f) => !p || f.platform === p).reduce((n, f) => n + f.n, 0);
  const profiles = [...new Set(facets.map((f) => f.profile))].sort();

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-80 shrink-0 flex-col border-r border-[var(--rule)]">
        <div className="space-y-2 border-b border-[var(--rule)] p-3">
          <div className="flex flex-wrap gap-1">
            {PLATFORMS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => setPlatform(p.key)}
                className={`rounded px-2 py-0.5 text-xs ${platform === p.key ? 'bg-[var(--paper-sunk)] text-[var(--ink)]' : 'text-[var(--ink-dim)] hover:text-[var(--ink)]'}`}
              >
                {p.label} <span className="text-[var(--ink-faint)]">{count(p.key)}</span>
              </button>
            ))}
          </div>
          <select
            value={profile}
            onChange={(e) => setProfile(e.target.value)}
            className="w-full rounded border border-[var(--rule)] bg-[var(--paper)] px-2 py-1 text-xs"
            aria-label="Bot profile"
          >
            <option value="">All bots</option>
            {profiles.map((p) => (
              <option key={p} value={p}>{p === 'main' ? 'main (Hermes)' : p}</option>
            ))}
          </select>
          <div className="text-xs text-[var(--ink-faint)]">
            {chats.data?.last_sync ? `synced ${ago(chats.data.last_sync.ran_at)}` : 'not synced yet'}
          </div>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {chats.isError && <li className="p-3 text-sm">⚠ {chats.error.message}</li>}
          {chats.data?.sessions.length === 0 && <li className="p-3 text-sm text-[var(--ink-dim)]">No conversations.</li>}
          {chats.data?.sessions.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => navigate(`/agents/history/${s.id}`)}
                className={`w-full border-b border-[var(--rule)] px-3 py-2 text-left text-sm hover:bg-[var(--paper-sunk)] ${selected === s.id ? 'bg-[var(--paper-sunk)]' : ''}`}
              >
                <div className="truncate font-medium">{sessionName(s)}</div>
                <div className="flex gap-2 text-xs text-[var(--ink-dim)]">
                  <span>{s.profile}</span>
                  <span>{s.platform}</span>
                  <span className="ml-auto tabular-nums">{s.message_count} msgs</span>
                </div>
                <div className="text-xs text-[var(--ink-faint)]">{zoned(s.started_at, s.timezone)}</div>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section className="min-w-0 flex-1 overflow-y-auto">
        {selected ? <Thread id={selected} /> : (
          <p className="p-6 text-sm text-[var(--ink-dim)]">Pick a conversation on the left.</p>
        )}
      </section>
    </div>
  );
}

function Thread({ id }: { id: number }) {
  const chat = useQuery({ queryKey: ['agent-chat', id], queryFn: () => api.agentChat(id) });
  if (chat.isPending) return <p className="p-6 text-sm text-[var(--ink-dim)]">Loading…</p>;
  if (chat.isError) return <p className="p-6 text-sm">⚠ {chat.error.message}</p>;
  const { session: s, messages } = chat.data;
  return (
    <div className="mx-auto max-w-3xl px-6 py-5">
      <h1 className="text-lg font-semibold tracking-tight">{sessionName(s)}</h1>
      <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--ink-dim)]">
        <div>bot <b className="font-medium text-[var(--ink)]">{s.profile}</b></div>
        <div>via <b className="font-medium text-[var(--ink)]">{s.platform ?? '—'}</b></div>
        {s.chat_id && <div>chat {s.chat_id}</div>}
        {s.model && <div>model {s.model}</div>}
        <div>started {zoned(s.started_at, s.timezone, { seconds: true })}</div>
        <div>timezone {s.timezone ?? 'UTC'}</div>
        <div>session <code>{s.external_id}</code></div>
      </dl>
      {s.platform === 'cron' && (
        <p className="mt-2 text-xs">
          <Link className="text-[var(--accent)] underline" to="/cron">See this job on the Cron page</Link>
        </p>
      )}
      <ol className="mt-5 space-y-3">
        {messages.map((m) => (
          <Message key={m.seq} m={m} tz={s.timezone} />
        ))}
      </ol>
    </div>
  );
}

function Message({ m, tz }: { m: AgentMessage; tz: string | null }) {
  const time = <span className="text-xs text-[var(--ink-faint)]">{zoned(m.ts, tz, { seconds: true })}</span>;
  if (m.role === 'tool') {
    return (
      <li>
        <details className="rounded border border-[var(--rule)] px-3 py-1 text-xs">
          <summary className="cursor-pointer text-[var(--ink-dim)]">
            tool result{m.tool_name ? ` · ${m.tool_name}` : ''} · {time}
          </summary>
          <pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-words">{m.content}</pre>
        </details>
      </li>
    );
  }
  const mine = m.role === 'user';
  return (
    <li className={`rounded-lg border border-[var(--rule)] px-3 py-2 ${mine ? 'bg-[var(--paper-sunk)]' : ''}`}>
      <div className="mb-1 flex items-baseline gap-2 text-xs">
        <b className="font-semibold">{mine ? 'You' : m.role === 'assistant' ? 'Agent' : m.role}</b>
        {time}
      </div>
      {m.content && <VaultMarkdown text={m.content} />}
      {m.reasoning && (
        <details className="mt-1 text-xs text-[var(--ink-dim)]">
          <summary className="cursor-pointer">reasoning</summary>
          <pre className="whitespace-pre-wrap break-words">{m.reasoning}</pre>
        </details>
      )}
      {m.tool_calls && (
        <details className="mt-1 text-xs text-[var(--ink-dim)]">
          <summary className="cursor-pointer">tool calls</summary>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words">{m.tool_calls}</pre>
        </details>
      )}
    </li>
  );
}
