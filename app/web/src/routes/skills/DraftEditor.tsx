import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { skillsApi, type Draft } from './api.js';
import { ChangeFlow } from './ChangeFlow.js';
import { button, Chip, Digest, ErrorState, input, Loading, primary } from './ui.js';

/**
 * Edit a draft package. Drafts live outside every skill folder, so nothing here reaches an agent; saving a file
 * saves the draft only. Publishing goes through a previewed change exported for review.
 */
export function DraftEditor({ name, onDeleted }: { name: string; onDeleted?: () => void }) {
  const qc = useQueryClient();
  const draft = useQuery({ queryKey: ['skills', 'draft', name], queryFn: () => skillsApi.draft(name) });
  const [path, setPath] = useState<string | null>(null);
  const [newPath, setNewPath] = useState('');
  const [publishing, setPublishing] = useState(false);
  const setDraft = (d: Draft) => {
    setPublishing(false);
    qc.setQueryData(['skills', 'draft', name], { draft: d });
    void qc.invalidateQueries({ queryKey: ['skills', 'drafts'] });
  };
  const remove = useMutation({
    mutationFn: () => skillsApi.deleteDraft(name),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['skills'] }); onDeleted?.(); },
  });

  if (draft.isPending) return <Loading what={`draft ${name}`} />;
  if (draft.isError) return <ErrorState error={draft.error} retry={() => void draft.refetch()} />;
  const d = draft.data.draft;
  const selected = path ?? (d.files.some((f) => f.path === 'SKILL.md') ? 'SKILL.md' : d.files[0]?.path ?? null);

  return (
    <section aria-label={`Draft ${name}`} className="space-y-2 rounded border border-[var(--rule)] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">Draft {d.name}</h3>
        <Chip>not active</Chip>
        {d.base ? <span className="text-xs text-[var(--ink-dim)]">based on <code>{d.base.id}</code> <Digest value={d.base.digest} /></span> : <span className="text-xs text-[var(--ink-dim)]">new skill</span>}
        <span className="text-xs text-[var(--ink-dim)]">draft digest <Digest value={d.digest} /></span>
      </div>
      {!d.validation.valid && <ul role="alert" className="list-disc pl-5 text-xs text-[var(--warn)]">{d.validation.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      {d.validation.warnings.length > 0 && <ul className="list-disc pl-5 text-xs text-amber-700 dark:text-amber-400">{d.validation.warnings.map((e) => <li key={e}>{e}</li>)}</ul>}
      <div className="flex flex-col gap-2 md:flex-row">
        <ul aria-label="Draft files" className="shrink-0 space-y-0.5 text-xs md:w-56">
          {d.files.map((f) => (
            <li key={f.path}>
              <button type="button" className={`w-full truncate rounded px-1 py-1 text-left ${f.path === selected ? 'bg-[var(--paper-sunk)]' : ''}`} onClick={() => setPath(f.path)}>
                {f.path} <span className="text-[var(--ink-faint)]">{f.size} B</span>
              </button>
            </li>
          ))}
          <li>
            <form className="mt-1 flex gap-1" onSubmit={(e) => { e.preventDefault(); if (newPath.trim()) { setPath(newPath.trim()); setNewPath(''); } }}>
              <input aria-label="New file path" className={`${input} min-w-0 flex-1`} placeholder="references/notes.md" value={newPath} onChange={(e) => setNewPath(e.target.value)} />
              <button type="submit" className={button}>Add</button>
            </form>
          </li>
        </ul>
        <div className="min-w-0 flex-1">
          {selected ? <FileEditor key={selected} draft={name} path={selected} exists={d.files.some((f) => f.path === selected)} exec={d.files.find((f) => f.path === selected)?.exec ?? false} onSaved={setDraft} /> : <p className="text-xs">No files yet. Add SKILL.md first.</p>}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {!publishing && <button type="button" className={primary} disabled={!d.validation.valid} onClick={() => setPublishing(true)}>{d.base ? 'Prepare update' : 'Prepare new skill'}</button>}
        <button type="button" className={button} disabled={remove.isPending} onClick={() => { if (window.confirm(`Delete draft ${name}? Its files are discarded.`)) remove.mutate(); }}>Delete draft</button>
        {remove.isError && <span className="text-xs text-[var(--warn)]">{remove.error.message}</span>}
      </div>
      {publishing && <ChangeFlow key={d.digest} request={{ kind: d.base ? 'update' : 'create', skill: d.name, draft: d.name }} onDone={() => setPublishing(false)} />}
    </section>
  );
}

function FileEditor({ draft, path, exists, exec, onSaved }: { draft: string; path: string; exists: boolean; exec: boolean; onSaved: (d: Draft) => void }) {
  const file = useQuery({ queryKey: ['skills', 'draft-file', draft, path], queryFn: () => skillsApi.draftFile(draft, path), enabled: exists });
  const [text, setText] = useState('');
  const [executable, setExecutable] = useState(exec);
  useEffect(() => { if (file.data?.content != null) setText(file.data.content); }, [file.data]);
  const save = useMutation({ mutationFn: () => skillsApi.writeDraftFile(draft, { path, content: text, exec: executable }), onSuccess: (r) => onSaved(r.draft) });
  const del = useMutation({ mutationFn: () => skillsApi.deleteDraftFile(draft, path), onSuccess: (r) => onSaved(r.draft) });
  if (exists && file.isPending) return <Loading what={path} />;
  if (exists && file.isError) return <ErrorState error={file.error} retry={() => void file.refetch()} />;
  if (file.data?.kind === 'binary') return <p className="text-xs">{path} is a binary file; it cannot be edited here.</p>;
  return (
    <div className="space-y-1">
      <label className="block text-xs text-[var(--ink-dim)]" htmlFor={`draft-${path}`}>{path}{file.data?.truncated ? ' (shown truncated; saving would cut it, edit it outside the app)' : ''}</label>
      <textarea id={`draft-${path}`} className={`${input} h-72 w-full font-mono text-xs`} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={primary} disabled={save.isPending || file.data?.truncated} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save draft file'}</button>
        <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={executable} onChange={(e) => setExecutable(e.target.checked)} /> executable</label>
        {exists && <button type="button" className={button} disabled={del.isPending} onClick={() => del.mutate()}>Remove file</button>}
        {save.isSuccess && <span role="status" className="text-xs text-[var(--ink-dim)]">Draft file saved. The draft is not active.</span>}
        {(save.error || del.error) && <span role="alert" className="text-xs text-[var(--warn)]">{(save.error ?? del.error)!.message}</span>}
      </div>
    </div>
  );
}
