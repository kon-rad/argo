import type { ProviderWalletApi } from '@secondbrain/desk-contracts/desk';
import { ProviderSigning } from './ProviderSigning.js';
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Approval, DeskOperatorApi, Mutation, OperatorJob, Provider, ReleaseRequest, Result, WorkerResult } from '@secondbrain/desk-contracts/desk';
import { createHttpDeskOperatorApi } from './api.js';
import { createHttpCybazaarApi, type ApiResult, type Capabilities, type CybazaarApi, type DeskCategory, type Listing, type MarketAgent, type MarketMessage, type MarketplaceRequest } from './cybazaarApi.js';
import { AgentsView, Loaded, loading, MappingTag, MessageDetail, RequestDetail, ServicesView, short, statusLabel, type Load } from './Marketplace.js';

type View = 'overview' | 'inbox' | 'active' | 'review' | 'services' | 'agents';
const VIEWS: { id: View; label: string }[] = [
  { id: 'overview', label: 'Overview' }, { id: 'inbox', label: 'Inbox' }, { id: 'active', label: 'Active' },
  { id: 'review', label: 'Review' }, { id: 'services', label: 'Services' }, { id: 'agents', label: 'Agents' },
];
const box = 'rounded border border-[var(--rule)] bg-[var(--paper)] p-3';
const inputClass = 'min-w-0 rounded border border-[var(--rule)] bg-[var(--paper)] px-2 py-1 text-sm';
const primary = 'rounded bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50';
const secondary = 'rounded border border-[var(--rule)] px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50';
const httpOperatorApi = createHttpDeskOperatorApi();
const httpCybazaarApi = createHttpCybazaarApi();

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
      <span className="mt-2 block text-xs text-[var(--ink-faint)]">{publicJob?.client && <>Client {publicJob.client.length > 18 ? `${publicJob.client.slice(0, 10)}…${publicJob.client.slice(-6)}` : publicJob.client} · </>}{job.publicState.offer && <>Offer {money(job.publicState.offer.amountAtomic)} {job.publicState.offer.asset} · </>}Revision {job.revision} · {publicJob?.jobId ?? job.id}</span>
    </button>
  );
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
    const signing = api as DeskOperatorApi & Partial<ProviderWalletApi>;
    if (signing.prepareDelivery) return run(async () => {
      const prepared = await signing.prepareDelivery!(job.id, { ...request, ...mutation() });
      if (prepared.kind !== 'ok') return prepared;
      return api.job(job.id);
    }, 'Release approved. Provider wallet signature and independent confirmation are still required.');
    return run(() => api.release(job.id, { ...request, ...mutation() }), 'Release approval recorded.');
  };
  const state = job.publicState;
  return <div className="space-y-3">
    <header className="flex flex-wrap items-start justify-between gap-2"><div><h2 className="text-lg font-semibold">{state.job?.skill ?? 'Job details'}</h2><p className="text-xs text-[var(--ink-faint)]">{job.id} · revision {job.revision}</p></div><StateTag tone={job.execution === 'failed' ? 'warn' : 'muted'}>{executionLabel(job.execution)}</StateTag></header>
    {error && <div role="alert" className="rounded border border-[var(--warn)] p-2 text-sm text-[var(--warn)]">{error}</div>}
    {notice && <div role="status" className="rounded border border-[var(--rule)] p-2 text-sm">{notice}</div>}
    {['approved', 'queued', 'review', 'released'].includes(job.execution) && 'prepareClaim' in api && <ProviderSigning job={job} api={api as DeskOperatorApi & ProviderWalletApi} changed={onChanged} />}
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

/** Places a Desk job in one view; released, failed, cancelled and expired jobs are closed. */
export function jobCategory(execution: OperatorJob['execution']): DeskCategory {
  if (execution === 'awaiting_operator') return 'inbox';
  if (execution === 'approved' || execution === 'queued' || execution === 'running') return 'active';
  if (execution === 'review') return 'review';
  return 'closed';
}

