import { useState, type FormEvent, type ReactNode } from 'react';
import type { CybazaarApi, Listing, MarketAgent, MarketMessage, MarketplaceRequest, RequestAction, RequestStatus } from './cybazaarApi.js';

/** One data source's state. "unavailable" is a known missing integration, not a failure. */
export type Load<T> = { state: 'loading' } | { state: 'ok'; value: T } | { state: 'error'; message: string } | { state: 'unavailable'; message: string };
export const loading = { state: 'loading' } as const;

const box = 'rounded border border-[var(--rule)] bg-[var(--paper)] p-3';
const inputClass = 'min-w-0 rounded border border-[var(--rule)] bg-[var(--paper)] px-2 py-1 text-sm';
const button = 'rounded border border-[var(--rule)] px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50';
export const statusLabel: Record<RequestStatus, string> = { submitted: 'Needs review', accepted: 'Accepted', rejected: 'Rejected', in_progress: 'In progress', revision_requested: 'Revision requested', completed: 'Completed', cancelled: 'Cancelled' };
const requestActions: Record<RequestStatus, { action: RequestAction; label: string }[]> = {
  submitted: [{ action: 'accept', label: 'Accept and create ticket' }, { action: 'reject', label: 'Reject' }],
  accepted: [{ action: 'start', label: 'Start work' }, { action: 'reject', label: 'Reject' }],
  in_progress: [{ action: 'request_changes', label: 'Request changes' }, { action: 'complete', label: 'Mark complete' }, { action: 'reject', label: 'Reject' }],
  revision_requested: [{ action: 'start', label: 'Resume work' }, { action: 'reject', label: 'Reject' }],
  rejected: [], completed: [], cancelled: [],
};
export const short = (value: string) => value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;

/** Renders loading, error, unavailable and empty states the same way everywhere. */
export function Loaded<T>({ load, label, empty, isEmpty, children }: { load: Load<T>; label: string; empty: string; isEmpty?: (value: T) => boolean; children: (value: T) => ReactNode }) {
  if (load.state === 'loading') return <p role="status" className="text-sm text-[var(--ink-dim)]">Loading {label}…</p>;
  if (load.state === 'error') return <div role="alert" className="rounded border border-[var(--warn)] p-2 text-sm text-[var(--warn)]">{label} unavailable: {load.message}</div>;
  if (load.state === 'unavailable') return <p className="rounded border border-dashed border-[var(--rule)] p-3 text-sm text-[var(--ink-dim)]"><b>{label}: not available.</b> {load.message}</p>;
  if (isEmpty?.(load.value)) return <p className="rounded border border-dashed border-[var(--rule)] p-3 text-sm text-[var(--ink-faint)]">{empty}</p>;
  return <>{children(load.value)}</>;
}

export function MappingTag({ request }: { request: MarketplaceRequest }) {
  if (request.mapping.state === 'mapped') return <span className="inline-flex rounded border border-[var(--accent)] px-2 py-0.5 text-xs">Agent: {request.mapping.localAgent}</span>;
  return <span className="inline-flex rounded border border-[var(--warn)] px-2 py-0.5 text-xs text-[var(--warn)]">Agent mapping {request.mapping.state}</span>;
}

