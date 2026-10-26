import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, ZEN_THINKING, type ChatPreset } from '../../lib/api.js';

/**
 * The Chat tab's one-click launch: "Preset" starts a session from the saved preset, the gear edits it. A preset is a
 * convenience, not a permission: launching calls the same create route a manual New session uses (agent-hub or
 * `zen-agent serve`), which validate the model, tools and thinking level. A session's config is fixed for its life, so
 * saving a preset changes only the sessions started after it. 
 */
const DEFAULT_NAME = 'default';
const REMEMBER = 'sb.chat-preset';
type Draft = Pick<ChatPreset, 'harness' | 'config'>;
const BLANK: Draft = { harness: 'claude-code', config: { model: 'opus' } };

/** Claude Code has no persona support in agent-hub yet, so the role goes in as the opening message. */
export function roleOpening(role: string): string {
  return `Act as ${role}. Read .claude/agents/${role}.md in the vault and follow it. Then wait for my instruction.`;
}

function remembered(): string | null {
  try { return localStorage.getItem(REMEMBER); } catch { return null; }
}
function remember(name: string): void {
  try { localStorage.setItem(REMEMBER, name); } catch { /* private window: the choice just isn't kept */ }
}

export default function PresetLauncher() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const presets = useQuery({ queryKey: ['chat-presets'], queryFn: api.chatPresets });
  const list = presets.data?.presets ?? [];
  const [picked, setPicked] = useState<string | null>(remembered);
  // The picked preset if it still exists, else the first one (the server lists by name).
  const saved = list.find((p) => p.name === picked) ?? list.find((p) => p.name === DEFAULT_NAME) ?? list[0];
  const [open, setOpen] = useState(false);
  const choose = (name: string) => { setPicked(name); remember(name); };

  const launch = useMutation({
    mutationFn: async (p: Draft) => {
      if (p.harness === 'zen-agent') {
        const { persona, model, tools, thinking } = p.config;
        const c = await api.newZenChat({ persona: persona || null, ...(model ? { model } : {}), ...(tools ? { tools } : {}), ...(thinking ? { thinking } : {}) });
        return `/agents/zen/${c.id}`;
      }
      const c = await api.newClaudeChat(p.config.model);
      if (p.config.role) await api.sendClaudeChat(c.id, roleOpening(p.config.role));
      return `/agents/chat/${c.id}`;
    },
    onSuccess: (to) => {
      void queryClient.invalidateQueries({ queryKey: ['claude-chats'] });
      void queryClient.invalidateQueries({ queryKey: ['zen-chats'] });
      navigate(to);
    },
  });

  const onPreset = () => {
    if (saved) launch.mutate(saved);
    else setOpen(true);   // nothing saved yet: the first click opens the settings
  };

  return (
    <div className="border-b border-[var(--rule)] p-3">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onPreset} disabled={launch.isPending}
          className="flex flex-1 items-center justify-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
          style={{ background: 'var(--accent)' }} aria-label="Start a chat from the preset">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
          Preset{saved && list.length > 1 ? `: ${saved.name}` : ''}
        </button>
        <button type="button" onClick={() => setOpen((o) => !o)} aria-label="Preset settings" aria-expanded={open}
          className="rounded border border-[var(--rule)] p-1.5 text-[var(--ink-dim)] hover:text-[var(--ink)]">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
          </svg>
        </button>
      </div>
      {list.length > 1 && (
        <select value={saved?.name ?? ''} onChange={(e) => choose(e.target.value)} aria-label="Preset"
          className="mt-2 w-full rounded border border-[var(--rule)] bg-[var(--paper)] px-2 py-1 text-xs">
          {list.map((p) => <option key={p.name} value={p.name}>{p.name} ({p.harness === 'zen-agent' ? 'zen-agent' : 'Claude Code'})</option>)}
        </select>
      )}
      {launch.isError && <p className="mt-2 text-xs text-[var(--warn)]">⚠ {launch.error.message}. Open the settings to change the preset.</p>}
      {open && (
        <Settings key={saved?.name ?? 'new'} initial={saved} taken={list.map((p) => p.name)}
          onLaunch={(p) => launch.mutate(p)} onSaved={(name) => { choose(name); setOpen(false); }} />
      )}
    </div>
  );
}