type Selection = { kind: 'job' | 'request' | 'message'; id: string };
type ListItem = { key: string; node: ReactNode };
const fromResult = <T,>(result: ApiResult<T>): Load<T> => result.ok ? { state: 'ok', value: result.value } : result.code === 'unsupported' ? { state: 'unavailable', message: result.message } : { state: 'error', message: result.message };
const fromDesk = <T,>(result: Result<T>): Load<T> => result.kind === 'ok' ? { state: 'ok', value: result.value } : { state: 'error', message: result.message };
const companionMessage = (operation: string) => `Cybazaar does not provide the ${operation} integration operation yet. See the Hiring Desk README, "Cybazaar companion API".`;
const valueOf = <T,>(load: Load<T>): T | undefined => load.state === 'ok' ? load.value : undefined;

function RequestCard({ request, selected, onSelect }: { request: MarketplaceRequest; selected: boolean; onSelect: () => void }) {
  return <button type="button" onClick={onSelect} aria-pressed={selected} className={`w-full rounded border p-3 text-left ${selected ? 'border-[var(--accent)]' : 'border-[var(--rule)]'} hover:bg-[var(--paper-sunk)]`}>
    <span className="flex items-start justify-between gap-2"><span className="font-medium">{request.title}</span><StateTag tone={request.mapping.state === 'mapped' ? 'muted' : 'warn'}>{statusLabel[request.status]}</StateTag></span>
    <span className="mt-1 block text-xs text-[var(--ink-dim)]">Cybazaar request · {String(request.listing_snapshot.listingName ?? '')}{request.card ? ` · ticket ${request.card.status}` : ''}</span>
    <span className="mt-1 block"><MappingTag request={request} /></span>
  </button>;
}

function MessageCard({ message, agentName, selected, onSelect }: { message: MarketMessage; agentName: string; selected: boolean; onSelect: () => void }) {
  return <button type="button" onClick={onSelect} aria-pressed={selected} className={`w-full rounded border p-3 text-left ${selected ? 'border-[var(--accent)]' : 'border-[var(--rule)]'} hover:bg-[var(--paper-sunk)]`}>
    <span className="flex items-start justify-between gap-2"><span className="font-medium">Message to {agentName}</span><StateTag>Message</StateTag></span>
    <span className="mt-1 block line-clamp-2 text-xs text-[var(--ink-dim)]">{message.body}</span>
    <span className="mt-1 block text-xs text-[var(--ink-faint)]">From {short(message.sender_wallet)} · {new Date(message.created_at).toLocaleString()}</span>
  </button>;
}

function SourceNotice({ label, load }: { label: string; load: Load<unknown> }) {
  if (load.state === 'error') return <div role="alert" className="rounded border border-[var(--warn)] p-2 text-sm text-[var(--warn)]">{label} unavailable: {load.message}</div>;
  if (load.state === 'unavailable') return <p className="rounded border border-dashed border-[var(--rule)] p-2 text-xs text-[var(--ink-dim)]"><b>{label}: not available.</b> {load.message}</p>;
  return null;
}

