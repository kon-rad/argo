import { useEffect, useId, useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { fileHref } from '../../lib/api.js';
import { projectsApi, type AreaLink, type AreaLinkGroup, type AreaStatus, type Stage, type TrackerEvent } from '../Projects.api.js';

/** What the tracker pages share: the chips, a section box, a link as the home note gave it, the archive dialog. */

export const STAGE_LABEL: Record<Stage, string> = {
  idea: 'Backlog', designing: 'Designing', building: 'Building', testing: 'Testing', live: 'Live', parked: 'Parked', done: 'Done',
};

export const chip = 'inline-block rounded border px-1.5 py-0.5 text-xs whitespace-nowrap';

export function StatusChip({ status }: { status: AreaStatus }) {
  return <span className={`${chip} ${status === 'active' ? 'border-[var(--accent)]' : 'border-[var(--rule)] text-[var(--ink-dim)]'}`}>{status === 'active' ? 'Active' : 'Parked'}</span>;
}

export function StageChip({ stage }: { stage: Stage }) {
  const strong = stage === 'testing' || stage === 'live';
  return <span className={`${chip} ${strong ? 'border-[var(--accent)]' : 'border-[var(--rule)] text-[var(--ink-dim)]'}`}>{STAGE_LABEL[stage]}</span>;
}

export function ArchivedChip() {
  return <span className={`${chip} border-[var(--rule)] text-[var(--ink-dim)]`}>Archived</span>;
}

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="min-w-0 rounded border border-[var(--rule)] p-3">
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <h2 id={id} className="font-semibold tracking-tight">{title}</h2>
        {aside && <span className="text-xs text-[var(--ink-dim)]">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

/** A URL opens in a new tab, a vault path opens the note, anything else is text. Long values wrap instead of widening the page. */
export function LinkItem({ link }: { link: AreaLink }) {
  const cls = 'break-all text-[var(--accent)] underline';
  if (link.href) return <a className={cls} href={link.href} target="_blank" rel="noreferrer">{link.text}</a>;
  if (link.path) return <Link className={cls} to={fileHref(link.path)}>{link.text}</Link>;
  return <span className="break-words">{link.text}</span>;
}

export function LinkGroups({ groups }: { groups: AreaLinkGroup[] }) {
  return (
    <dl className="space-y-1 text-sm">
      {groups.map((g) => (
        <div key={g.group} className="flex flex-wrap gap-x-2">
          <dt className="text-[var(--ink-dim)]">{g.group}</dt>
          <dd className="flex min-w-0 flex-wrap gap-x-3">
            {g.items.map((l, i) => <LinkItem key={i} link={l} />)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

const shown = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return 'none';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
};

/** One row of the change history in words. */
export function eventText(e: TrackerEvent): string {
  switch (e.kind) {
    case 'created': return 'added';
    case 'stage': return `${e.field === 'status' ? 'status' : 'stage'} ${shown(e.from)} → ${shown(e.to)}`;
    case 'archived': return 'archived';
    case 'unarchived': return 'unarchived';
    case 'frontmatter': return `home note: ${e.field ?? 'frontmatter'} changed`;
    case 'kpi_reading': return e.from === null || e.from === undefined ? `${e.field}: ${shown(e.to)}` : `${e.field}: ${shown(e.from)} → ${shown(e.to)}`;
    default: return `${e.field ?? e.kind}: ${shown(e.from)} → ${shown(e.to)}`;
  }
}

/**
 * Archive (or unarchive) an area or a project. Archiving asks for a note first: the note
 * is what the change history and the weekly review show next to the row. Nothing is
 * deleted, and the same button brings it back.
 */
export function ArchiveButton({ area, project = null, title, archived, onDone }: {
  area: string;
  project?: string | null;
  title: string;
  archived: boolean;
  onDone?: () => void;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const noteId = useId();
  const verb = archived ? 'Unarchive' : 'Archive';
  const act = useMutation({
    mutationFn: () => projectsApi.setArchived(!archived, area, project, note.trim() || undefined),
    onSuccess: () => {
      setOpen(false);
      setNote('');
      void qc.invalidateQueries({ queryKey: ['projects'] });
      onDone?.();
    },
  });
  const close = () => {
    setOpen(false);
    act.reset();
  };
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  // Unarchiving undoes a mistake, so it needs no reason; archiving does.
  const ready = archived || note.trim().length > 0;

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="rounded border border-[var(--rule)] px-2 py-1 text-sm text-[var(--ink-dim)] hover:text-[var(--ink)]">
        {verb}
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3" onClick={close}>
          <form
            role="dialog"
            aria-modal="true"
            aria-label={`${verb} ${title}`}
            className="w-full max-w-md space-y-3 rounded-lg border border-[var(--rule)] bg-[var(--paper)] p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => { e.preventDefault(); if (ready && !act.isPending) act.mutate(); }}
          >
            <h2 className="font-semibold tracking-tight">{verb} {title}</h2>
            <p className="text-sm text-[var(--ink-dim)]">
              {archived
                ? 'It comes back to every list as it was.'
                : project
                  ? 'It leaves the active lists. Nothing is deleted, and it can be unarchived.'
                  : 'It and its projects leave the active lists. Nothing is deleted, and it can be unarchived.'}
            </p>
            <div>
              <label htmlFor={noteId} className="mb-1 block text-sm">{archived ? 'Note (optional)' : 'Note: why is it being archived?'}</label>
              <textarea
                id={noteId}
                autoFocus
                rows={3}
                maxLength={500}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className="w-full rounded border border-[var(--rule)] bg-transparent p-2 text-sm"
              />
            </div>
            {act.isError && <p role="alert" className="text-sm text-[var(--warn)]">{act.error.message}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={close} className="rounded px-3 py-1 text-sm text-[var(--ink-dim)]">Cancel</button>
              <button type="submit" disabled={!ready || act.isPending} className="rounded bg-[var(--accent)] px-3 py-1 text-sm text-white disabled:opacity-50">
                {verb}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
