import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Approval, DeskOperatorApi, Mutation, OperatorJob, Provider, ReleaseRequest, Result, WorkerResult } from '@secondbrain/desk-contracts/desk';
import { createHttpDeskOperatorApi } from './api.js';

type View = 'overview' | 'inbox' | 'jobs' | 'agents';
const VIEWS: { id: View; label: string }[] = [
  { id: 'overview', label: 'Overview' }, { id: 'inbox', label: 'Inbox' }, { id: 'jobs', label: 'Jobs' }, { id: 'agents', label: 'Agents' },
];
const box = 'rounded border border-[var(--rule)] bg-[var(--paper)] p-3';
const inputClass = 'min-w-0 rounded border border-[var(--rule)] bg-[var(--paper)] px-2 py-1 text-sm';
const primary = 'rounded bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50';
const secondary = 'rounded border border-[var(--rule)] px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50';
const httpOperatorApi = createHttpDeskOperatorApi();

function errorMessage<T>(result: Result<T>): string | null { return result.kind === 'ok' ? null : result.message; }
function newKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `desk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
function money(atomic: string | undefined): string { return atomic ? `${atomic} atomic units` : 'Unknown'; }
function isStale(message: string): boolean { return /STALE_REVISION|stale revision|revision conflict/i.test(message); }
function executionLabel(status: OperatorJob['execution']): string {
  return ({ awaiting_operator: 'Awaiting operator', approved: 'Approved', queued: 'Queued', running: 'Running', review: 'Ready for review', released: 'Released', failed: 'Failed', cancelled: 'Cancelled', expired: 'Expired' })[status];
}

function Panel({ title, children, className = '' }: { title: string; children: ReactNode; className?: string }) {
  return <section className={`${box} ${className}`}><h2 className="mb-2 font-semibold">{title}</h2>{children}</section>;
}

function StateTag({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'good' | 'warn' }) {
  const colors = tone === 'good' ? 'border-[var(--accent)]' : tone === 'warn' ? 'border-[var(--warn)] text-[var(--warn)]' : 'border-[var(--rule)] text-[var(--ink-dim)]';
  return <span className={`inline-flex rounded border px-2 py-0.5 text-xs ${colors}`}>{children}</span>;
}

function SafeMarkdown({ source }: { source: string }) {
  return <div className="prose max-w-none break-words text-sm"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: () => null, a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>{source}</ReactMarkdown></div>;
}

function JobCard({ job, selected, onSelect }: { job: OperatorJob; selected: boolean; onSelect: () => void }) {
  const publicJob = job.publicState.job;
  return (
    <button type="button" onClick={onSelect} aria-pressed={selected} className={`w-full rounded border p-3 text-left ${selected ? 'border-[var(--accent)]' : 'border-[var(--rule)]'} hover:bg-[var(--paper-sunk)]`}>
      <span className="flex items-start justify-between gap-2"><span className="font-medium">{publicJob?.skill ?? 'Desk job'}</span><StateTag tone={job.execution === 'failed' ? 'warn' : 'muted'}>{executionLabel(job.execution)}</StateTag></span>
      <span className="mt-1 block line-clamp-2 text-xs text-[var(--ink-dim)]">{publicJob?.brief ?? job.id}</span>
      <span className="mt-2 block text-xs text-[var(--ink-faint)]">Revision {job.revision} · {publicJob?.jobId ?? job.id}</span>
    </button>
  );
}

function Overview({ jobs, providers }: { jobs: OperatorJob[]; providers: Provider[] }) {
  const counts = useMemo(() => ({
    waiting: jobs.filter((job) => job.execution === 'awaiting_operator').length,
    running: jobs.filter((job) => job.execution === 'queued' || job.execution === 'running').length,
    review: jobs.filter((job) => job.execution === 'review').length,
    confirmed: jobs.filter((job) => job.publicState.stage === 'paid').length,
  }), [jobs]);
  const tile = (label: string, value: number) => <div key={label} className={box}><div className="text-2xl font-semibold tabular-nums">{value}</div><div className="text-xs text-[var(--ink-dim)]">{label}</div></div>;
  return <div className="space-y-3"><div className="grid grid-cols-2 gap-3 md:grid-cols-4">{tile('Waiting for approval', counts.waiting)}{tile('Queued or running', counts.running)}{tile('Ready for review', counts.review)}{tile('Confirmed payments', counts.confirmed)}</div>
    <div className="grid gap-3 md:grid-cols-2"><Panel title="Needs attention"><ul className="space-y-2 text-sm">{jobs.filter((job) => job.execution === 'awaiting_operator' || job.execution === 'review' || job.execution === 'failed').slice(0, 8).map((job) => <li key={job.id}>{job.publicState.job?.skill ?? job.id} <span className="text-[var(--ink-dim)]">· {executionLabel(job.execution)}</span></li>)}{jobs.every((job) => !['awaiting_operator', 'review', 'failed'].includes(job.execution)) && <li className="text-[var(--ink-faint)]">Nothing needs attention.</li>}</ul></Panel>
      <Panel title="Agents"><p className="text-sm">{providers.length} provider{providers.length === 1 ? '' : 's'} available.</p><p className="mt-1 text-xs text-[var(--ink-dim)]">Payment totals count only jobs whose public state confirms payment.</p></Panel></div>
  </div>;
}

function ApprovalForm({ job, busy, onApprove, onDecline }: { job: OperatorJob; busy: boolean; onApprove: (approval: Omit<Approval, keyof Mutation>) => Promise<void>; onDecline: () => Promise<void> }) {
  const offer = job.publicState.offer;
  const acceptanceDigest = job.publicState.acceptanceDigest ?? '';
  const [skillVersion, setSkillVersion] = useState(offer?.skillVersion ?? '');
  const [corpusDigest, setCorpusDigest] = useState('');
  const [inputRefs, setInputRefs] = useState('');
  const [audience, setAudience] = useState(job.id);
  const [expiresAt, setExpiresAt] = useState(String(Math.floor(Date.now() / 1000) + 3600));
  const [tools, setTools] = useState('');
  const [model, setModel] = useState('');
  const [maxCostAtomic, setMaxCostAtomic] = useState(offer?.amountAtomic ?? '');
  const [costAsset, setCostAsset] = useState(offer?.asset ?? '');
  const [maxRuntimeSeconds, setMaxRuntimeSeconds] = useState('300');
  const [maxOutputTokens, setMaxOutputTokens] = useState('4000');
  const [planDigest, setPlanDigest] = useState('');
  const canApprove = !!acceptanceDigest && !!skillVersion && !!corpusDigest && !!audience && !!planDigest && !!maxCostAtomic && !!costAsset && !!model && Number(expiresAt) > Math.floor(Date.now() / 1000);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canApprove) return;
    await onApprove({
      acceptanceDigest, skillVersion, corpusDigest, inputRefs: inputRefs.split('\n').map((ref) => ref.trim()).filter(Boolean),
      audience, expiresAt: Number(expiresAt), planDigest,
      limits: { tools: tools.split(',').map((tool) => tool.trim()).filter(Boolean), model, maxCostAtomic, costAsset, maxRuntimeSeconds: Number(maxRuntimeSeconds), maxOutputTokens: Number(maxOutputTokens) },
    });
  };
  return <form className="space-y-3" onSubmit={(event) => void submit(event)}>
    <p className="text-sm text-[var(--ink-dim)]">The client accepted the offer. This separate approval sets the private execution limits; review every value before dispatch.</p>
    <div className="grid gap-2 sm:grid-cols-2">
      <label className="space-y-1 text-xs">Accepted terms digest<input aria-label="Accepted terms digest" className={`block w-full ${inputClass}`} value={acceptanceDigest} readOnly /></label>
      <label className="space-y-1 text-xs">Skill version<input aria-label="Skill version" className={`block w-full ${inputClass}`} value={skillVersion} onChange={(e) => setSkillVersion(e.target.value)} required /></label>
      <label className="space-y-1 text-xs">Corpus digest<input aria-label="Corpus digest" className={`block w-full ${inputClass}`} value={corpusDigest} onChange={(e) => setCorpusDigest(e.target.value)} required /></label>
      <label className="space-y-1 text-xs">Execution plan digest<input aria-label="Execution plan digest" className={`block w-full ${inputClass}`} value={planDigest} onChange={(e) => setPlanDigest(e.target.value)} required /></label>
      <label className="space-y-1 text-xs">Allowed tools, comma separated<input aria-label="Allowed tools" className={`block w-full ${inputClass}`} value={tools} onChange={(e) => setTools(e.target.value)} /></label>
      <label className="space-y-1 text-xs">Model<input aria-label="Model" className={`block w-full ${inputClass}`} value={model} onChange={(e) => setModel(e.target.value)} required /></label>
      <label className="space-y-1 text-xs">Maximum cost (atomic units)<input aria-label="Maximum cost" className={`block w-full ${inputClass}`} inputMode="numeric" pattern="[0-9]+" value={maxCostAtomic} onChange={(e) => setMaxCostAtomic(e.target.value)} required /></label>
      <label className="space-y-1 text-xs">Cost asset<input aria-label="Cost asset" className={`block w-full ${inputClass}`} value={costAsset} onChange={(e) => setCostAsset(e.target.value)} required /></label>
      <label className="space-y-1 text-xs">Maximum runtime seconds<input aria-label="Maximum runtime seconds" className={`block w-full ${inputClass}`} type="number" min="1" value={maxRuntimeSeconds} onChange={(e) => setMaxRuntimeSeconds(e.target.value)} required /></label>
      <label className="space-y-1 text-xs">Maximum output tokens<input aria-label="Maximum output tokens" className={`block w-full ${inputClass}`} type="number" min="1" value={maxOutputTokens} onChange={(e) => setMaxOutputTokens(e.target.value)} required /></label>
      <label className="space-y-1 text-xs">Private execution audience<input aria-label="Private execution audience" className={`block w-full ${inputClass}`} value={audience} onChange={(e) => setAudience(e.target.value)} required /></label>
      <label className="space-y-1 text-xs">Approval expires (Unix seconds)<input aria-label="Approval expiry" className={`block w-full ${inputClass}`} type="number" min={Math.floor(Date.now() / 1000) + 1} value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} required /></label>
      <label className="space-y-1 text-xs sm:col-span-2">Approved input references, one per line<textarea aria-label="Approved input references" className={`block w-full ${inputClass}`} rows={2} value={inputRefs} onChange={(e) => setInputRefs(e.target.value)} /></label>
    </div>
    <div className="flex flex-wrap gap-2"><button type="submit" className={primary} disabled={busy || !canApprove}>{busy ? 'Submitting…' : 'Approve and dispatch'}</button><button type="button" className={secondary} disabled={busy} onClick={() => void onDecline()}>Decline job</button></div>
  </form>;
}

function JobDetail({ job, api, onChanged, onStale }: { job: OperatorJob; api: DeskOperatorApi; onChanged: (job: OperatorJob) => void; onStale: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState<WorkerResult | null>(null);
  const [destination, setDestination] = useState('');
  const canCancel = !['released', 'failed', 'cancelled', 'expired'].includes(job.execution);
  const run = async (action: () => Promise<Result<OperatorJob>>, done: string) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await action();
      if (result.kind === 'ok') { onChanged(result.value); setNotice(done); }
      else {
        setError(`${result.kind}: ${result.message}`);
        if (isStale(result.message)) { setNotice('This job changed since it was opened. Loading the latest revision.'); onStale(); }
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Request failed'); }
    finally { setBusy(false); }
  };
  const mutation = (): Mutation => ({ expectedRevision: job.revision, idempotencyKey: newKey() });
  const approve = (payload: Omit<Approval, keyof Mutation>) => run(() => api.approve(job.id, { ...payload, ...mutation() }), 'Approval accepted.');
  const decline = () => run(() => api.decline(job.id, mutation()), 'Job declined.');
  const cancel = () => run(() => api.cancel(job.id, mutation()), 'Stop request accepted.');
  const requestPreview = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api.preview(job.id);
      if (result.kind === 'ok') { setPreview(result.value); setNotice('Private result loaded for review.'); }
      else setError(`${result.kind}: ${result.message}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Preview request failed'); }
    finally { setBusy(false); }
  };
  const release = () => {
    if (!preview || !destination.trim()) return;
    const request: Omit<ReleaseRequest, keyof Mutation> = { artifactHash: preview.artifactHash, mediaType: preview.mediaType, publicDestination: destination.trim() };
    return run(() => api.release(job.id, { ...request, ...mutation() }), 'Release accepted.');
  };
  const state = job.publicState;
  return <div className="space-y-3">
    <header className="flex flex-wrap items-start justify-between gap-2"><div><h2 className="text-lg font-semibold">{state.job?.skill ?? 'Job details'}</h2><p className="text-xs text-[var(--ink-faint)]">{job.id} · revision {job.revision}</p></div><StateTag tone={job.execution === 'failed' ? 'warn' : 'muted'}>{executionLabel(job.execution)}</StateTag></header>
    {error && <div role="alert" className="rounded border border-[var(--warn)] p-2 text-sm text-[var(--warn)]">{error}</div>}
    {notice && <div role="status" className="rounded border border-[var(--rule)] p-2 text-sm">{notice}</div>}
    <div className="grid gap-3 md:grid-cols-2">
      <Panel title="Client-accepted terms">
        {state.acceptance ? <div className="space-y-1 text-sm"><StateTag tone="good">Client accepted</StateTag><p><b>Brief:</b></p><SafeMarkdown source={state.job?.brief ?? ''} /><p><b>Offer:</b> {money(state.offer?.amountAtomic)} {state.offer?.asset ?? ''}</p><p><b>Permitted tools:</b> defined at operator approval</p><p><b>Corpus:</b> defined at operator approval</p><p><b>Deadline:</b> {state.job?.deadline ? new Date(state.job.deadline * 1000).toLocaleString() : 'Unknown'}</p><p className="break-all text-xs text-[var(--ink-faint)]">Accepted terms: {state.acceptanceDigest ?? 'digest unavailable'}</p></div> : <p className="text-sm text-[var(--ink-faint)]">No verified client acceptance is attached.</p>}
      </Panel>
      <Panel title="Operator decision">
        {job.execution === 'awaiting_operator' && state.acceptance && <ApprovalForm job={job} busy={busy} onApprove={approve} onDecline={decline} />}
        {job.approval && <div className="space-y-1 text-sm"><StateTag tone="good">Operator approved</StateTag><p>Skill: {job.approval.skillVersion}</p><p>Maximum cost: {money(job.approval.limits.maxCostAtomic)} {job.approval.limits.costAsset}</p><p>Tools: {job.approval.limits.tools.join(', ') || 'none'}</p><p>Maximum runtime: {job.approval.limits.maxRuntimeSeconds}s</p><p>Audience: {job.approval.audience}</p></div>}
        {!job.approval && job.execution !== 'awaiting_operator' && <p className="text-sm text-[var(--ink-faint)]">No operator approval recorded.</p>}
        {canCancel && job.execution !== 'awaiting_operator' && <button type="button" className={`${secondary} mt-3`} disabled={busy} onClick={() => void cancel()}>{busy ? 'Requesting…' : 'Stop execution'}</button>}
      </Panel>
      {job.execution === 'cancelled' && <Panel title="Cancellation outcome"><StateTag>Execution cancelled</StateTag></Panel>}
      {job.execution === 'failed' && <Panel title="Execution outcome"><StateTag tone="warn">Execution failed</StateTag></Panel>}
      {job.result && <Panel title="Private execution trace"><p className="text-sm">Artifact {job.result.artifactHash} · {job.result.mediaType}</p><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-[var(--paper-sunk)] p-2 text-xs">{job.result.boundedTrace}</pre></Panel>}
      {state.stage === 'paid' ? <Panel title="Payment"><StateTag tone="good">Confirmed on public state</StateTag><p className="mt-1 text-sm">Payment is confirmed by the public reducer.</p></Panel> : <Panel title="Payment"><StateTag>Not confirmed</StateTag><p className="mt-1 text-sm text-[var(--ink-dim)]">Unknown or pending transfers are not counted as revenue.</p></Panel>}
      {(job.execution === 'review' || job.execution === 'released') && <Panel title="Review and release" className="md:col-span-2">
        <div className="flex flex-wrap gap-2"><button type="button" className={secondary} disabled={busy} onClick={() => void requestPreview()}>{busy ? 'Loading…' : 'Load private result'}</button><span className="self-center text-xs text-[var(--ink-dim)]">Preview data is rendered as markdown with embedded HTML disabled.</span></div>
        {preview && <div className="mt-3 space-y-2"><div className="text-xs text-[var(--ink-dim)]">Artifact hash: <code>{preview.artifactHash}</code> · {preview.mediaType}</div>
          <Panel title="Artifact reference"><SafeMarkdown source={preview.artifactRef} /><p className="mt-2 text-xs text-[var(--ink-faint)]">The API supplied an artifact reference. Release binds the exact hash and media type returned here.</p></Panel>
          <label className="block space-y-1 text-xs">Public destination<input aria-label="Public destination" className={`block w-full ${inputClass}`} value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="swarm://…" /></label>
          <button type="button" className={primary} disabled={busy || !destination.trim() || job.execution === 'released'} onClick={() => void release()}>{busy ? 'Submitting…' : job.execution === 'released' ? 'Already released' : 'Approve release'}</button>
        </div>}
      </Panel>}
    </div>
  </div>;
}