function Overview({ jobs, requests, messages, listings, agents, providers, onOpen }: { jobs: Load<OperatorJob[]>; requests: Load<MarketplaceRequest[]>; messages: Load<MarketMessage[]>; listings: Load<Listing[]>; agents: Load<MarketAgent[]>; providers: Load<Provider[]>; onOpen: (view: View, selection: Selection | null) => void }) {
  const jobList = valueOf(jobs), requestList = valueOf(requests), messageList = valueOf(messages), listingList = valueOf(listings), agentList = valueOf(agents), providerList = valueOf(providers);
  const count = (category: DeskCategory) => (jobList ? jobList.filter(job => jobCategory(job.execution) === category).length : 0) + (requestList ? requestList.filter(request => request.category === category).length : 0);
  const known = (...loads: Load<unknown>[]) => loads.some(load => load.state === 'ok');
  const tile = (label: string, amount: number | null, view: View) => <button type="button" key={label} aria-label={`${label}: ${amount ?? 'unknown'}`} className={`${box} text-left hover:bg-[var(--paper-sunk)]`} onClick={() => onOpen(view, null)}><div className="text-2xl font-semibold tabular-nums">{amount ?? '–'}</div><div className="text-xs text-[var(--ink-dim)]">{label}</div></button>;
  const activity = useMemo(() => {
    const nameOf = (id: string) => agentList?.find(agent => agent.id === id)?.name ?? 'an agent';
    const items: { at: number; key: string; text: string; view: View; selection: Selection }[] = [];
    for (const request of requestList ?? []) if (request.category !== 'closed') items.push({ at: Date.parse(request.updated_at) || 0, key: `r:${request.id}`, text: `Request “${request.title}” · ${statusLabel[request.status]}${request.mapping.state !== 'mapped' ? ` · mapping ${request.mapping.state}` : ''}`, view: request.category as View, selection: { kind: 'request', id: request.id } });
    for (const message of messageList ?? []) items.push({ at: Date.parse(message.created_at) || 0, key: `m:${message.id}`, text: `Message to ${nameOf(message.agent_id)} from ${short(message.sender_wallet)}`, view: 'inbox', selection: { kind: 'message', id: message.id } });
    items.sort((a, b) => b.at - a.at);
    for (const job of jobList ?? []) { const category = jobCategory(job.execution); if (category !== 'closed') items.push({ at: 0, key: `j:${job.id}`, text: `Desk job ${job.publicState.job?.skill ?? job.id} · ${executionLabel(job.execution)}`, view: category, selection: { kind: 'job', id: job.id } }); }
    return items.slice(0, 12);
  }, [jobList, requestList, messageList, agentList]);
  const mappingProblems = (requestList ?? []).filter(request => request.category === 'inbox' && request.mapping.state !== 'mapped');
  const sources: [string, Load<unknown>][] = [['Desk jobs', jobs], ['Cybazaar requests', requests], ['Messages', messages], ['Services', listings], ['Cybazaar agents', agents]];
  return <div className="space-y-3">
    <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
      {tile('Inbox', known(jobs, requests, messages) ? count('inbox') + (messageList?.length ?? 0) : null, 'inbox')}
      {tile('Active', known(jobs, requests) ? count('active') : null, 'active')}
      {tile('Review', known(jobs, requests) ? count('review') : null, 'review')}
      {tile('Services', listingList ? listingList.filter(listing => listing.status !== 'unlisted').length : null, 'services')}
      {tile('Agents', agentList || providerList ? (agentList?.length ?? 0) + (providerList?.length ?? 0) : null, 'agents')}
    </div>
    {sources.map(([label, load]) => <SourceNotice key={label} label={label} load={load} />)}
    <div className="grid gap-3 md:grid-cols-2">
      <Panel title="Recent activity">{activity.length ? <ul className="space-y-1 text-sm">{activity.map(item => <li key={item.key}><button type="button" className="text-left underline-offset-2 hover:underline" onClick={() => onOpen(item.view, item.selection)}>{item.text}</button></li>)}</ul> : <p className="text-sm text-[var(--ink-faint)]">{[jobs, requests, messages].some(load => load.state === 'loading') ? 'Loading activity…' : 'No open activity.'}</p>}</Panel>
      <Panel title="Needs attention">{mappingProblems.length ? <ul className="space-y-1 text-sm">{mappingProblems.map(request => <li key={request.id}><button type="button" className="text-left text-[var(--warn)] underline-offset-2 hover:underline" onClick={() => onOpen('inbox', { kind: 'request', id: request.id })}>“{request.title}”: agent mapping {request.mapping.state}</button></li>)}</ul> : <p className="text-sm text-[var(--ink-faint)]">No mapping problems.</p>}
        <p className="mt-2 text-xs text-[var(--ink-dim)]">Payment totals count only jobs whose public state confirms payment.</p></Panel>
    </div>
  </div>;
}

