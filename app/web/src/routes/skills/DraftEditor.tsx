import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../lib/http.js';
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
          {selected ? <FileEditor key={selected} draft={name} path={selected} exists={d.files.some((f) => f.path === selected)} exec={d.files.find((f) => f.path === selected)?.exec ?? false} onSaved={setDraft} onKeepSelected={() => setPath(selected)} onDiscard={() => setPath(null)} /> : <p className="text-xs">No files yet. Add SKILL.md first.</p>}
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

type LocalFile = { content: string; exec: boolean };

function FileEditor({ draft, path, exists, exec, onSaved, onKeepSelected, onDiscard }: {
  draft: string; path: string; exists: boolean; exec: boolean; onSaved: (d: Draft) => void; onKeepSelected: () => void; onDiscard: () => void;
}) {
  const qc = useQueryClient();
  const file = useQuery({ queryKey: ['skills', 'draft-file', draft, path], queryFn: () => skillsApi.draftFile(draft, path), enabled: exists });
  const [text, setText] = useState('');
  const [executable, setExecutable] = useState(exec);
  const [expectedVersion, setExpectedVersion] = useState<string | null | undefined>(exists ? undefined : null);
  const [conflict, setConflict] = useState<LocalFile | null>(null);
  const [missingFile, setMissingFile] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  // Background refetches must not replace unsaved edits or advance their optimistic-write token.
  useEffect(() => {
    if (expectedVersion === undefined && conflict === null && file.data?.content != null && file.data.version) {
      setText(file.data.content); setExecutable(file.data.exec ?? exec); setExpectedVersion(file.data.version);
    }
  }, [file.data, expectedVersion, conflict]);
  const refreshCurrent = async (): Promise<'present' | 'missing' | 'error'> => {
    setRefreshing(true); setRefreshError(null);
    try {
      const current = await file.refetch();
      if (current.isError && current.error instanceof ApiError && current.error.status === 404) {
        setMissingFile(true); setExpectedVersion(null); setText(''); setExecutable(false);
        await qc.invalidateQueries({ queryKey: ['skills', 'draft', draft] });
        return 'missing';
      }
      if (current.isError || !current.data?.version) {
        setExpectedVersion(undefined); setRefreshError('The current file could not be refreshed. Try again before saving.');
        return 'error';
      }
      setMissingFile(false); setText(current.data.content ?? ''); setExecutable(current.data.exec ?? exec); setExpectedVersion(current.data.version);
      await qc.invalidateQueries({ queryKey: ['skills', 'draft', draft] });
      return 'present';
    } finally { setRefreshing(false); }
  };
  const handleConflict = async (error: Error, backup: LocalFile) => {
    if (error instanceof ApiError && error.status === 409) {
      setConflict(backup); setMissingFile(false); setExpectedVersion(undefined); await refreshCurrent();
    }
  };
  const save = useMutation({
    mutationFn: (value: LocalFile & { expectedVersion: string | null }) => skillsApi.writeDraftFile(draft, { path, ...value }),
    onSuccess: async (r, value) => {
      // Refresh after setting the save response so a newer deletion cannot be hidden by stale listing data.
      onSaved(r.draft);
      if (await refreshCurrent() === 'present') setConflict(null);
      else setConflict({ content: value.content, exec: value.exec });
    },
    onError: (error, value) => handleConflict(error, { content: value.content, exec: value.exec }),
  });
  const del = useMutation({
    mutationFn: (value: LocalFile & { expectedVersion: string }) => skillsApi.deleteDraftFile(draft, path, value.expectedVersion),
    onSuccess: (r) => { setExpectedVersion(null); setText(''); setExecutable(false); setMissingFile(true); setConflict(null); save.reset(); onSaved(r.draft); },
    onError: (error, value) => handleConflict(error, { content: value.content, exec: value.exec }),
  });
  if (exists && file.isPending) return <Loading what={path} />;
  if (exists && file.isError && conflict === null && !missingFile) return <ErrorState error={file.error} retry={() => void file.refetch()} />;
  const currentFile = missingFile ? undefined : file.data;
  if (currentFile?.kind === 'binary' && conflict === null) return <p className="text-xs">{path} is a binary file; it cannot be edited here.</p>;
  const unresolved = conflict !== null || expectedVersion === undefined;
  const pending = save.isPending || del.isPending;
  return (
    <div className="space-y-1">
      <label className="block text-xs text-[var(--ink-dim)]" htmlFor={`draft-${path}`}>{path}{currentFile?.truncated ? ' (shown truncated; saving would cut it, edit it outside the app)' : ''}</label>
      <textarea id={`draft-${path}`} className={`${input} h-72 w-full font-mono text-xs`} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} disabled={pending || conflict !== null} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={primary} disabled={pending || unresolved || currentFile?.truncated || refreshing} onClick={() => { if (expectedVersion !== undefined) { onKeepSelected(); save.mutate({ content: text, exec: executable, expectedVersion }); } }}>{save.isPending ? 'Saving…' : 'Save draft file'}</button>
        <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={executable} onChange={(e) => setExecutable(e.target.checked)} disabled={pending || conflict !== null} /> executable</label>
        {exists && <button type="button" className={button} disabled={pending || unresolved || typeof expectedVersion !== 'string' || refreshing} onClick={() => { if (typeof expectedVersion === 'string') { onKeepSelected(); del.mutate({ expectedVersion, content: text, exec: executable }); } }}>Remove file</button>}
        {save.isSuccess && conflict === null && !missingFile && <span role="status" className="text-xs text-[var(--ink-dim)]">Draft file saved. The draft is not active.</span>}
        {del.isSuccess && <span role="status" className="text-xs text-[var(--ink-dim)]">Draft file removed.</span>}
        {(save.error || del.error) && <span role="alert" className="text-xs text-[var(--warn)]">{(save.error ?? del.error)!.message}</span>}
      </div>
      {conflict !== null && <section aria-label="Draft file conflict" className="space-y-1 rounded border border-[var(--warn)] p-2 text-xs">
        <p role="alert">{missingFile ? 'Another client removed this file. The draft listing has been refreshed. Recreate it explicitly from your retained changes, or discard them.' : 'Your local text and executable mode are retained below. Review the refreshed current file before choosing which changes to keep.'}</p>
        <textarea aria-label="Your unsaved draft changes" className={`${input} h-40 w-full font-mono text-xs`} value={conflict.content} readOnly />
        <label className="flex items-center gap-1"><input type="checkbox" aria-label="Your unsaved executable choice" checked={conflict.exec} disabled /> Your unsaved executable mode: {conflict.exec ? 'executable' : 'not executable'}</label>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={button} disabled={pending || refreshing} onClick={() => void refreshCurrent()}>Refresh current file</button>
          {missingFile ? <>
            <button type="button" className={primary} disabled={pending || refreshing || expectedVersion !== null} onClick={() => { save.reset(); del.reset(); save.mutate({ ...conflict, expectedVersion: null }); }}>Recreate file with my changes</button>
            <button type="button" className={button} disabled={pending || refreshing} onClick={() => { setConflict(null); save.reset(); del.reset(); onDiscard(); }}>Discard my local changes</button>
          </> : <>
            <button type="button" className={button} disabled={pending || refreshing || expectedVersion === undefined || currentFile?.kind === 'binary'} onClick={() => { setConflict(null); save.reset(); del.reset(); }}>Use current file</button>
            <button type="button" className={button} disabled={pending || refreshing || expectedVersion === undefined || currentFile?.kind === 'binary'} onClick={() => { setText(conflict.content); setExecutable(conflict.exec); setConflict(null); save.reset(); del.reset(); }}>Restore my text and mode to merge</button>
          </>}
        </div>
      </section>}
      {refreshError && <p role="alert" className="text-xs text-[var(--warn)]">{refreshError}</p>}
    </div>
  );
}
