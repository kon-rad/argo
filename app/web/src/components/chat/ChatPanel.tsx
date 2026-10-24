import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Link } from 'react-router-dom';
import { api, fileHref, type ChatConversation, type ChatMessage, type ChatOptions, type ChatSource } from '../../lib/api.js';
import { sendChatMessage, type SourcesEvent } from '../../lib/chatStream.js';
import { useStickToBottom } from '../../lib/useStickToBottom.js';
import { ChatInput } from '../ChatInput.js';
import { PreviewModal } from '../PreviewModal.js';
import ChatSettingsModal from './ChatSettingsModal.js';

/**
 * Ask the vault. A full-screen panel over whatever page is open: the list of
 * conversations on the left, the conversation (or a fresh one) in the centre,
 * the persona and model in the header. Answers stream in and keep the
 * passages they were built from, shown as numbered sources under each one.
 */
export default function ChatPanel({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const options = useQuery({ queryKey: ['chat', 'options'], queryFn: api.chatOptions, staleTime: 60_000 });
  const conversations = useQuery({ queryKey: ['chat', 'conversations'], queryFn: api.chatConversations });
  const [activeId, setActiveId] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [listOpen, setListOpen] = useState(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !settingsOpen) onClose();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose, settingsOpen]);

  const remove = useMutation({
    mutationFn: (id: number) => api.deleteChatConversation(id),
    onSuccess: (_d, id) => {
      if (activeId === id) setActiveId(null);
      void queryClient.invalidateQueries({ queryKey: ['chat', 'conversations'] });
    },
  });

  const list = conversations.data?.conversations ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/50 md:p-4" data-testid="chat-backdrop" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Ask your second brain"
        className="flex h-full w-full max-w-6xl overflow-hidden bg-[var(--paper)] shadow-xl md:rounded-lg md:border md:border-[var(--rule)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Conversation list. On a phone it is the whole panel until a conversation is picked. */}
        <aside className={`flex w-72 shrink-0 flex-col border-r border-[var(--rule)] ${listOpen ? 'max-md:w-full' : 'max-md:hidden'}`}>
          <div className="flex items-center gap-2 border-b border-[var(--rule)] p-3">
            <button
              type="button"
              onClick={() => { setActiveId(null); setListOpen(false); }}
              className="rounded bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white"
            >
              New chat
            </button>
            <button type="button" onClick={onClose} aria-label="Close chat" className="ml-auto px-1 text-xl leading-none text-[var(--ink-dim)] hover:text-[var(--ink)] md:hidden">×</button>
          </div>
          <ul className="min-h-0 flex-1 overflow-y-auto" aria-label="Conversations">
            {conversations.isError && <li className="p-3 text-sm text-[var(--warn)]">⚠ {conversations.error.message}</li>}
            {list.length === 0 && !conversations.isPending && <li className="p-3 text-sm text-[var(--ink-dim)]">No conversations yet.</li>}
            {list.map((c) => (
              <li key={c.id} className={`group flex items-stretch border-b border-[var(--rule)] ${activeId === c.id ? 'bg-[var(--paper-sunk)]' : ''}`}>
                <button type="button" onClick={() => { setActiveId(c.id); setListOpen(false); }} className="min-w-0 flex-1 px-3 py-2 text-left text-sm hover:bg-[var(--paper-sunk)]">
                  <div className="truncate font-medium">{c.title}</div>
                  <div className="flex gap-2 text-xs text-[var(--ink-dim)]">
                    {c.persona !== 'default' && <span>{c.persona}</span>}
                    <span className="ml-auto">{when(c.updated_at)}</span>
                  </div>
                </button>
                <button
                  type="button"
                  aria-label={`Delete conversation ${c.title}`}
                  onClick={() => { if (window.confirm(`Delete "${c.title}"?`)) remove.mutate(c.id); }}
                  className="px-2 text-xs text-[var(--ink-faint)] hover:text-[var(--warn)] md:opacity-0 md:group-hover:opacity-100"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <section className={`flex min-w-0 flex-1 flex-col ${listOpen ? 'max-md:hidden' : ''}`}>
          {options.data ? (
            <Conversation
              id={activeId}
              options={options.data}
              onCreated={(c) => {
                setActiveId(c.id);
                void queryClient.invalidateQueries({ queryKey: ['chat', 'conversations'] });
              }}
              onOpenSettings={() => setSettingsOpen(true)}
              onBack={() => setListOpen(true)}
              onClose={onClose}
            />
          ) : options.isError ? (
            <div className="flex items-center gap-3 border-b border-[var(--rule)] px-3 py-2 text-sm">
              <span className="text-[var(--warn)]">⚠ {options.error.message}</span>
              <button type="button" onClick={onClose} aria-label="Close chat" className="ml-auto px-1 text-xl leading-none text-[var(--ink-dim)]">×</button>
            </div>
          ) : (
            <p className="p-6 text-sm text-[var(--ink-dim)]">Loading…</p>
          )}
        </section>
      </div>
      {settingsOpen && options.data && <ChatSettingsModal options={options.data} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

function when(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

interface Live {
  question: string;
  answer: string;
  sources: ChatSource[];
  retrieval: SourcesEvent | null;
  error: string | null;
}

function Conversation({
  id, options, onCreated, onOpenSettings, onBack, onClose,
}: {
  id: number | null;
  options: ChatOptions;
  onCreated: (c: ChatConversation) => void;
  onOpenSettings: () => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ['chat', 'conversation', id],
    queryFn: () => api.chatConversation(id!),
    enabled: id !== null,
  });
  const [persona, setPersona] = useState<string>(options.settings.persona);
  useEffect(() => {
    if (detail.data) setPersona(detail.data.conversation.persona);
  }, [detail.data?.conversation.persona]); // eslint-disable-line react-hooks/exhaustive-deps

  const [text, setText] = useState('');
  const [live, setLive] = useState<Live | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  // Picking another conversation drops the draft and any answer in flight; the
  // conversation this pane itself just created is not "another" one.
  const own = useRef<number | null>(null);
  useEffect(() => {
    if (id === own.current) return;
    abort.current?.abort();
    setLive(null);
    setText('');
    setSendError(null);
    if (id === null) setPersona(options.settings.persona);
  }, [id, options.settings.persona]);
  const messages = detail.data?.messages ?? [];
  const scroller = useStickToBottom(`${id}:${messages.length}:${live !== null}`);

  // A persona change on an existing conversation is remembered on it.
  const changePersona = useMutation({
    mutationFn: (p: string) => api.patchChatConversation(id!, { persona: p }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['chat', 'conversations'] }),
  });

  const send = useCallback(async (): Promise<void> => {
    const content = text.trim();
    if (!content || live) return;
    setSendError(null);
    setText('');
    let conversationId = id;
    try {
      if (conversationId === null) {
        const { conversation } = await api.newChatConversation({ persona });
        conversationId = conversation.id;
        own.current = conversation.id;
        onCreated(conversation);
      }
    } catch (err) {
      setSendError((err as Error).message);
      setText(content);
      return;
    }
    const controller = new AbortController();
    abort.current = controller;
    setLive({ question: content, answer: '', sources: [], retrieval: null, error: null });
    scroller.pin();
    try {
      await sendChatMessage(
        conversationId,
        { content, persona },
        {
          onSources: (e) => setLive((l) => (l ? { ...l, sources: e.sources, retrieval: e } : l)),
          onDelta: (t) => setLive((l) => (l ? { ...l, answer: l.answer + t } : l)),
          onError: (m) => setLive((l) => (l ? { ...l, error: m } : l)),
          onDone: () => {
            void queryClient.invalidateQueries({ queryKey: ['chat', 'conversation', conversationId] });
            void queryClient.invalidateQueries({ queryKey: ['chat', 'conversations'] });
          },
        },
        controller.signal,
      );
    } catch (err) {
      if (!controller.signal.aborted) setSendError((err as Error).message);
    } finally {
      abort.current = null;
      await queryClient.invalidateQueries({ queryKey: ['chat', 'conversation', conversationId] });
      setLive(null);
    }
  }, [text, live, id, persona, onCreated, queryClient, scroller]);

  const resolved = options.settings.resolved;
  const conv = detail.data?.conversation;
  const modelLabel = conv?.model ?? resolved.model ?? 'no model';
  const providerLabel = options.providers.find((p) => p.id === (conv?.provider ?? resolved.provider))?.label ?? (conv?.provider ?? resolved.provider ?? '');

  return (
    <>
      <div className="flex items-center gap-2 border-b border-[var(--rule)] px-3 py-2 text-sm">
        <button type="button" onClick={onBack} className="text-[var(--ink-dim)] md:hidden" aria-label="Conversations">←</button>
        <select
          aria-label="Persona"
          value={persona}
          onChange={(e) => {
            setPersona(e.target.value);
            if (id !== null) changePersona.mutate(e.target.value);
          }}
          className="max-w-48 truncate rounded border border-[var(--rule)] bg-[var(--paper)] px-2 py-1 text-xs"
        >
          {options.personas.map((p) => (
            <option key={p.id} value={p.id}>{p.name}{p.builtin ? '' : ` · ${p.role}`}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={onOpenSettings}
          title="Chat settings"
          className="truncate rounded border border-[var(--rule)] px-2 py-1 text-xs text-[var(--ink-dim)] hover:text-[var(--ink)]"
        >
          {providerLabel ? `${providerLabel} · ` : ''}{modelLabel}
        </button>
        <span className="min-w-0 flex-1 truncate text-[var(--ink-dim)]">{conv?.title ?? ''}</span>
        <button type="button" onClick={onOpenSettings} aria-label="Chat settings" title="Chat settings" className="px-1 text-base leading-none text-[var(--ink-dim)] hover:text-[var(--ink)]">⚙</button>
        <button type="button" onClick={onClose} aria-label="Close chat" className="px-1 text-xl leading-none text-[var(--ink-dim)] hover:text-[var(--ink)] max-md:hidden">×</button>
      </div>

      <div ref={scroller.ref} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto max-w-3xl space-y-5">
          {id === null && !live && (
            <div className="py-10 text-center text-[var(--ink-dim)]">
              <p className="text-lg font-semibold text-[var(--ink)]">Ask your second brain</p>
              <p className="mt-1 text-sm">Questions are answered from your notes, with the passages they rest on.</p>
              {!resolved.provider && (
                <p className="mt-3 text-sm text-[var(--warn)]">No chat provider is configured. Set a provider key on the server and open the settings.</p>
              )}
              {resolved.provider && !resolved.embeddings && (
                <p className="mt-3 text-xs">Semantic search is not configured; answers use keyword retrieval only.</p>
              )}
            </div>
          )}
          {detail.isError && <p className="text-sm text-[var(--warn)]">⚠ {detail.error.message}</p>}
          {messages.map((m) => <MessageView key={m.id} message={m} />)}
          {live && (
            <>
              <Bubble role="user">{live.question}</Bubble>
              <div>
                {live.answer ? (
                  <Answer text={live.answer} sources={live.sources} />
                ) : (
                  <p className="text-sm text-[var(--ink-dim)]">{live.retrieval ? 'Writing…' : 'Searching the vault…'}</p>
                )}
                {live.error && <p className="mt-2 text-sm text-[var(--warn)]">⚠ {live.error}</p>}
                {live.sources.length > 0 && <Sources sources={live.sources} />}
              </div>
            </>
          )}
          {sendError && <p className="text-sm text-[var(--warn)]">⚠ {sendError}</p>}
        </div>
      </div>

      <form className="border-t border-[var(--rule)] p-3" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <ChatInput value={text} onChange={setText} onSubmit={() => void send()} label="Ask a question"
            placeholder={live ? 'Answering…' : 'Ask about your notes (Enter sends, Shift+Enter for a new line)'} disabled={live !== null} />
          {live ? (
            <button type="button" onClick={() => abort.current?.abort()} className="rounded border border-[var(--warn)] px-3 py-2 text-sm text-[var(--warn)]">Stop</button>
          ) : (
            <button type="submit" disabled={!text.trim() || !resolved.provider} className="rounded bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50">Send</button>
          )}
        </div>
      </form>
    </>
  );
}

function Bubble({ role, children }: { role: 'user' | 'assistant'; children: React.ReactNode }) {
  return role === 'user' ? (
    <div className="flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-[var(--paper-sunk)] px-3 py-2 text-sm">{children}</div>
    </div>
  ) : (
    <div>{children}</div>
  );
}

function MessageView({ message }: { message: ChatMessage }) {
  if (message.role === 'user') return <Bubble role="user">{message.content}</Bubble>;
  return (
    <div>
      <Answer text={message.content} sources={message.sources} />
      {message.meta.error && !message.meta.partial && <p className="mt-1 text-xs text-[var(--warn)]">⚠ {message.meta.error}</p>}
      {message.sources.length > 0 && <Sources sources={message.sources} />}
      <p className="mt-1 text-[11px] text-[var(--ink-faint)]">
        {[message.meta.model, message.meta.persona && message.meta.persona !== 'default' ? `as ${message.meta.persona}` : null,
          message.meta.retrieval?.vector === false ? 'keyword only' : null, message.meta.retrieval?.reranked ? 'reranked' : null]
          .filter(Boolean).join(' · ')}
      </p>
    </div>
  );
}

/** Markdown with `[n]` turned into links to the n-th source. */
function Answer({ text, sources }: { text: string; sources: ChatSource[] }) {
  const byN = useMemo(() => new Map(sources.map((s) => [s.n, s])), [sources]);
  // "[1]" and "[1][3]" become links the renderer below recognises; a real markdown link "[x](y)" is left alone.
  const marked = useMemo(() => text.replace(/\[(\d{1,2})\](?!\()/g, (m, n) => (byN.has(Number(n)) ? `[${n}](#cite-${n})` : m)), [text, byN]);
  return (
    <div className="prose max-w-none text-sm">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // The default transform keeps `#cite-n` (a fragment) and drops javascript: and other unsafe schemes a model might emit.
        urlTransform={defaultUrlTransform}
        components={{
          a({ href, children }) {
            if (href?.startsWith('#cite-')) {
              const s = byN.get(Number(href.slice(6)));
              if (!s) return <>{children}</>;
              return (
                <Link to={fileHref(s.path)} title={`${s.title}${s.heading_path ? ` › ${s.heading_path}` : ''}`}
                  className="mx-0.5 inline-block rounded border border-[var(--rule)] px-1 align-super text-[10px] no-underline">
                  {children}
                </Link>
              );
            }
            return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
          },
        }}
      >
        {marked}
      </ReactMarkdown>
    </div>
  );
}

function Sources({ sources }: { sources: ChatSource[] }) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  return (
    <div className="mt-2">
      <button type="button" onClick={() => setOpen((o) => !o)} className="text-xs text-[var(--ink-dim)] hover:text-[var(--ink)]" aria-expanded={open}>
        {open ? '▾' : '▸'} {sources.length} source{sources.length === 1 ? '' : 's'}
      </button>
      {open && (
        <ol className="mt-1 space-y-1">
          {sources.map((s) => (
            <li key={s.n} className="rounded border border-[var(--rule)] px-2 py-1 text-xs">
              <div className="flex items-baseline gap-2">
                <span className="text-[var(--ink-faint)]">[{s.n}]</span>
                <Link to={fileHref(s.path)} className="font-medium text-[var(--accent)] hover:underline">{s.title}</Link>
                {s.heading_path && <span className="truncate text-[var(--ink-dim)]">› {s.heading_path}</span>}
                <button type="button" onClick={() => setPreview(s.path)} className="ml-auto shrink-0 text-[var(--ink-dim)] hover:text-[var(--ink)]">Preview</button>
              </div>
              <p className="mt-0.5 line-clamp-2 text-[var(--ink-dim)]">{s.snippet}</p>
            </li>
          ))}
        </ol>
      )}
      {preview && <PreviewModal path={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}
