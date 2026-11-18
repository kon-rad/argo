import { useMutation, useQueryClient } from '@tanstack/react-query';
import { skillsApi, type Change, type ChangePreview, type ChangeRequest } from './api.js';
import { button, Chip, Digest, primary } from './ui.js';

/**
 * Preview, then export. A preview writes nothing; exporting writes a change for review and activates nothing.
 * The copy says exactly that, so a preview is never mistaken for a saved or live change.
 */
export function ChangeFlow({ request, onDone }: { request: ChangeRequest; onDone?: () => void }) {
  const qc = useQueryClient();
  const preview = useMutation({ mutationFn: () => skillsApi.preview(request) });
  const propose = useMutation({
    mutationFn: () => skillsApi.propose({ ...request, ...(preview.data?.preview.fingerprint ? { expectedPreviewDigest: preview.data.preview.fingerprint } : {}), ...(request.draft && preview.data?.preview.targetDigest ? { expectedDraftDigest: preview.data.preview.targetDigest } : {}) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['skills'] }),
  });
  const p = preview.data?.preview;
  return (
    <div className="space-y-2">
      {!p && (
        <button type="button" className={button} disabled={preview.isPending} onClick={() => preview.mutate()}>
          {preview.isPending ? 'Checking…' : 'Show what would change'}
        </button>
      )}
      {preview.isError && <p role="alert" className="text-xs text-[var(--warn)]">Preview failed: {preview.error.message}</p>}
      {p && <PreviewView preview={p} />}
      {p && !propose.data && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={primary} disabled={p.blocked.length > 0 || propose.isPending} onClick={() => propose.mutate()}>
            {propose.isPending ? 'Exporting…' : 'Export for review'}
          </button>
          <button type="button" className={button} onClick={() => { preview.reset(); onDone?.(); }}>Cancel</button>
          <span className="text-xs text-[var(--ink-dim)]">This is a preview only. Nothing has been saved or changed yet.</span>
        </div>
      )}
      {propose.isError && <p role="alert" className="text-xs text-[var(--warn)]">Export refused: {propose.error.message}</p>}
      {propose.data && <Exported change={propose.data.change} />}
    </div>
  );
}

export function Exported({ change }: { change: Change }) {
  return (
    <div role="status" className="rounded border border-[var(--accent)] p-2 text-sm">
      <p>
        Exported for review as change <code>{change.id}</code>. Nothing is active until the change is applied with{' '}
        <code>secondbrain skills apply {change.id}</code> and merged. Machines receive it only after they sync; check their acknowledgements separately.
      </p>
    </div>
  );
}

export function PreviewView({ preview: p }: { preview: ChangePreview }) {
  return (
    <section aria-label="Change preview" className="space-y-2 rounded border border-[var(--rule)] p-2 text-sm">
      <p className="flex flex-wrap items-center gap-2"><Chip>preview</Chip> {p.summary}</p>
      {p.blocked.length > 0 && (
        <div role="alert" className="text-xs text-[var(--warn)]">
          <p className="font-medium">This change cannot be exported yet:</p>
          <ul className="list-disc pl-5">{p.blocked.map((b) => <li key={b}>{b}</li>)}</ul>
        </div>
      )}
      {!p.validation.valid && <ul className="list-disc pl-5 text-xs text-[var(--warn)]">{p.validation.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      {p.validation.warnings.length > 0 && <ul className="list-disc pl-5 text-xs text-amber-700 dark:text-amber-400">{p.validation.warnings.map((e) => <li key={e}>{e}</li>)}</ul>}
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-[var(--ink-dim)]">From</dt><dd><Digest value={p.baseDigest} /> {p.baseRevision && <code title={p.baseRevision}>{p.baseRevision.slice(0, 8)}</code>}</dd>
        <dt className="text-[var(--ink-dim)]">To</dt><dd><Digest value={p.targetDigest} /></dd>
        <dt className="text-[var(--ink-dim)]">Agents</dt><dd>{p.affectedAgents.length ? p.affectedAgents.join(', ') : 'none'}</dd>
        <dt className="text-[var(--ink-dim)]">Machines</dt><dd>{p.affectedHosts.length ? p.affectedHosts.join(', ') : 'none acknowledged this skill'}</dd>
        <dt className="text-[var(--ink-dim)]">Depends on it</dt><dd>{p.dependents.length ? p.dependents.join(', ') : 'nothing'}</dd>
        {p.rollbackTarget && <><dt className="text-[var(--ink-dim)]">Undo with</dt><dd><code>{p.rollbackTarget}</code></dd></>}
      </dl>
      <p className="text-xs text-[var(--ink-dim)]">Running sessions: {p.runningSessions}</p>
      {p.files.map((f) => (
        <details key={f.path} className="text-xs">
          <summary className="cursor-pointer"><code>{f.path}</code> {f.change}</summary>
          <pre className="mt-1 max-h-72 overflow-auto whitespace-pre rounded bg-[var(--paper-sunk)] p-2">{f.diff || '(no text diff)'}</pre>
        </details>
      ))}
      {p.policyDiff && (
        <details className="text-xs" open={!p.files.length}>
          <summary className="cursor-pointer">Policy file change</summary>
          <pre className="mt-1 max-h-72 overflow-auto whitespace-pre rounded bg-[var(--paper-sunk)] p-2">{p.policyDiff}</pre>
        </details>
      )}
    </section>
  );
}