/** Private Desk page. The lead owns app route and navigation registration; this component owns its content. */
export default function Desk({ operatorApi = httpOperatorApi, cybazaarApi = httpCybazaarApi }: { operatorApi?: DeskOperatorApi; cybazaarApi?: CybazaarApi }) {
  const [view, setView] = useState<View>('overview');
  const [jobs, setJobs] = useState<Load<OperatorJob[]>>(loading);
  const [inboxJobs, setInboxJobs] = useState<Load<OperatorJob[]>>(loading);
  const [providers, setProviders] = useState<Load<Provider[]>>(loading);
  const [capabilities, setCapabilities] = useState<Load<Capabilities>>(loading);
  const [requests, setRequests] = useState<Load<MarketplaceRequest[]>>(loading);
  const [syncError, setSyncError] = useState('');
  const [listings, setListings] = useState<Load<Listing[]>>(loading);
  const [agents, setAgents] = useState<Load<MarketAgent[]>>(loading);
  const [messages, setMessages] = useState<Load<MarketMessage[]>>(loading);
  const [withheld, setWithheld] = useState(0);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [selectedJob, setSelectedJob] = useState<OperatorJob | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [detailError, setDetailError] = useState('');

  const refreshDesk = useCallback(async () => {
    const [inboxResult, jobsResult, providersResult] = await Promise.all([operatorApi.inbox(), operatorApi.jobs(), operatorApi.providers()]);
    setInboxJobs(fromDesk(inboxResult)); setJobs(fromDesk(jobsResult)); setProviders(fromDesk(providersResult));
  }, [operatorApi]);

  const refreshMarket = useCallback(async () => {
    const caps = await cybazaarApi.capabilities();
    if (!caps.ok) {
      // The routes are mounted only when Cybazaar is configured; 404 or 503 means it is not connected.
      const off: Load<never> = caps.status === 404 || caps.status === 503 ? { state: 'unavailable', message: 'Cybazaar is not connected to this Desk. Set CYBAZAAR_API_ORIGIN and CYBAZAAR_INTEGRATION_SECRET.' } : { state: 'error', message: caps.message };
      setCapabilities(off); setRequests(off); setListings(off); setAgents(off); setMessages(off); return;
    }
    setCapabilities({ state: 'ok', value: caps.value });
    const has = caps.value.companion;
    const [requestResult, listingResult, agentResult, messageResult] = await Promise.all([
      cybazaarApi.requests(),
      has.listings ? cybazaarApi.services() : null,
      has.agents ? cybazaarApi.agents() : null,
      has.messages && has.agents ? cybazaarApi.messages() : null,
    ]);
    if (requestResult.ok) { setRequests({ state: 'ok', value: requestResult.value.requests }); setSyncError(requestResult.value.syncError ?? ''); } else setRequests(fromResult(requestResult));
    setListings(listingResult ? (listingResult.ok ? { state: 'ok', value: listingResult.value.listings } : fromResult(listingResult)) : { state: 'unavailable', message: companionMessage('service listings') });
    setAgents(agentResult ? (agentResult.ok ? { state: 'ok', value: agentResult.value.agents } : fromResult(agentResult)) : { state: 'unavailable', message: companionMessage('agent profiles') });
    if (messageResult?.ok) { setMessages({ state: 'ok', value: messageResult.value.messages }); setWithheld(messageResult.value.withheld); }
    else setMessages(messageResult ? fromResult(messageResult) : { state: 'unavailable', message: companionMessage(has.messages ? 'agent profiles (needed to scope messages)' : 'agent messages') });
  }, [cybazaarApi]);

  const refresh = useCallback(async (quiet = false) => {
    if (quiet) setRefreshing(true);
    await Promise.all([refreshDesk(), refreshMarket()]);
    setRefreshing(false);
  }, [refreshDesk, refreshMarket]);

  useEffect(() => { void refresh(); }, [refresh]);

  const loadJob = useCallback(async (id: string, openView = false) => {
    setSelection({ kind: 'job', id }); setSelectedJob(null); setDetailError('');
    const result = await operatorApi.job(id);
    if (result.kind === 'ok') {
      setSelectedJob(result.value);
      if (openView) { const category = jobCategory(result.value.execution); setView(category === 'closed' ? 'review' : category); }
    } else setDetailError(`${result.kind}: ${result.message}`);
  }, [operatorApi]);

  useEffect(() => {
    const jobId = new URLSearchParams(window.location.search).get('job');
    if (jobId) { setView('inbox'); void loadJob(jobId, true); }
  }, [loadJob]);

  const updateJob = useCallback((job: OperatorJob) => {
    setSelectedJob(job);
    setDetailError('');
    void refreshDesk();
    // Keep the selected pane on the newest server revision.
    void operatorApi.job(job.id).then((result) => {
      if (result.kind === 'ok') setSelectedJob(result.value);
      else if (result.kind === 'failed' && /STALE_REVISION/i.test(result.message)) setDetailError(result.message);
    });
  }, [operatorApi, refreshDesk]);

  const refreshAfterConflict = useCallback(async () => {
    if (selection?.kind !== 'job') return;
    const result = await operatorApi.job(selection.id);
    if (result.kind === 'ok') {
      setSelectedJob(result.value);
      setDetailError('This job changed since it was opened. The latest revision has been loaded.');
    }
  }, [operatorApi, selection]);

  const open = (next: View, target: Selection | null) => {
    setView(next); setDetailError('');
    if (!target) { setSelection(null); setSelectedJob(null); return; }
    if (target.kind === 'job') void loadJob(target.id); else { setSelectedJob(null); setSelection(target); }
  };

  const agentName = (id: string) => valueOf(agents)?.find(agent => agent.id === id)?.name ?? `agent ${short(id)}`;
  const isSelected = (kind: Selection['kind'], id: string) => selection?.kind === kind && selection.id === id;
  const category = view === 'inbox' || view === 'active' || view === 'review' ? view : null;
  const jobSource = category === 'inbox' ? inboxJobs : jobs;
  const items: ListItem[] = [];
  if (category) {
    if (category === 'inbox') for (const message of valueOf(messages) ?? []) items.push({ key: `m:${message.id}`, node: <MessageCard message={message} agentName={agentName(message.agent_id)} selected={isSelected('message', message.id)} onSelect={() => open('inbox', { kind: 'message', id: message.id })} /> });
    for (const request of valueOf(requests) ?? []) if (request.category === category) items.push({ key: `r:${request.id}`, node: <RequestCard request={request} selected={isSelected('request', request.id)} onSelect={() => open(category, { kind: 'request', id: request.id })} /> });
    for (const job of valueOf(jobSource) ?? []) if (jobCategory(job.execution) === category) items.push({ key: `j:${job.id}`, node: <JobCard job={job} selected={isSelected('job', job.id)} onSelect={() => void loadJob(job.id)} /> });
  }
  const sources: [string, Load<unknown>][] = category === 'inbox' ? [['Messages', messages], ['Cybazaar requests', requests], ['Desk jobs', inboxJobs]] : [['Cybazaar requests', requests], ['Desk jobs', jobs]];
  const stillLoading = sources.some(([, load]) => load.state === 'loading');
  const emptyLabel = category === 'inbox' ? 'Nothing waiting: no messages, new service requests or jobs awaiting approval.' : category === 'active' ? 'No active work.' : 'Nothing is waiting for review.';
  const selectedRequest = selection?.kind === 'request' ? valueOf(requests)?.find(request => request.id === selection.id) : undefined;
  const selectedMessage = selection?.kind === 'message' ? valueOf(messages)?.find(message => message.id === selection.id) : undefined;
  const companion = valueOf(capabilities)?.companion;
  const providerList = <section aria-label="Desk providers" className="space-y-2"><h2 className="font-semibold">Desk providers</h2><Loaded load={providers} label="Desk providers" empty="No Desk providers are registered." isEmpty={list => list.length === 0}>{list => list.map((provider) => <article key={provider.providerId} className={box}><h3 className="font-semibold">{provider.providerId}</h3><p className="text-sm">{provider.skill} · {provider.skillVersion}</p><p className="break-all text-xs text-[var(--ink-dim)]">Payment address: {provider.paymentAddress}</p><p className="text-xs text-[var(--ink-faint)]">Identity references: {provider.identityRefs.join(', ') || 'none'}</p></article>)}</Loaded></section>;

  return <main className="flex h-full min-h-0 flex-col">
    <header className="flex flex-wrap items-center gap-3 border-b border-[var(--rule)] px-4 py-3"><div><h1 className="text-xl font-semibold">Hiring Desk</h1><p className="text-xs text-[var(--ink-dim)]">Private operator console</p></div><nav aria-label="Desk sections" className="ml-auto flex flex-wrap gap-1">{VIEWS.map((item) => <button type="button" key={item.id} aria-current={view === item.id ? 'page' : undefined} onClick={() => open(item.id, null)} className={`rounded px-3 py-1.5 text-sm ${view === item.id ? 'bg-[var(--paper-sunk)] font-medium' : 'text-[var(--ink-dim)] hover:bg-[var(--paper-sunk)]'}`}>{item.label}</button>)}</nav><button type="button" className={secondary} disabled={refreshing} onClick={() => void refresh(true)}>{refreshing ? 'Refreshing…' : 'Refresh'}</button></header>
    <div className="min-h-0 flex-1 overflow-auto p-3 md:p-4">
      {syncError && <p role="status" className="mb-3 rounded border border-[var(--warn)] p-2 text-sm">Cybazaar sync: {syncError} Showing the last imported requests.</p>}
      {view === 'overview' && <Overview jobs={jobs} requests={requests} messages={messages} listings={listings} agents={agents} providers={providers} onOpen={open} />}
      {view === 'services' && <ServicesView listings={listings} agents={agents} requests={valueOf(requests) ?? []} api={cybazaarApi} canRemove={!!companion?.listing_removal} onChanged={() => void refreshMarket()} />}
      {view === 'agents' && <AgentsView agents={agents} listings={listings} api={cybazaarApi} canEdit={!!companion?.agent_profile_write} canRemove={!!companion?.listing_removal} onChanged={() => void refreshMarket()} providers={providerList} />}
      {category && <div className="grid min-h-[30rem] gap-3 lg:grid-cols-[minmax(16rem,0.8fr)_minmax(0,2fr)]">
        <section aria-label={`${VIEWS.find(item => item.id === category)!.label} items`} className="space-y-2">
          {sources.map(([label, load]) => <SourceNotice key={label} label={label} load={load} />)}
          {category === 'inbox' && withheld > 0 && <p className="text-xs text-[var(--ink-dim)]">{withheld} message{withheld === 1 ? '' : 's'} for agents outside this Desk's scope were withheld.</p>}
          {items.map(item => <div key={item.key}>{item.node}</div>)}
          {stillLoading && <p role="status" className="text-sm text-[var(--ink-dim)]">Loading…</p>}
          {!stillLoading && items.length === 0 && <p className="rounded border border-dashed border-[var(--rule)] p-4 text-sm text-[var(--ink-faint)]">{emptyLabel}</p>}
        </section>
        <section aria-label="Selected item" className={`${box} min-h-[24rem]`}>
          {detailError && <div role="alert" className="mb-3 rounded border border-[var(--warn)] p-2 text-sm text-[var(--warn)]">{detailError}{/STALE_REVISION|stale revision|revision conflict/i.test(detailError) && <button type="button" className="ml-2 underline" onClick={() => void refreshAfterConflict()}>Reload latest revision</button>}</div>}
          {selection?.kind === 'job' && !selectedJob && !detailError && <p role="status" className="text-sm">Loading job…</p>}
          {selection?.kind === 'job' && selectedJob && <JobDetail key={`${selectedJob.id}:${selectedJob.revision}`} job={selectedJob} api={operatorApi} onChanged={updateJob} onStale={() => void refreshAfterConflict()} />}
          {selectedRequest && <RequestDetail key={`${selectedRequest.id}:${selectedRequest.status}`} request={selectedRequest} api={cybazaarApi} onChanged={() => void refreshMarket()} />}
          {selectedMessage && <MessageDetail message={selectedMessage} agentName={agentName(selectedMessage.agent_id)} />}
          {selection && selection.kind !== 'job' && !selectedRequest && !selectedMessage && <p className="text-sm text-[var(--ink-faint)]">This item is no longer in the list.</p>}
          {!selection && <p className="py-8 text-center text-sm text-[var(--ink-faint)]">Select an item to see its details and actions.</p>}
        </section>
      </div>}
    </div>
  </main>;
}