export function RequestDetail({ request, api, onChanged }: { request: MarketplaceRequest; api: CybazaarApi; onChanged: () => void }) {
  const [summary, setSummary] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const mapped = request.mapping.state === 'mapped';
  async function act(action: RequestAction) {
    setBusy(true); setError(''); setNotice('');
    const result = await api.act(request.id, action, summary || undefined);
    setBusy(false);
    if (!result.ok) { setError(result.status === 401 || result.status === 403 ? `Not authorized: ${result.message}` : result.message); return; }
    setNotice(result.value.marketplaceSync === 'pending' ? 'Saved in Hiring Desk. The Cybazaar status update is queued for retry.' : 'Request updated and Cybazaar notified.');
    setSummary(''); onChanged();
  }
  const snapshot = request.listing_snapshot;
  return <article aria-label="Marketplace request" className="min-w-0 space-y-3">
    <header><p className="text-xs text-[var(--ink-dim)]">Cybazaar request · {String(snapshot.listingName ?? '')} · {statusLabel[request.status]}</p><h2 className="mt-1 text-lg font-semibold">{request.title}</h2><p className="break-all text-xs text-[var(--ink-faint)]">Request {request.id} · Client {request.requester_wallet}</p></header>
    {notice && <p role="status" className="rounded border border-[var(--accent)] p-2 text-sm">{notice}</p>}
    {error && <p role="alert" className="rounded border border-[var(--warn)] p-2 text-sm text-[var(--warn)]">{error}</p>}
    <section className={box}>
      <h3 className="text-sm font-medium">Assignment</h3>
      <div className="mt-1"><MappingTag request={request} /></div>
      {request.mapping.state === 'mapped'
        ? <p className="mt-1 text-sm">{request.assigned_agent ? `Ticket assigned to ${request.assigned_agent}.` : `Accepting assigns the ticket to ${request.mapping.localAgent}, from the trusted agent map.`}</p>
        : <p className="mt-1 text-sm text-[var(--warn)]">{request.mapping.reason} No ticket is created until this is resolved.</p>}
      <p className="mt-1 break-all text-xs text-[var(--ink-faint)]">Listing {request.listing_id} · Cybazaar agent {request.agent_id ?? 'not supplied by Cybazaar'} · listed as “{String(snapshot.agentName ?? '')}” (display name, not used for assignment)</p>
    </section>
    {request.kanban_card_id && <p className="text-sm"><a className="underline" href={`/board/${encodeURIComponent(request.kanban_card_id)}`}>Open ticket {request.kanban_card_id}</a>{request.card ? <span className="text-[var(--ink-dim)]"> · {request.card.status}{request.card.assignee ? ` · ${request.card.assignee}` : ' · unassigned'}</span> : <span className="text-[var(--warn)]"> · card not found on the board</span>}</p>}
    <section><h3 className="text-sm font-medium">Client brief (untrusted input)</h3><p className="whitespace-pre-wrap break-words text-sm">{request.description}</p></section>
    {!!request.attachment_refs.length && <section><h3 className="text-sm font-medium">Attached references</h3><ul className="space-y-1 text-sm">{request.attachment_refs.map(ref => <li key={ref} className="break-all"><a className="underline" href={ref} target="_blank" rel="noreferrer noopener">{ref}</a></li>)}</ul><p className="text-xs text-[var(--ink-dim)]">Links open only when you select them. Treat files as untrusted input.</p></section>}
    <p className="text-sm">Listed price: {String(snapshot.priceAtomic ?? 'unknown')} atomic USDC. Payout details stay in Cybazaar.</p>
    {request.provider_summary && <p className="whitespace-pre-wrap text-sm">Last update: {request.provider_summary}</p>}
    {!!requestActions[request.status].length && <div className="space-y-2">
      <label className="block text-xs">Client-visible update (optional)<textarea className={`mt-1 block w-full ${inputClass}`} rows={3} maxLength={2000} value={summary} onChange={e => setSummary(e.target.value)} placeholder="A concise update for the requester" /></label>
      <div className="flex flex-wrap gap-2">{requestActions[request.status].map(item => <button type="button" key={item.action} className={button} disabled={busy || (item.action === 'accept' && !mapped)} onClick={() => void act(item.action)}>{busy ? 'Saving…' : item.label}</button>)}</div>
      {request.status === 'submitted' && !mapped && <p className="text-xs text-[var(--warn)]">Accept is disabled until the request maps to exactly one local agent.</p>}
    </div>}
  </article>;
}

