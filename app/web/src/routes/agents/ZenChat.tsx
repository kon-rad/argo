import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError, api, ZEN_THINKING, type NewZenChat, type ZenChat as ZenChatRow, type ZenModel, type ZenProvider, type ZenThinking } from '../../lib/api.js';
import { useEventLog } from '../../lib/useEventLog.js';
import EventFeed from '../../components/EventFeed.js';
import { ChatInput } from '../../components/ChatInput.js';
import { useStickToBottom } from '../../lib/useStickToBottom.js';
import HarnessSwitch from './HarnessSwitch.js';

/**
 * Chat with zen-agent on the server: `zen-agent serve` keeps one live agent per open chat and this page follows its
 * trace as it is written (thinking, each tool call with its timing, skill reads, guard blocks, compactions, the turn's
 * tokens and cost). A session's persona, provider, model, tool access and thinking level are chosen when it is made
 * and fixed for its life: to change any of them, "continue as a new session" starts another chat seeded with this
 * one's history. Providers are offered from the keys already set on the server (and, for local endpoints such as a
 * laptop over Tailscale, only while they answer); no key ever passes through this page.
 */
const ACCENT = 'var(--accent)';

export default function ZenChat() {
  const navigate = useNavigate();
  const { chatId } = useParams();
  const chats = useQuery({ queryKey: ['zen-chats'], queryFn: api.zenChats, refetchInterval: 10_000 });
  // The new-session form: closed, blank, or seeded from a chat to continue.
  const [form, setForm] = useState<{ from: ZenChatRow | null } | null>(null);
  useEffect(() => setForm(null), [chatId]);

  if (chats.isError) return <ZenError error={chats.error} />;
  const list = chats.data?.chats ?? [];
  const showForm = form !== null || (!chatId && list.length === 0 && chats.isSuccess);

  return (
    <div className="flex h-full min-h-0">
      <aside className={`flex w-72 shrink-0 flex-col border-r border-[var(--rule)] ${chatId || showForm ? 'max-md:hidden' : 'max-md:w-full'}`}>
        <div className="flex items-center gap-2 border-b border-[var(--rule)] p-3">
          <HarnessSwitch />
          <button type="button" onClick={() => setForm({ from: null })}
            className="ml-auto rounded px-3 py-1 text-xs font-medium text-white" style={{ background: ACCENT }}>
            New session
          </button>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto" aria-label="Sessions">
          {list.length === 0 && <li className="p-3 text-sm text-[var(--ink-dim)]">No sessions yet.</li>}
          {list.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => navigate(`/agents/zen/${c.id}`)}
                className={`w-full border-b border-[var(--rule)] px-3 py-2 text-left text-sm hover:bg-[var(--paper-sunk)] ${chatId === c.id ? 'bg-[var(--paper-sunk)]' : ''}`}>
                <div className="truncate font-medium">{c.title || 'untitled'}</div>
                <div className="flex gap-2 text-xs text-[var(--ink-dim)]">
                  <span className="truncate">{c.persona ?? 'default'} · {shortModel(c.model)}</span>
                  <StatusLabel c={c} />
                  <span className="ml-auto shrink-0">{new Date(c.updated_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section className={`flex min-w-0 flex-1 flex-col ${chatId || showForm ? '' : 'max-md:hidden'}`}>
        {showForm ? <NewSession from={form?.from ?? null} onClose={() => setForm(null)} />
          : chatId ? <Conversation id={chatId} onBack={() => navigate('/agents/zen')} onContinue={(c) => setForm({ from: c })} />
          : <p className="p-6 text-sm text-[var(--ink-dim)]">Start a new session or pick one on the left. zen-agent works in the vault on the server.</p>}
      </section>
    </div>
  );
}

function shortModel(spec: string): string {
  return spec.length > 36 ? `…${spec.slice(-34)}` : spec;
}

function StatusLabel({ c }: { c: ZenChatRow }) {
  const map = { working: ['working', ACCENT], idle: ['ready', 'var(--hermes)'], error: ['error', 'var(--warn)'] } as const;
  const [label, color] = map[c.status] ?? ['?', 'var(--ink-faint)'];
  return <span style={{ color }}>{label}</span>;
}

function ZenError({ error }: { error: Error }) {
  if (error instanceof ApiError && error.status === 503) {
    return <p className="p-6 text-sm text-[var(--ink-dim)]">zen-agent chats run on the server, next to a <code>zen-agent serve</code> process. {error.message}</p>;
  }
  return <p className="p-6 text-sm">⚠ {error.message}</p>;
}

/** Why a model cannot be picked right now, or null when it can. */
function unavailable(m: ZenModel, p: ZenProvider | undefined): string | null {
  if (!m.configured) return p?.custom && p.key_env ? `no ${p.key_env} on the server` : 'no key on the server';
  if (m.reachable === false) return 'unreachable';
  return null;
}

function NewSession({ from, onClose }: { from: ZenChatRow | null; onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const catalog = useQuery({ queryKey: ['zen-models'], queryFn: api.zenModels, refetchInterval: 30_000 });
  const personas = useQuery({ queryKey: ['zen-personas'], queryFn: api.zenPersonas, staleTime: 60_000 });
  const providers = useMemo(() => new Map((catalog.data?.providers ?? []).map((p) => [p.id, p])), [catalog.data]);
  const models = catalog.data?.models ?? [];

  const [persona, setPersona] = useState(from?.persona ?? '');
  const [model, setModel] = useState(from?.model ?? '');
  const [tools, setTools] = useState<'full' | 'read-only'>(from ? (from.tools.length <= 2 && from.tools.every((t) => t === 'skills' || t === 'knowledge') ? 'read-only' : 'full') : 'full');
  const [thinking, setThinking] = useState<ZenThinking>(from?.thinking ?? 'off');
  const [touchedTools, setTouchedTools] = useState(Boolean(from));

  // First usable model once the catalogue is in; a local or custom endpoint starts read-only until someone has
  // watched it make tool calls correctly (a small quantised model with shell access is a worse failure than a wrong answer).
  useEffect(() => {
    if (!model && models.length) {
      const first = models.find((m) => !unavailable(m, providers.get(m.provider))) ?? models[0]!;
      setModel(`${first.provider}/${first.id}`);
    }
  }, [models, model, providers]);
  const chosen = models.find((m) => `${m.provider}/${m.id}` === model);
  useEffect(() => {
    if (!touchedTools && chosen) setTools(providers.get(chosen.provider)?.custom ? 'read-only' : 'full');
  }, [chosen, providers, touchedTools]);

  const create = useMutation({
    mutationFn: (body: NewZenChat) => api.newZenChat(body),
    onSuccess: (c) => {
      void queryClient.invalidateQueries({ queryKey: ['zen-chats'] });
      navigate(`/agents/zen/${c.id}`);
    },
  });
  const byProvider = new Map<string, ZenModel[]>();
  for (const m of models) byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), m]);
  const blocked = chosen ? unavailable(chosen, providers.get(chosen.provider)) : null;

  const field = 'rounded border border-[var(--rule)] bg-[var(--paper)] px-2 py-1 text-sm';
  return (
    <form className="mx-auto w-full max-w-xl space-y-4 p-6" onSubmit={(e) => { e.preventDefault(); create.mutate({ persona: persona || null, model, tools, thinking, ...(from ? { from: from.id } : {}) }); }}>
      <h2 className="text-base font-semibold">{from ? `Continue "${from.title || 'untitled'}" as a new session` : 'New zen-agent session'}</h2>
      {from && (
        <p className="text-xs text-[var(--ink-dim)]">
          The messages so far are replayed into a new session with the settings below; the old session stays as it was. A session's settings never change once it has started.
        </p>
      )}
      {catalog.isError && <ZenError error={catalog.error} />}
      <label className="block text-sm">
        <span className="text-[var(--ink-dim)]">Persona</span>
        <select value={persona} onChange={(e) => setPersona(e.target.value)} aria-label="Persona" className={`${field} mt-1 block w-full`}>
          <option value="">default (no persona)</option>
          {(personas.data?.personas ?? []).map((p) => (
            <option key={p.name} value={p.name}>{p.name} · {p.role}{p.team ? ` · ${p.team}` : ''}</option>
          ))}
        </select>
      </label>
      <label className="block text-sm">
        <span className="text-[var(--ink-dim)]">Model</span>
        <select value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model" className={`${field} mt-1 block w-full`}>
          {[...byProvider.entries()].map(([pid, ms]) => {
            const p = providers.get(pid);
            const note = p?.custom ? ` · ${p.base_url ?? ''}${p.key_env ? ` · ${p.key_env}` : ''}` : p && !p.configured ? ' · no key' : '';
            return (
              <optgroup key={pid} label={`${p?.name ?? pid}${note}`}>
                {ms.map((m) => {
                  const why = unavailable(m, p);
                  return <option key={m.id} value={`${m.provider}/${m.id}`} disabled={why !== null}>{m.id}{why ? ` (${why})` : ''}</option>;
                })}
              </optgroup>
            );
          })}
        </select>
        {chosen && (
          <span className="mt-1 block text-xs text-[var(--ink-faint)]">
            {Math.round(chosen.context_window / 1000)}k context{chosen.reasoning ? ' · reasoning' : ''}
            {providers.get(chosen.provider)?.custom ? ` · ${providers.get(chosen.provider)!.reachable ? 'answering' : 'not answering'}` : ''}
            {blocked ? ` · ${blocked}` : ''}
          </span>
        )}
      </label>
      <fieldset className="text-sm">
        <legend className="text-[var(--ink-dim)]">Tool access</legend>
        <label className="mr-4 inline-flex items-center gap-1">
          <input type="radio" name="tools" value="full" checked={tools === 'full'} onChange={() => { setTools('full'); setTouchedTools(true); }} /> full (files, shell, skills, knowledge, board, org, delegate)
        </label>
        <label className="inline-flex items-center gap-1">
          <input type="radio" name="tools" value="read-only" checked={tools === 'read-only'} onChange={() => { setTools('read-only'); setTouchedTools(true); }} /> read-only (skills, knowledge)
        </label>
      </fieldset>
      <label className="block text-sm">
        <span className="text-[var(--ink-dim)]">Thinking</span>
        <select value={thinking} onChange={(e) => setThinking(e.target.value as ZenThinking)} aria-label="Thinking" className={`${field} mt-1 block w-full`}>
          {ZEN_THINKING.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </label>
      <div className="flex items-center gap-2">
        <button type="submit" disabled={!model || blocked !== null || create.isPending}
          className="rounded px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50" style={{ background: ACCENT }}>
          {from ? 'Continue as new session' : 'Start session'}
        </button>
        <button type="button" onClick={onClose} className="text-sm text-[var(--ink-dim)]">Cancel</button>
        {create.isError && <span className="text-xs text-[var(--warn)]">⚠ {create.error.message}</span>}
      </div>
    </form>
  );
}

function Conversation({ id, onBack, onContinue }: { id: string; onBack: () => void; onContinue: (c: ZenChatRow) => void }) {
  const queryClient = useQueryClient();
  const [working, setWorking] = useState(false);
  const log = useEventLog(id, (off) => api.zenChatEvents(id, off), working);
  const chat = log.last?.chat;
  useEffect(() => {
    if (chat) setWorking(chat.status === 'working');
  }, [chat?.status]);  // eslint-disable-line react-hooks/exhaustive-deps

  const [text, setText] = useState('');
  const after = () => {
    setText('');
    log.poke();
    void queryClient.invalidateQueries({ queryKey: ['zen-chats'] });
  };
  const send = useMutation({ mutationFn: (t: string) => api.sendZenChat(id, t), onSuccess: () => { setWorking(true); after(); } });
  const steer = useMutation({ mutationFn: (t: string) => api.steerZenChat(id, t), onSuccess: after });
  const stop = useMutation({ mutationFn: () => api.stopZenChat(id), onSuccess: () => log.poke() });

  const scroller = useStickToBottom(`${id}:${log.events.length > 0}`);
  const submit = () => {
    if (!text.trim() || send.isPending || steer.isPending) return;
    if (working) steer.mutate(text);
    else send.mutate(text);
    scroller.pin();
  };
  const err = send.error ?? steer.error ?? stop.error;

  return (
    <>
      <div className="flex items-center gap-2 border-b border-[var(--rule)] px-3 py-2 text-sm">
        <button type="button" onClick={onBack} className="text-[var(--ink-dim)] md:hidden" aria-label="Back">←</button>
        <span className="truncate font-medium">{chat ? chat.title || 'untitled' : '…'}</span>
        {chat && (
          <span className="truncate text-xs text-[var(--ink-dim)]" title={`${chat.model} · tools: ${chat.tools.join(', ') || 'none'} · thinking ${chat.thinking} · session ${chat.session_id}`}>
            {chat.persona ?? 'default'} · {chat.model} · {chat.tools.join(', ') || 'no tools'}{chat.thinking !== 'off' ? ` · thinking ${chat.thinking}` : ''}
          </span>
        )}
        {chat && <span className="text-xs"><StatusLabel c={chat} /></span>}
        {chat && (
          <button type="button" onClick={() => onContinue(chat)} className="ml-auto shrink-0 rounded border border-[var(--rule)] px-2 py-0.5 text-xs text-[var(--ink-dim)] hover:text-[var(--ink)]"
            title="Start a new session with other settings, seeded with this conversation">
            Continue as new session
          </button>
        )}
      </div>
      <div ref={scroller.ref} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto max-w-3xl">
          {log.error && <ZenError error={log.error} />}
          <EventFeed events={log.events} working={working} accent={ACCENT} />
        </div>
      </div>
      <form className="border-t border-[var(--rule)] p-3" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <ChatInput value={text} onChange={setText} onSubmit={submit} label="Message zen-agent"
            placeholder={working ? 'Working… a message now steers the run (read after the current step)' : 'Message zen-agent (Enter sends, Shift+Enter for a new line)'} />
          {working ? (
            <>
              <button type="submit" disabled={!text.trim() || steer.isPending} className="rounded border border-[var(--rule)] px-3 py-2 text-sm disabled:opacity-50">Steer</button>
              <button type="button" onClick={() => stop.mutate()} className="rounded border border-[var(--warn)] px-3 py-2 text-sm text-[var(--warn)]">Stop</button>
            </>
          ) : (
            <button type="submit" disabled={!text.trim() || send.isPending} className="rounded px-3 py-2 text-sm font-medium text-white disabled:opacity-50" style={{ background: ACCENT }}>Send</button>
          )}
        </div>
        {err && <p className="mx-auto mt-1 max-w-3xl text-xs text-[var(--warn)]">⚠ {err.message}</p>}
        {chat?.status === 'error' && chat.error && !err && <p className="mx-auto mt-1 max-w-3xl text-xs text-[var(--warn)]">⚠ last run: {chat.error}</p>}
      </form>
    </>
  );
}
