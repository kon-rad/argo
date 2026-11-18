import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { zoned } from '../../lib/time.js';
import { skillsApi, type ChangeRequest, type SkillCandidate, type SkillDetailResponse } from './api.js';
import { ChangeFlow } from './ChangeFlow.js';
import { DraftEditor } from './DraftEditor.js';
import { button, Chip, Digest, Empty, ErrorState, input, lifecycleTone, Loading, Reasons, Revision, StateChip } from './ui.js';

/** One skill: every candidate package, its instructions and files, who gets it, where it is installed, and its changes. */
export default function SkillDetail() {
  const { name = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const id = params.get('id') ?? undefined;
  const detail = useQuery({ queryKey: ['skills', 'skill', name, id], queryFn: () => skillsApi.skill(name, id) });
  if (detail.isPending) return <Loading what={name} />;
  if (detail.isError) return <ErrorState error={detail.error} retry={() => void detail.refetch()} />;
  const d = detail.data;
  const sel = d.selected;
  return (
    <div className="space-y-4 p-3 md:p-4">
      <p className="text-xs"><Link className="text-[var(--accent)]" to="/skills">← Library</Link></p>
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold tracking-tight">{d.name}</h1>
        <Chip tone={lifecycleTone(d.row.lifecycle.status)}>{d.row.lifecycle.status}</Chip>
        {d.row.lifecycle.replacement && <span className="text-xs">replaced by <Link className="text-[var(--accent)]" to={`/skills/s/${encodeURIComponent(d.row.lifecycle.replacement)}`}>{d.row.lifecycle.replacement}</Link></span>}
        {d.row.lifecycle.note && <span className="text-xs text-[var(--ink-dim)]">{d.row.lifecycle.note}</span>}
        <Chip tone={d.mode === 'managed' ? 'ok' : 'accent'}>{d.mode === 'managed' ? 'managed' : 'no managed policy'}</Chip>
      </header>
      {sel?.description && <p className="text-sm text-[var(--ink-dim)]">{sel.description}</p>}

      <Section title="Packages with this name">
        <ul className="space-y-2">
          {d.row.candidates.map((c) => (
            <Candidate key={c.id} c={c} selected={sel?.id === c.id} onSelect={() => setParams(c.effective ? {} : { id: c.id })} />
          ))}
        </ul>
      </Section>

      {sel && (
        <>
          <Section title="Instructions">
            {d.instructions.trim() ? (
              <div className="prose max-w-none text-sm"><ReactMarkdown remarkPlugins={[remarkGfm]}>{d.instructions}</ReactMarkdown></div>
            ) : <Empty>This SKILL.md has no body.</Empty>}
          </Section>
          <Files name={d.name} id={sel.id} files={d.files} />
        </>
      )}

      <Section title="History">
        {d.history.length ? (
          <ul className="space-y-0.5 text-xs">
            {d.history.map((h) => <li key={h.revision}><code title={h.revision}>{h.revision.slice(0, 8)}</code> {zoned(h.date)} {h.subject}</li>)}
          </ul>
        ) : <Empty>No Git history for this package (not committed, or not in a Git checkout).</Empty>}
      </Section>

      <Section title="Agents">
        <Agents d={d} />
      </Section>

      <Section title="Installed on machines">
        {d.hosts.length ? (
          <ul className="space-y-1 text-xs">
            {d.hosts.map((h) => (
              <li key={`${h.host}/${h.agent}/${h.runtime}`} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{h.host}</span> {h.agent} on {h.runtime}
                <Chip tone={h.state === 'match' ? 'ok' : h.state === 'unknown' ? 'dim' : 'warn'}>{h.state}</Chip>
                <Digest value={h.observed} /> <span className="text-[var(--ink-faint)]">acknowledged {zoned(h.receivedAt)}</span>
              </li>
            ))}
          </ul>
        ) : <Empty>No machine has acknowledged installing this skill. Machines that never ran a sync are unknown, not up to date.</Empty>}
      </Section>

      {d.dependents.length > 0 && (
        <Section title="Skills that depend on it">
          <p className="text-sm">{d.dependents.map((n, i) => <span key={n}>{i > 0 && ', '}<Link className="text-[var(--accent)]" to={`/skills/s/${encodeURIComponent(n)}`}>{n}</Link></span>)}</p>
        </Section>
      )}

      <Section title="Change this skill">
        <Lifecycle d={d} />
      </Section>

      {(d.drafts.length > 0 || d.changes.length > 0) && (
        <Section title="Drafts and changes">
          {d.drafts.map((dr) => <DraftEditor key={dr.name} name={dr.name} onDeleted={() => void detail.refetch()} />)}
          {d.changes.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs">
              {d.changes.map((c) => (
                <li key={c.id}><code>{c.id}</code> {c.kind} <Chip>{c.status}</Chip> {c.preview.summary}{c.status === 'proposed' && <> · apply with <code>secondbrain skills apply {c.id}</code></>}</li>
              ))}
            </ul>
          )}
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="rounded border border-[var(--rule)] p-3">
      <h2 className="mb-2 font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

function Candidate({ c, selected, onSelect }: { c: SkillCandidate; selected: boolean; onSelect: () => void }) {
  return (
    <li className={`rounded border p-2 text-xs ${selected ? 'border-[var(--accent)]' : 'border-[var(--rule)]'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <code className="text-sm">{c.id}</code>
        {c.effective ? <Chip tone="ok">in use</Chip> : c.shadowedBy ? <Chip title={`Replaced by ${c.shadowedBy}`}>shadowed by {c.shadowedBy}</Chip> : null}
        {c.linkOf && <Chip title="A link to another package, so the same files">link of {c.linkOf}</Chip>}
        {!c.valid && <Chip tone="bad">invalid</Chip>}
        {!selected && <button type="button" className={button} onClick={onSelect}>View</button>}
      </div>
      <div className="mt-1 flex flex-wrap gap-3 text-[var(--ink-dim)]">
        <span>{c.root}/{c.relPath}</span>
        <span><Digest value={c.digest} /></span>
        <Revision revision={c.revision} dirty={c.dirty} />
        <span>{c.files} files, {c.bytes} bytes</span>
        {c.metadata.version && <span>version {c.metadata.version}</span>}
        {c.metadata.owner && <span>owner {c.metadata.owner}</span>}
      </div>
      {(c.metadata.depends.length > 0 || c.metadata.requires.bins.length > 0 || c.metadata.requires.env.length > 0) && (
        <p className="mt-1 text-[var(--ink-dim)]">
          {c.metadata.depends.length > 0 && <>needs skills {c.metadata.depends.join(', ')}. </>}
          {c.metadata.requires.bins.length > 0 && <>needs programs {c.metadata.requires.bins.join(', ')}. </>}
          {c.metadata.requires.env.length > 0 && <>needs settings {c.metadata.requires.env.join(', ')} (names only).</>}
        </p>
      )}
      {c.errors.length > 0 && <ul className="mt-1 list-disc pl-5 text-[var(--warn)]">{c.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      {c.warnings.length > 0 && <ul className="mt-1 list-disc pl-5 text-amber-700 dark:text-amber-400">{c.warnings.map((e) => <li key={e}>{e}</li>)}</ul>}
    </li>
  );
}

function Files({ name, id, files }: { name: string; id: string; files: SkillDetailResponse['files'] }) {
  const [open, setOpen] = useState<string | null>(null);
  const file = useQuery({ queryKey: ['skills', 'file', name, id, open], queryFn: () => skillsApi.file(name, id, open!), enabled: open !== null });
  return (
    <Section title={`Files (${files.length})`}>
      {files.length === 0 ? <Empty>No files could be read from this package.</Empty> : (
        <ul className="space-y-0.5 text-xs">
          {files.map((f) => (
            <li key={f.path}>
              <button type="button" className="text-left text-[var(--accent)] underline-offset-2 hover:underline" aria-expanded={open === f.path} onClick={() => setOpen(open === f.path ? null : f.path)}>{f.path}</button>{' '}
              <span className="text-[var(--ink-faint)]">{f.size} B{f.exec ? ', executable' : ''}{f.kind === 'binary' ? ', binary' : ''}</span>{' '}
              <code className="text-[var(--ink-faint)]" title={f.sha256}>{f.sha256.slice(0, 10)}</code>
              {open === f.path && (
                <div className="mt-1">
                  {file.isPending ? <Loading what={f.path} /> : file.isError ? <ErrorState error={file.error} retry={() => void file.refetch()} /> :
                    file.data.kind === 'binary' || file.data.content === null ? <p className="text-[var(--ink-dim)]">Binary file; not shown.</p> : (
                      <>
                        <pre className="max-h-96 overflow-auto whitespace-pre rounded bg-[var(--paper-sunk)] p-2">{file.data.content}</pre>
                        {file.data.truncated && <p className="text-[var(--ink-dim)]">Truncated: only the start of the file is shown.</p>}
                      </>
                    )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Agents({ d }: { d: SkillDetailResponse }) {
  const cells = d.agents.filter((c) => c.state !== 'not-assigned' || c.reference || c.loaded);
  if (!cells.length) return <Empty>No agent is assigned this skill and no agent's knowledge names it.</Empty>;
  return (
    <ul className="space-y-2">
      {cells.map((c) => (
        <li key={c.agent} className="text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Link className="font-medium text-[var(--accent)]" to={`/skills/agents/${encodeURIComponent(c.agent)}`}>{c.agent}</Link>
            <StateChip state={c.state} />
            {c.deprecated && <Chip tone="warn">deprecated</Chip>}
            {c.reference && <Chip title="A knowledge path in the org config names this skill. That is not a grant.">named in knowledge, not a grant</Chip>}
            <span className="text-xs text-[var(--ink-dim)]">
              {c.loaded ? <>loaded {zoned(c.loaded.at)} ({c.loaded.source}{c.loaded.digest ? `, ${c.loaded.digest.slice(7, 19)}` : ', revision not recorded'})</> : 'No load recorded'}
            </span>
          </div>
          <div className="ml-2 mt-0.5"><Reasons reasons={c.reasons} /></div>
        </li>
      ))}
    </ul>
  );
}

type Action = 'disable' | 'deprecate' | 'restore' | 'remove' | 'rollback';

function Lifecycle({ d }: { d: SkillDetailResponse }) {
  const qc = useQueryClient();
  const [action, setAction] = useState<Action | null>(null);
  const [replacement, setReplacement] = useState('');
  const [note, setNote] = useState('');
  const [resolve, setResolve] = useState(false);
  const [revision, setRevision] = useState('');
  const sel = d.selected;
  const status = d.row.lifecycle.status;
  const draft = useMutation({
    mutationFn: () => skillsApi.createDraft({ name: d.name, from: sel?.id }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['skills'] }),
  });
  const request: ChangeRequest | null = action === null ? null : {
    kind: action, skill: d.name,
    ...(action === 'deprecate' && replacement ? { replacement } : {}),
    ...(note ? { note } : {}),
    ...(action === 'remove' && resolve ? { resolve: true } : {}),
    ...(action === 'rollback' && revision ? { revision } : {}),
  };
  const ready = action !== 'rollback' || revision !== '';
  const pick = (a: Action) => { setAction(action === a ? null : a); };
  return (
    <div className="space-y-2">
      <p className="text-xs text-[var(--ink-dim)]">
        Every change is shown first and then exported for review; nothing here changes what agents get until it is applied and merged.
        Turning a skill off affects new sessions only; a session that already read it keeps it until it ends.
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={!sel || draft.isPending || d.drafts.some((x) => x.name === d.name)} onClick={() => draft.mutate()}>Edit as draft</button>
        {status === 'active' && <button type="button" className={button} aria-pressed={action === 'disable'} onClick={() => pick('disable')}>Turn off</button>}
        {status === 'active' && <button type="button" className={button} aria-pressed={action === 'deprecate'} onClick={() => pick('deprecate')}>Mark as replaced</button>}
        {status !== 'active' && <button type="button" className={button} aria-pressed={action === 'restore'} onClick={() => pick('restore')}>Restore</button>}
        {status !== 'removed' && <button type="button" className={button} aria-pressed={action === 'remove'} onClick={() => pick('remove')}>Retire</button>}
        <button type="button" className={button} disabled={!d.history.length} aria-pressed={action === 'rollback'} onClick={() => pick('rollback')}>Go back to an earlier version</button>
      </div>
      {draft.isError && <p role="alert" className="text-xs text-[var(--warn)]">{draft.error.message}</p>}
      {draft.isSuccess && <p role="status" className="text-xs">Draft created below. It is not active.</p>}
      {action && (
        <div className="space-y-2 rounded border border-[var(--rule)] p-2">
          {action === 'deprecate' && (
            <input aria-label="Replacement skill" className={input} placeholder="replacement skill (optional)" value={replacement} onChange={(e) => setReplacement(e.target.value)} />
          )}
          {action === 'remove' && (
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={resolve} onChange={(e) => setResolve(e.target.checked)} />
              Also take it away from every agent that is assigned it (otherwise retiring is refused while agents use it)
            </label>
          )}
          {action === 'rollback' && (
            <select aria-label="Earlier version" className={input} value={revision} onChange={(e) => setRevision(e.target.value)}>
              <option value="">choose a version…</option>
              {d.history.map((h) => <option key={h.revision} value={h.revision}>{h.revision.slice(0, 8)} {h.subject.slice(0, 60)}</option>)}
            </select>
          )}
          <input aria-label="Note" className={`${input} w-full`} placeholder="note for the reviewer (optional)" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          {ready && request && <ChangeFlow key={JSON.stringify(request)} request={request} onDone={() => setAction(null)} />}
        </div>
      )}
    </div>
  );
}