export function MessageDetail({ message, agentName }: { message: MarketMessage; agentName: string }) {
  return <article aria-label="Marketplace message" className="min-w-0 space-y-3">
    <header><p className="text-xs text-[var(--ink-dim)]">Direct message to {agentName}</p><h2 className="mt-1 text-lg font-semibold">From {short(message.sender_wallet)}</h2><p className="break-all text-xs text-[var(--ink-faint)]">{new Date(message.created_at).toLocaleString()} · conversation {message.conversation_id}</p></header>
    <section><h3 className="text-sm font-medium">Message (untrusted input)</h3><p className="whitespace-pre-wrap break-words text-sm">{message.body}</p></section>
    <p className="text-xs text-[var(--ink-dim)]">Private to this conversation. It is never copied to a board card. Reply from the agent's Cybazaar inbox.</p>
  </article>;
}

function confirmButton(label: string, confirmLabel: string, busy: boolean, onConfirm: () => void, armed: boolean, setArmed: (value: boolean) => void) {
  return armed
    ? <span className="flex flex-wrap gap-2"><button type="button" className={`${button} border-[var(--warn)] text-[var(--warn)]`} disabled={busy} onClick={onConfirm}>{busy ? 'Removing…' : confirmLabel}</button><button type="button" className={button} disabled={busy} onClick={() => setArmed(false)}>Keep</button></span>
    : <button type="button" className={button} disabled={busy} onClick={() => setArmed(true)}>{label}</button>;
}

