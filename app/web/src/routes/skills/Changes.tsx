import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { zoned } from '../../lib/time.js';
import { skillsApi, type Change } from './api.js';
import { DraftEditor } from './DraftEditor.js';
import { Chip, Empty, ErrorState, input, Loading, primary } from './ui.js';

const STATUS_TEXT: Record<Change['status'], string> = {
  proposed: 'exported, waiting to be applied',
  branch: 'committed on a review branch',
  live: 'merged and in use',
  stale: 'out of date: the skill changed since; make a new one',
};

/** Drafts being written and changes exported for review. */
export default function Changes() {
  const qc = useQueryClient();
  const drafts = useQuery({ queryKey: ['skills', 'drafts'], queryFn: skillsApi.drafts });
  const changes = useQuery({ queryKey: ['skills', 'changes'], queryFn: skillsApi.changes });
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => skillsApi.createDraft({ name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}) }),
    onSuccess: (r) => { setEditing(r.draft.name); setName(''); setDescription(''); void qc.invalidateQueries({ queryKey: ['skills'] }); },
  });
  return (
    <div className="space-y-4 p-3 md:p-4">
      <section aria-label="Drafts" className="space-y-2">
        <h2 className="font-semibold tracking-tight">Drafts</h2>
        <p className="text-xs text-[var(--ink-dim)]">Drafts are kept apart from every skill folder, so no agent sees them until a reviewed change publishes them.</p>
        <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate(); }}>
          <input aria-label="New skill name" className={`${input} min-w-0 flex-1 basis-40`} placeholder="new-skill-name" pattern="[a-z0-9][a-z0-9._-]{0,63}" value={name} onChange={(e) => setName(e.target.value)} />
          <input aria-label="Description" className={`${input} min-w-0 flex-[2] basis-60`} placeholder="what it does and when to use it" value={description} onChange={(e) => setDescription(e.target.value)} />
          <button type="submit" className={primary} disabled={!name.trim() || create.isPending}>Start a draft</button>
        </form>
        {create.isError && <p role="alert" className="text-xs text-[var(--warn)]">{create.error.message}</p>}
        {drafts.isPending ? <Loading what="drafts" /> : drafts.isError ? <ErrorState error={drafts.error} retry={() => void drafts.refetch()} /> :
          drafts.data.drafts.length === 0 ? <Empty>No drafts.</Empty> : (
            <ul className="space-y-1 text-sm">
              {drafts.data.drafts.map((d) => (
                <li key={d.name} className="flex flex-wrap items-center gap-2">
                  <button type="button" className="font-medium text-[var(--accent)]" aria-expanded={editing === d.name} onClick={() => setEditing(editing === d.name ? null : d.name)}>{d.name}</button>
                  <span className="text-xs text-[var(--ink-dim)]">{d.base ? `edits ${d.base.id}` : 'new skill'} · {d.files.length} files · updated {zoned(d.updatedAt)}</span>
                  {!d.validation.valid && <Chip tone="bad">needs fixes</Chip>}
                </li>
              ))}
            </ul>
          )}
        {editing && <DraftEditor key={editing} name={editing} onDeleted={() => setEditing(null)} />}
      </section>

      <section aria-label="Changes" className="space-y-2">
        <h2 className="font-semibold tracking-tight">Changes for review</h2>
        {changes.isPending ? <Loading what="changes" /> : changes.isError ? <ErrorState error={changes.error} retry={() => void changes.refetch()} /> :
          changes.data.changes.length === 0 ? <Empty>No changes exported yet. Changes are made from a skill's page or a draft.</Empty> : (
            <ul className="space-y-2">
              {changes.data.changes.map((c) => (
                <li key={c.id} className="rounded border border-[var(--rule)] p-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <code>{c.id}</code>
                    <Chip>{c.kind}</Chip>
                    <Link className="text-[var(--accent)]" to={`/skills/s/${encodeURIComponent(c.skill)}`}>{c.skill}</Link>
                    <Chip tone={c.status === 'live' ? 'ok' : c.status === 'stale' ? 'bad' : 'warn'}>{STATUS_TEXT[c.status]}</Chip>
                    <span className="text-xs text-[var(--ink-dim)]">{zoned(c.createdAt)}</span>
                  </div>
                  <p className="text-xs">{c.preview.summary}</p>
                  {c.status === 'proposed' && <p className="text-xs text-[var(--ink-dim)]">Apply on a machine with the vault checkout: <code>secondbrain skills apply {c.id}</code>, then open and merge the pull request.</p>}
                  {c.status === 'branch' && <p className="text-xs text-[var(--ink-dim)]">On branch <code>{c.branch}</code>{c.commit ? <> at <code>{c.commit.slice(0, 8)}</code></> : null}: push it and merge after review.</p>}
                </li>
              ))}
            </ul>
          )}
      </section>
    </div>
  );
}