function Settings({ initial, taken, onLaunch, onSaved }: { initial: ChatPreset | undefined; taken: string[]; onLaunch: (p: Draft) => void; onSaved: (name: string) => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(initial?.name ?? DEFAULT_NAME);
  const [draft, setDraft] = useState<Draft>({ harness: (initial ?? BLANK).harness, config: { ...(initial ?? BLANK).config } });
  const editing = initial !== undefined && name === initial.name;
  const nameOk = /^[a-z0-9][a-z0-9-]{0,31}$/.test(name);
  const clash = !editing && taken.includes(name);
  const zen = draft.harness === 'zen-agent';
  // Both lists come from the zen server; on an install without one they are empty and the fields stay free text / blank.
  const personas = useQuery({ queryKey: ['zen-personas'], queryFn: api.zenPersonas, staleTime: 60_000, retry: false });
  const catalog = useQuery({ queryKey: ['zen-models'], queryFn: api.zenModels, staleTime: 60_000, retry: false, enabled: zen });
  const names = personas.data?.personas ?? [];

  const set = (patch: Draft['config']) => setDraft((d) => ({ ...d, config: { ...d.config, ...patch } }));
  const clean = (): Draft => ({
    harness: draft.harness,
    config: Object.fromEntries(Object.entries(draft.config).filter(([, v]) => v !== '' && v !== undefined)) as Draft['config'],
  });
  const save = useMutation({
    mutationFn: () => api.putChatPreset(name, clean()),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['chat-presets'] }),
  });
  const del = useMutation({
    mutationFn: () => api.deleteChatPreset(name),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['chat-presets'] }); onSaved(DEFAULT_NAME); },
  });
  const both = () => save.mutateAsync().then(() => { onLaunch(clean()); onSaved(name); }, () => {});

  const field = 'w-full rounded border border-[var(--rule)] bg-[var(--paper)] px-2 py-1 text-sm';
  const label = 'block text-xs text-[var(--ink-dim)]';
  return (
    <form className="mt-3 space-y-2" onSubmit={(e) => { e.preventDefault(); if (nameOk && !clash) save.mutate(undefined, { onSuccess: () => onSaved(name) }); }}>
      <label className={label}>Preset name
        <input className={field} value={name} aria-label="Preset name" onChange={(e) => setName(e.target.value.toLowerCase())} />
      </label>
      {(!nameOk || clash) && <p className="text-xs text-[var(--warn)]">{clash ? 'A preset with that name exists: pick it from the list to edit it.' : 'Lowercase letters, digits and dashes.'}</p>}
      <label className={label}>Harness
        <select className={field} value={draft.harness} aria-label="Harness"
          onChange={(e) => setDraft({ harness: e.target.value as Draft['harness'], config: e.target.value === 'zen-agent' ? {} : { model: 'opus' } })}>
          <option value="claude-code">Claude Code</option>
          <option value="zen-agent">zen-agent</option>
        </select>
      </label>
      <label className={label}>Org role
        <select className={field} aria-label="Org role" value={(zen ? draft.config.persona : draft.config.role) ?? ''}
          onChange={(e) => set(zen ? { persona: e.target.value } : { role: e.target.value })}>
          <option value="">none</option>
          {names.map((p) => <option key={p.name} value={p.name}>{p.name} - {p.role}</option>)}
        </select>
      </label>
      {!zen && (
        <label className={label}>Model
          <select className={field} aria-label="Model" value={draft.config.model ?? 'opus'} onChange={(e) => set({ model: e.target.value })}>
            <option value="opus">Opus</option><option value="sonnet">Sonnet</option><option value="haiku">Haiku</option>
          </select>
        </label>
      )}
      {zen && (
        <>
          <label className={label}>Provider and model
            <select className={field} aria-label="Provider and model" value={draft.config.model ?? ''} onChange={(e) => set({ model: e.target.value })}>
              <option value="">server default</option>
              {(catalog.data?.models ?? []).map((m) => (
                <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`} disabled={!m.configured || m.reachable === false}>
                  {m.provider} / {m.name}{!m.configured ? ' (no key)' : m.reachable === false ? ' (unreachable)' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className={label}>Tools
            <select className={field} aria-label="Tools" value={draft.config.tools ?? ''} onChange={(e) => set({ tools: (e.target.value || undefined) as Draft['config']['tools'] })}>
              <option value="">server default</option><option value="full">full</option><option value="read-only">read-only</option>
            </select>
          </label>
          <label className={label}>Thinking
            <select className={field} aria-label="Thinking" value={draft.config.thinking ?? ''} onChange={(e) => set({ thinking: (e.target.value || undefined) as Draft['config']['thinking'] })}>
              <option value="">server default</option>
              {ZEN_THINKING.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
        </>
      )}
      <div className="flex gap-2 pt-1">
        <button type="submit" disabled={save.isPending || !nameOk || clash} className="rounded border border-[var(--rule)] px-3 py-1 text-xs">Save</button>
        <button type="button" disabled={save.isPending || !nameOk || clash} onClick={() => void both()}
          className="rounded px-3 py-1 text-xs font-medium text-white" style={{ background: 'var(--accent)' }}>Save and launch</button>
        {editing && <button type="button" disabled={del.isPending} onClick={() => del.mutate()} className="ml-auto rounded border border-[var(--warn)] px-3 py-1 text-xs text-[var(--warn)]">Delete</button>}
      </div>
      {!editing && initial && <p className="text-xs text-[var(--ink-faint)]">Saving under a new name makes a new preset; the one you were editing stays as it was.</p>}
      {(save.isError || del.isError) && <p className="text-xs text-[var(--warn)]">⚠ {(save.error ?? del.error)?.message}</p>}
      <p className="text-xs text-[var(--ink-faint)]">Applies to sessions started after you save; open ones keep the settings they began with.</p>
    </form>
  );
}