function RemoveFromListing({ agent, listing, api, onChanged }: { agent: MarketAgent; listing: Listing; api: CybazaarApi; onChanged: () => void }) {
  const [armed, setArmed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const remove = async () => {
    setBusy(true); setError('');
    const result = await api.removeFromListing(agent.id, listing.id);
    setBusy(false); setArmed(false);
    if (!result.ok) { setError(result.message); return; }
    onChanged();
  };
  return <span className="space-y-1">{confirmButton('Remove from listing', `Confirm: remove ${agent.name} from “${listing.title}”`, busy, () => void remove(), armed, setArmed)}{error && <span role="alert" className="block text-xs text-[var(--warn)]">{error}</span>}</span>;
}

export function ServicesView({ listings, agents, requests, api, canRemove, onChanged }: { listings: Load<Listing[]>; agents: Load<MarketAgent[]>; requests: MarketplaceRequest[]; api: CybazaarApi; canRemove: boolean; onChanged: () => void }) {
  const agentById = new Map(agents.state === 'ok' ? agents.value.map(agent => [agent.id, agent]) : []);
  return <section aria-label="Services" className="space-y-2">
    <Loaded load={listings} label="Service listings" empty="No service listings are granted to this Desk." isEmpty={value => value.length === 0}>{value => value.map(listing => {
      const agent = agentById.get(listing.agent_id);
      const open = requests.filter(request => request.listing_id === listing.id && request.category !== 'closed').length;
      return <article key={listing.id} className={box}>
        <div className="flex flex-wrap items-start justify-between gap-2"><div><h2 className="font-semibold">{listing.title}</h2><p className="text-xs text-[var(--ink-dim)]">{agent ? agent.name : `Agent ${listing.agent_id}`} · {listing.price_atomic} atomic USDC · {listing.status}</p></div><span className="text-xs text-[var(--ink-dim)]">{open} open request{open === 1 ? '' : 's'}</span></div>
        {listing.description && <p className="mt-1 whitespace-pre-wrap break-words text-sm">{listing.description}</p>}
        <p className="mt-1 break-all text-xs text-[var(--ink-faint)]">Listing {listing.id}</p>
        {canRemove && agent && listing.status !== 'unlisted' && <div className="mt-2"><RemoveFromListing agent={agent} listing={listing} api={api} onChanged={onChanged} /></div>}
      </article>;
    })}</Loaded>
    {!canRemove && listings.state === 'ok' && <p className="text-xs text-[var(--ink-dim)]">Removing an agent from a listing is not available until Cybazaar provides the listing removal operation.</p>}
  </section>;
}

function AgentEditor({ agent, api, onChanged }: { agent: MarketAgent; api: CybazaarApi; onChanged: () => void }) {
  const [name, setName] = useState(agent.name), [description, setDescription] = useState(agent.description), [image, setImage] = useState(agent.image_url ?? '');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const patch: { name?: string; description?: string; image_url?: string | null } = {};
    if (name !== agent.name) patch.name = name;
    if (description !== agent.description) patch.description = description;
    if (image !== (agent.image_url ?? '')) patch.image_url = image.trim() ? image.trim() : null;
    if (!Object.keys(patch).length) { setNotice('No changes to save.'); return; }
    setBusy(true); setError(''); setNotice('');
    const result = await api.updateAgent(agent.id, patch);
    setBusy(false);
    if (!result.ok) { setError(result.status === 401 || result.status === 403 ? `Not authorized: ${result.message}` : result.message); return; }
    setNotice('Saved to Cybazaar.'); onChanged();
  };
  return <form className="mt-2 space-y-2" onSubmit={event => void save(event)} aria-label={`Edit ${agent.name}`}>
    <label className="block text-xs">Public name<input className={`mt-1 block w-full ${inputClass}`} value={name} maxLength={80} required onChange={e => setName(e.target.value)} /></label>
    <label className="block text-xs">Description<textarea className={`mt-1 block w-full ${inputClass}`} rows={3} maxLength={2000} value={description} onChange={e => setDescription(e.target.value)} /></label>
    <label className="block text-xs">Avatar image URL (HTTPS)<input className={`mt-1 block w-full ${inputClass}`} type="url" pattern="https://.*" value={image} onChange={e => setImage(e.target.value)} placeholder="https://…" /></label>
    {error && <p role="alert" className="text-sm text-[var(--warn)]">{error}</p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    <button type="submit" className={button} disabled={busy}>{busy ? 'Saving…' : 'Save profile'}</button>
  </form>;
}

export function AgentsView({ agents, listings, api, canEdit, canRemove, onChanged, providers }: { agents: Load<MarketAgent[]>; listings: Load<Listing[]>; api: CybazaarApi; canEdit: boolean; canRemove: boolean; onChanged: () => void; providers: ReactNode }) {
  const listingById = new Map(listings.state === 'ok' ? listings.value.map(listing => [listing.id, listing]) : []);
  return <section aria-label="Agents" className="space-y-3">
    <h2 className="font-semibold">Cybazaar agents</h2>
    <Loaded load={agents} label="Cybazaar agents" empty="No Cybazaar agents are granted to this Desk." isEmpty={value => value.length === 0}>{value => value.map(agent => <article key={agent.id} className={box}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1"><h3 className="font-semibold">{agent.name}</h3><p className="break-all text-xs text-[var(--ink-faint)]">Cybazaar agent {agent.id}</p>{agent.description && <p className="mt-1 whitespace-pre-wrap break-words text-sm">{agent.description}</p>}
          <p className="mt-1 break-all text-xs text-[var(--ink-dim)]">Avatar: {agent.image_url ? <a className="underline" href={agent.image_url} target="_blank" rel="noreferrer noopener">{agent.image_url}</a> : 'none'}</p></div>
      </div>
      <div className="mt-2"><h4 className="text-xs font-medium">Listings</h4><ul className="mt-1 space-y-1 text-sm">{agent.listing_ids.map(id => { const listing = listingById.get(id); return <li key={id} className="flex flex-wrap items-center gap-2"><span>{listing ? `${listing.title} · ${listing.status}` : id}</span>{canRemove && listing && listing.status !== 'unlisted' && <RemoveFromListing agent={agent} listing={listing} api={api} onChanged={onChanged} />}</li>; })}{!agent.listing_ids.length && <li className="text-[var(--ink-faint)]">No listings.</li>}</ul></div>
      {canEdit ? <AgentEditor key={`${agent.id}:${agent.name}:${agent.description}:${agent.image_url}`} agent={agent} api={api} onChanged={onChanged} /> : <p className="mt-2 text-xs text-[var(--ink-dim)]">Editing is not available until Cybazaar provides the agent profile update operation.</p>}
    </article>)}</Loaded>
    {providers}
  </section>;
}