/** Private Desk page. The lead owns app route and navigation registration; this component owns its content. */
export default function Desk({ operatorApi = httpOperatorApi }: { operatorApi?: DeskOperatorApi }) {
  const [view, setView] = useState<View>('overview');
  const [inbox, setInbox] = useState<OperatorJob[] | null>(null);
  const [jobs, setJobs] = useState<OperatorJob[] | null>(null);
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedJob, setSelectedJob] = useState<OperatorJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [detailError, setDetailError] = useState('');

  const refresh = useCallback(async (quiet = false) => {
    if (quiet) setRefreshing(true); else setLoading(true);
    const [inboxResult, jobsResult, providersResult] = await Promise.all([operatorApi.inbox(), operatorApi.jobs(), operatorApi.providers()]);
    const nextErrors: Record<string, string> = {};
    if (inboxResult.kind === 'ok') setInbox(inboxResult.value); else nextErrors.inbox = errorMessage(inboxResult) ?? '';
    if (jobsResult.kind === 'ok') setJobs(jobsResult.value); else nextErrors.jobs = errorMessage(jobsResult) ?? '';
    if (providersResult.kind === 'ok') setProviders(providersResult.value); else nextErrors.providers = errorMessage(providersResult) ?? '';
    setErrors(nextErrors); setLoading(false); setRefreshing(false);
  }, [operatorApi]);

  useEffect(() => { void refresh(); }, [refresh]);

  const loadJob = useCallback(async (id: string) => {
    setSelectedId(id); setSelectedJob(null); setDetailError('');
    const result = await operatorApi.job(id);
    if (result.kind === 'ok') setSelectedJob(result.value);
    else setDetailError(`${result.kind}: ${result.message}`);
  }, [operatorApi]);

  const updateJob = useCallback((job: OperatorJob) => {
    setSelectedJob(job);
    setDetailError('');
    void refresh(true);
    // Keep the selected pane on the newest server revision.
    void operatorApi.job(job.id).then((result) => {
      if (result.kind === 'ok') setSelectedJob(result.value);
      else if (result.kind === 'failed' && /STALE_REVISION/i.test(result.message)) setDetailError(result.message);
    });
  }, [operatorApi, refresh]);

  const refreshAfterConflict = useCallback(async () => {
    if (!selectedId) return;
    const result = await operatorApi.job(selectedId);
    if (result.kind === 'ok') {
      setSelectedJob(result.value);
      setDetailError('This job changed since it was opened. The latest revision has been loaded.');
    }
  }, [operatorApi, selectedId]);

  const list = view === 'inbox' ? inbox : jobs;
  return <main className="flex h-full min-h-0 flex-col">
    <header className="flex flex-wrap items-center gap-3 border-b border-[var(--rule)] px-4 py-3"><div><h1 className="text-xl font-semibold">Hiring Desk</h1><p className="text-xs text-[var(--ink-dim)]">Private operator console</p></div><nav aria-label="Desk sections" className="ml-auto flex flex-wrap gap-1">{VIEWS.map((item) => <button type="button" key={item.id} aria-current={view === item.id ? 'page' : undefined} onClick={() => setView(item.id)} className={`rounded px-3 py-1.5 text-sm ${view === item.id ? 'bg-[var(--paper-sunk)] font-medium' : 'text-[var(--ink-dim)] hover:bg-[var(--paper-sunk)]'}`}>{item.label}</button>)}</nav><button type="button" className={secondary} disabled={refreshing || loading} onClick={() => void refresh(true)}>{refreshing ? 'Refreshing…' : 'Refresh'}</button></header>
    <div className="min-h-0 flex-1 overflow-auto p-3 md:p-4">
      {loading && <p role="status" className="py-8 text-center text-sm text-[var(--ink-dim)]">Loading Desk…</p>}
      {!loading && view === 'overview' && (errors.jobs || errors.providers) && <div role="alert" className="mb-3 rounded border border-[var(--warn)] p-2 text-sm text-[var(--warn)]">{errors.jobs || errors.providers}</div>}
      {!loading && view === 'overview' && <Overview jobs={jobs ?? []} providers={providers ?? []} />}
      {!loading && view === 'agents' && <section aria-label="Agents" className="space-y-2">{errors.providers && <div role="alert" className="rounded border border-[var(--warn)] p-2 text-sm">Agents unavailable: {errors.providers}</div>}{providers?.length ? providers.map((provider) => <article key={provider.providerId} className={box}><h2 className="font-semibold">{provider.providerId}</h2><p className="text-sm">{provider.skill} · {provider.skillVersion}</p><p className="break-all text-xs text-[var(--ink-dim)]">Payment address: {provider.paymentAddress}</p><p className="text-xs text-[var(--ink-faint)]">Identity references: {provider.identityRefs.join(', ') || 'none'}</p></article>) : !errors.providers && <p className="text-sm text-[var(--ink-faint)]">No agents are registered.</p>}</section>}
      {!loading && (view === 'inbox' || view === 'jobs') && <div className="grid min-h-[30rem] gap-3 lg:grid-cols-[minmax(16rem,0.8fr)_minmax(0,2fr)]">
        <section aria-label={view === 'inbox' ? 'Inbox jobs' : 'All jobs'} className="space-y-2">{errors[view] && <div role="alert" className="rounded border border-[var(--warn)] p-2 text-sm">{view === 'inbox' ? 'Inbox' : 'Jobs'} unavailable: {errors[view]}</div>}{list?.map((job) => <JobCard key={job.id} job={job} selected={selectedId === job.id} onSelect={() => void loadJob(job.id)} />)}{list?.length === 0 && <p className="rounded border border-dashed border-[var(--rule)] p-4 text-sm text-[var(--ink-faint)]">No {view === 'inbox' ? 'jobs waiting for review' : 'jobs'}.</p>}{!list && !errors[view] && <p className="text-sm text-[var(--ink-faint)]">No data available.</p>}</section>
        <section aria-label="Selected job" className={`${box} min-h-[24rem]`}>{detailError && <div role="alert" className="mb-3 rounded border border-[var(--warn)] p-2 text-sm text-[var(--warn)]">{detailError}{/STALE_REVISION|stale revision|revision conflict/i.test(detailError) && <button type="button" className="ml-2 underline" onClick={() => void refreshAfterConflict()}>Reload latest revision</button>}</div>}{selectedId && !selectedJob && !detailError && <p role="status" className="text-sm">Loading job…</p>}{selectedJob && <JobDetail key={`${selectedJob.id}:${selectedJob.revision}`} job={selectedJob} api={operatorApi} onChanged={updateJob} onStale={() => void refreshAfterConflict()} />}{!selectedId && <p className="py-8 text-center text-sm text-[var(--ink-faint)]">Select a job to review its terms and execution.</p>}</section>
      </div>}
    </div>
  </main>;
}
