import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api.js';

interface Props {
  path: string;
  onDone: () => void;
}

/**
 * A plain textarea on purpose: it works the same on a phone as on a laptop,
 * and never reformats a note the way a WYSIWYG editor quietly would.
 */
export default function Editor({ path, onDone }: Props) {
  const queryClient = useQueryClient();
  const source = useQuery({
    queryKey: ['source', path],
    queryFn: () => api.source(path),
    staleTime: 0,
    gcTime: 0,
  });

  const [text, setText] = useState<string | null>(null);
  const [baseHash, setBaseHash] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  useEffect(() => {
    if (source.data && text === null) {
      setText(source.data.content);
      setBaseHash(source.data.hash);
    }
  }, [source.data, text]);

  const dirty = source.data !== undefined && text !== null && text !== source.data.content;

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent): void => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  async function save(): Promise<void> {
    if (text === null || baseHash === null || saving) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await api.save(path, text, baseHash);
      setBaseHash(saved.hash);
      await queryClient.invalidateQueries({ queryKey: ['file', path] });
      await queryClient.invalidateQueries({ queryKey: ['tree'] });
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setConflict(true);
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function cancel(): void {
    if (dirty && !window.confirm('Discard your changes?')) return;
    onDone();
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (source.isPending) return <p className="text-[var(--ink-dim)]">loading…</p>;
  if (source.error) return <p className="text-red-500">{(source.error as Error).message}</p>;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty || saving || conflict}
          className="rounded bg-[var(--accent)] px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={cancel}
          className="rounded border border-[var(--rule)] px-3 py-1 text-sm text-[var(--ink-dim)] hover:text-[var(--ink)]"
        >
          {dirty ? 'Cancel' : 'Close'}
        </button>
        <span className="text-xs text-[var(--ink-faint)]">⌘S / Ctrl+S saves</span>
      </div>

      {error && (
        <p className="text-sm text-red-500">
          {error}
          {conflict && ' — your text is still below: copy it, then close and reopen the editor to merge.'}
        </p>
      )}

      <textarea
        value={text ?? ''}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        className="h-[70vh] w-full resize-y rounded border border-[var(--rule)] bg-[var(--paper-sunk)] p-3 font-mono text-[13px] leading-relaxed outline-none focus:border-[var(--accent)]"
      />
    </div>
  );
}
