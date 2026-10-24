import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type ChatOptions, type ChatSettingsPatch } from '../../lib/api.js';

const field = 'w-full rounded border border-[var(--rule)] bg-[var(--paper)] px-2 py-1.5 text-sm';
const label = 'mb-1 block text-xs font-medium text-[var(--ink-dim)]';

/**
 * The chat's settings: which provider and model answer (only providers whose
 * key is set on the server can be picked), who answers (a persona from the
 * org chart), the base system prompt, and the retrieval knobs. Saved on the
 * server, so every device sees the same.
 */
export default function ChatSettingsModal({ options, onClose }: { options: ChatOptions; onClose: () => void }) {
  const queryClient = useQueryClient();
  const s = options.settings;
  const [provider, setProvider] = useState<string>(s.provider ?? s.resolved.provider ?? options.default_provider);
  const [model, setModel] = useState<string>(s.model ?? s.resolved.model ?? '');
  const [custom, setCustom] = useState(false);
  const [persona, setPersona] = useState(s.persona);
  const [prompt, setPrompt] = useState(s.system_prompt ?? options.default_system_prompt);
  const [topK, setTopK] = useState(s.retrieval.top_k);
  const [multi, setMulti] = useState(s.retrieval.multi_query);
  const [rerank, setRerank] = useState(s.retrieval.rerank);

  const chosen = options.providers.find((p) => p.id === provider);
  const models = chosen?.models ?? [];
  const inList = models.some((m) => m.id === model);

  // Switching provider resets the model to that provider's default.
  useEffect(() => {
    if (chosen && !chosen.models.some((m) => m.id === model) && !custom) setModel(chosen.default);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = useMutation({
    mutationFn: (patch: ChatSettingsPatch) => api.putChatSettings(patch),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['chat', 'options'] });
      onClose();
    },
  });

  function submit(): void {
    save.mutate({
      provider,
      model: model.trim() || null,
      persona,
      system_prompt: prompt.trim() && prompt.trim() !== options.default_system_prompt.trim() ? prompt : null,
      retrieval: { top_k: topK, multi_query: multi, rerank },
    });
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-2 md:p-6" onClick={onClose} data-testid="chat-settings-backdrop">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Chat settings"
        className="flex max-h-full w-full max-w-xl flex-col overflow-hidden rounded-lg border border-[var(--rule)] bg-[var(--paper)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-[var(--rule)] px-4 py-2">
          <span className="font-semibold">Chat settings</span>
          <button type="button" onClick={onClose} aria-label="Close settings" className="ml-auto px-1 text-base leading-none text-[var(--ink-dim)] hover:text-[var(--ink)]">×</button>
        </div>
        <form
          className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label className={label} htmlFor="chat-provider">Provider</label>
              <select id="chat-provider" className={field} value={provider} onChange={(e) => { setCustom(false); setProvider(e.target.value); }}>
                {options.providers.map((p) => (
                  <option key={p.id} value={p.id} disabled={!p.configured}>
                    {p.label}{p.configured ? '' : ` (set ${p.env})`}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={label} htmlFor="chat-model">Model</label>
              {custom || (!inList && model) ? (
                <div className="flex gap-1">
                  <input id="chat-model" className={field} value={model} onChange={(e) => setModel(e.target.value)} placeholder="model id" />
                  <button type="button" className="shrink-0 text-xs text-[var(--accent)]" onClick={() => { setCustom(false); setModel(chosen?.default ?? ''); }}>list</button>
                </div>
              ) : (
                <select id="chat-model" className={field} value={model} onChange={(e) => (e.target.value === '__custom' ? (setCustom(true), setModel('')) : setModel(e.target.value))}>
                  {models.map((m) => <option key={m.id} value={m.id}>{m.label ?? m.id}</option>)}
                  <option value="__custom">Other model id…</option>
                </select>
              )}
            </div>
          </div>

          <div>
            <label className={label} htmlFor="chat-persona">Persona</label>
            <select id="chat-persona" className={field} value={persona} onChange={(e) => setPersona(e.target.value)}>
              {options.personas.map((p) => (
                <option key={p.id} value={p.id}>{p.name}{p.builtin ? '' : ` · ${p.role}`}</option>
              ))}
            </select>
            {options.personas.length === 1 && (
              <p className="mt-1 text-xs text-[var(--ink-faint)]">Agents from the org module's chart appear here once an org is imported.</p>
            )}
          </div>

          <div>
            <div className="flex items-baseline">
              <label className={label} htmlFor="chat-prompt">System prompt</label>
              <button type="button" className="ml-auto text-xs text-[var(--accent)]" onClick={() => setPrompt(options.default_system_prompt)}>reset to default</button>
            </div>
            <textarea id="chat-prompt" className={`${field} min-h-32 font-mono text-xs`} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            <p className="mt-1 text-xs text-[var(--ink-faint)]">The persona's definition and the retrieved passages are added after this.</p>
          </div>

          <fieldset className="rounded border border-[var(--rule)] p-3">
            <legend className="px-1 text-xs font-medium text-[var(--ink-dim)]">Retrieval</legend>
            <div className="grid gap-3 md:grid-cols-3">
              <div>
                <label className={label} htmlFor="chat-topk">Passages per answer</label>
                <input id="chat-topk" type="number" min={1} max={20} className={field} value={topK} onChange={(e) => setTopK(Math.max(1, Math.min(20, Number(e.target.value) || 1)))} />
              </div>
              <label className="flex items-center gap-2 text-sm md:mt-5">
                <input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} /> Alternate queries
              </label>
              <label className={`flex items-center gap-2 text-sm md:mt-5 ${options.rerank.available ? '' : 'text-[var(--ink-faint)]'}`} title={options.rerank.available ? options.rerank.model : 'Set RERANK_URL and RERANK_API_KEY on the server'}>
                <input type="checkbox" checked={rerank} disabled={!options.rerank.available} onChange={(e) => setRerank(e.target.checked)} /> Rerank
              </label>
            </div>
            <p className="mt-2 text-xs text-[var(--ink-faint)]">
              {options.embeddings.configured
                ? `${options.embeddings.chunks.toLocaleString()} chunks embedded${options.embeddings.model ? ` with ${options.embeddings.model}` : ''}; keyword and meaning are fused.`
                : 'Semantic search is not configured: answers use keyword retrieval only.'}
            </p>
          </fieldset>

          {save.isError && <p className="text-sm text-[var(--warn)]">⚠ {save.error.message}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="rounded border border-[var(--rule)] px-3 py-1.5 text-sm">Cancel</button>
            <button type="submit" disabled={save.isPending} className="rounded bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">Save</button>
          </div>
        </form>
      </div>
    </div>
  );
}
