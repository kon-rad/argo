import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { api, type ClaudeChat } from '../../lib/api.js';
import { useEventLog } from '../../lib/useEventLog.js';
import EventFeed from '../../components/EventFeed.js';
import HubError from './HubError.js';

/**
 * Chat with Claude Code on the droplet, in the vault, on the subscription: a terminal-style conversation that shows
 * each tool call as it happens. agent-hub keeps one `claude -p` per open chat and resumes it after it idles out,
 * so a chat started on the laptop continues on the Pi. Actions are reviewed by auto mode; anything that would need
 * a person to approve is denied (there's no approval UI yet).
 */
export default function Chat() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { chatId } = useParams();
  const chats = useQuery({ queryKey: ['claude-chats'], queryFn: api.claudeChats, refetchInterval: 10_000 });
  const [model, setModel] = useState('opus');
  const create = useMutation({
    mutationFn: () => api.newClaudeChat(model),
    onSuccess: (c) => {
      void queryClient.invalidateQueries({ queryKey: ['claude-chats'] });
      navigate(`/agents/chat/${c.id}`);
    },
  });

  if (chats.isError) return <HubError error={chats.error} />;
  const list = chats.data?.chats ?? [];

  return (
    <div className="flex h-full min-h-0">
      <aside className={`flex w-72 shrink-0 flex-col border-r border-[var(--rule)] ${chatId ? 'max-md:hidden' : 'max-md:w-full'}`}>
        <div className="flex items-center gap-2 border-b border-[var(--rule)] p-3">
          <select value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model"
            className="rounded border border-[var(--rule)] bg-[var(--paper)] px-2 py-1 text-xs">
            <option value="opus">Opus</option>
            <option value="sonnet">Sonnet</option>
            <option value="haiku">Haiku</option>
          </select>
          <button type="button" onClick={() => create.mutate()} disabled={create.isPending}
            className="ml-auto rounded px-3 py-1 text-xs font-medium text-white" style={{ background: 'var(--claude)' }}>
            New chat
          </button>
        </div>
        {create.isError && <p className="p-2 text-xs text-[var(--warn)]">⚠ {create.error.message}</p>}
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {list.length === 0 && <li className="p-3 text-sm text-[var(--ink-dim)]">No chats yet.</li>}
          {list.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => navigate(`/agents/chat/${c.id}`)}
                className={`w-full border-b border-[var(--rule)] px-3 py-2 text-left text-sm hover:bg-[var(--paper-sunk)] ${chatId === c.id ? 'bg-[var(--paper-sunk)]' : ''}`}>
                <div className="truncate font-medium">{c.title}</div>
                <div className="flex gap-2 text-xs text-[var(--ink-dim)]">
                  <span>{c.model}</span>
                  <StatusLabel c={c} />
                  <span className="ml-auto">{new Date(c.updated_at * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section className={`flex min-w-0 flex-1 flex-col ${chatId ? '' : 'max-md:hidden'}`}>
        {chatId ? <Conversation id={chatId} onBack={() => navigate('/agents/chat')} />
          : <p className="p-6 text-sm text-[var(--ink-dim)]">Start a new chat or pick one on the left. Claude works in the vault on the droplet.</p>}
      </section>
    </div>
  );
}

function StatusLabel({ c }: { c: ClaudeChat }) {
  const map = { working: ['working', 'var(--claude)'], idle: ['ready', 'var(--hermes)'], closed: ['asleep', 'var(--ink-faint)'], error: ['error', 'var(--warn)'] } as const;
  const [label, color] = map[c.status] ?? ['?', 'var(--ink-faint)'];
  return <span style={{ color }}>{label}</span>;
}

function Conversation({ id, onBack }: { id: string; onBack: () => void }) {
  const queryClient = useQueryClient();
  const [working, setWorking] = useState(false);
  const log = useEventLog(id, (off) => api.claudeChatEvents(id, off), working);
  const chat = log.last?.chat;
  useEffect(() => {
    if (chat) setWorking(chat.status === 'working');
  }, [chat?.status]);  // eslint-disable-line react-hooks/exhaustive-deps

  const [text, setText] = useState('');
  const send = useMutation({
    mutationFn: (t: string) => api.sendClaudeChat(id, t),
    onSuccess: () => {
      setText('');
      setWorking(true);
      log.poke();
      void queryClient.invalidateQueries({ queryKey: ['claude-chats'] });
    },
  });
  const stop = useMutation({ mutationFn: () => api.stopClaudeChat(id), onSuccess: () => log.poke() });

  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [log.events.length]);

  const submit = () => {
    if (text.trim() && !working) send.mutate(text);
  };

  return (
    <>
      <div className="flex items-center gap-2 border-b border-[var(--rule)] px-3 py-2 text-sm">
        <button type="button" onClick={onBack} className="text-[var(--ink-dim)] md:hidden" aria-label="Back">←</button>
        <span className="truncate font-medium">{chat?.title ?? '…'}</span>
        {chat && <span className="text-xs text-[var(--ink-dim)]">{chat.model} · {chat.cwd.replace(/^\/home\/hermes\//, '~/')}</span>}
        {chat && <span className="text-xs"><StatusLabel c={chat} /></span>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto max-w-3xl">
          {log.error && <HubError error={log.error} />}
          <EventFeed events={log.events} working={working} />
          <div ref={bottom} />
        </div>
      </div>
      <form className="border-t border-[var(--rule)] p-3" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2}
            placeholder={working ? 'Claude is working…' : 'Message Claude Code (Enter sends, Shift+Enter for a new line)'}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            className="min-h-[2.75rem] flex-1 resize-y rounded border border-[var(--rule)] bg-[var(--paper)] px-3 py-2 text-[0.95rem]" />
          {working ? (
            <button type="button" onClick={() => stop.mutate()} className="rounded border border-[var(--warn)] px-3 py-2 text-sm text-[var(--warn)]">Stop</button>
          ) : (
            <button type="submit" disabled={!text.trim() || send.isPending} className="rounded px-3 py-2 text-sm font-medium text-white disabled:opacity-50" style={{ background: 'var(--claude)' }}>Send</button>
          )}
        </div>
        {(send.isError || stop.isError) && <p className="mx-auto mt-1 max-w-3xl text-xs text-[var(--warn)]">⚠ {(send.error ?? stop.error)?.message}</p>}
      </form>
    </>
  );
}
