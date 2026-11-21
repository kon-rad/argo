import { useCallback, useEffect, useState } from 'react';

type RequestStatus='submitted'|'accepted'|'rejected'|'in_progress'|'revision_requested'|'completed'|'cancelled';
interface MarketplaceRequest{
  id:string;listing_id:string;requester_wallet:string;title:string;description:string;attachment_refs:string[];
  listing_snapshot:Record<string,unknown>;status:RequestStatus;provider_summary:string|null;kanban_card_id:string|null;
}
const button='rounded border border-[var(--rule)] px-3 py-2 text-sm disabled:opacity-50';
const statusLabel:Record<RequestStatus,string>={submitted:'Needs review',accepted:'Accepted',rejected:'Rejected',in_progress:'In progress',revision_requested:'Revision requested',completed:'Completed',cancelled:'Cancelled'};
const actions:Record<RequestStatus,{action:string;label:string}[]>={submitted:[{action:'accept',label:'Accept and create ticket'},{action:'reject',label:'Reject'}],accepted:[{action:'start',label:'Start work'},{action:'reject',label:'Reject'}],in_progress:[{action:'request_changes',label:'Request changes'},{action:'complete',label:'Mark complete'},{action:'reject',label:'Reject'}],revision_requested:[{action:'start',label:'Resume work'}],rejected:[],completed:[],cancelled:[]};

/** Private marketplace request inbox. Accepted items become ordinary, unassigned board cards. */
export function CybazaarInbox({request=fetch}:{request?:typeof fetch}){
  const[items,setItems]=useState<MarketplaceRequest[]>([]),[selected,setSelected]=useState(''),[summary,setSummary]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false)
  const load=useCallback(async()=>{
    const response=await request('/api/desk/cybazaar/requests',{credentials:'same-origin',cache:'no-store'})
    const body=await response.json().catch(()=>({}))
    if(!response.ok)throw new Error(body.error?.message??(response.status===503?'Cybazaar integration is not configured.':'Cannot load marketplace requests.'))
    setItems(body.requests);setError(body.syncError??'');if(!selected&&body.requests.length)setSelected(body.requests[0].id)
  },[request,selected])
  useEffect(()=>{void load().catch(e=>setError(e.message))},[load])
  const current=items.find(item=>item.id===selected)
  async function act(action:string){
    if(!current)return
    setBusy(true);setError('');setNotice('')
    try{
      const response=await request(`/api/desk/cybazaar/requests/${encodeURIComponent(current.id)}/${action}`,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({summary:summary||undefined})})
      const body=await response.json().catch(()=>({}))
      if(!response.ok)throw new Error(body.error?.message??'Request update failed.')
      setNotice(body.marketplaceSync==='pending'?'Saved in Hiring Desk. Cybazaar status update is queued for retry.':'Request updated and Cybazaar notified.')
      setSummary('');await load()
    }catch(e){setError(e instanceof Error?e.message:'Request update failed.')}finally{setBusy(false)}
  }
  return <section aria-label="Cybazaar marketplace requests" className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="text-lg font-semibold">Marketplace requests</h2><p className="text-sm text-[var(--ink-dim)]">Review requests for your listed agents. Accepting creates one unassigned Kanban ticket.</p></div><button className={button} disabled={busy} onClick={()=>void load().catch(e=>setError(e.message))}>Refresh</button></div>
    {notice&&<p role="status" className="rounded border border-[var(--accent)] p-3 text-sm">{notice}</p>}{error&&<p role="alert" className="rounded border border-[var(--warn)] p-3 text-sm">{error}</p>}
    <div className="grid gap-4 lg:grid-cols-[minmax(14rem,1fr)_minmax(0,2fr)]">
      <div className="space-y-2">{items.map(item=><button key={item.id} className={`${button} block w-full text-left ${selected===item.id?'bg-[var(--paper-sunk)]':''}`} aria-pressed={selected===item.id} onClick={()=>{setSelected(item.id);setSummary('')}}><b>{item.title}</b><span className="block text-xs">{String(item.listing_snapshot.agentName)} · {statusLabel[item.status]}</span><span className="mt-1 block line-clamp-2 text-xs text-[var(--ink-dim)]">{item.description}</span></button>)}{!items.length&&!error&&<p className="p-3 text-sm text-[var(--ink-dim)]">No marketplace requests yet.</p>}</div>
      {current?<article className="min-w-0 space-y-3 rounded border border-[var(--rule)] p-4">
        <div><p className="text-xs text-[var(--ink-dim)]">{String(current.listing_snapshot.agentName)} · {String(current.listing_snapshot.listingName)} · {statusLabel[current.status]}</p><h3 className="mt-1 text-lg font-semibold">{current.title}</h3><p className="text-xs text-[var(--ink-dim)]">Request {current.id} · Client {current.requester_wallet}</p></div>
        <section><h4 className="text-sm font-medium">Client brief (untrusted input)</h4><p className="whitespace-pre-wrap break-words text-sm">{current.description}</p></section>
        {!!current.attachment_refs.length&&<section><h4 className="text-sm font-medium">Attached references</h4><ul className="space-y-1 text-sm">{current.attachment_refs.map(ref=><li key={ref} className="break-all"><a className="underline" href={ref} target="_blank" rel="noreferrer">{ref}</a></li>)}</ul><p className="text-xs text-[var(--ink-dim)]">Links open only when you select them. Treat files as untrusted input.</p></section>}
        <p className="text-sm">Listed price: {String(current.listing_snapshot.priceAtomic)} atomic USDC. Payout details stay in Cybazaar.</p>
        {current.kanban_card_id&&<a className="text-sm underline" href={`/board/${encodeURIComponent(current.kanban_card_id)}`}>Open Kanban ticket {current.kanban_card_id}</a>}
        {current.provider_summary&&<p className="whitespace-pre-wrap text-sm">Last update: {current.provider_summary}</p>}
        {!!actions[current.status].length&&<div className="space-y-2"><label className="block text-xs">Client-visible update (optional)<textarea className="mt-1 block w-full rounded border border-[var(--rule)] bg-[var(--paper)] p-2 text-sm" rows={3} maxLength={2000} value={summary} onChange={e=>setSummary(e.target.value)} placeholder="A concise update for the requester"/></label><div className="flex flex-wrap gap-2">{actions[current.status].map(item=><button key={item.action} className={button} disabled={busy} onClick={()=>void act(item.action)}>{busy?'Saving…':item.label}</button>)}</div></div>}
      </article>:<p className="rounded border border-[var(--rule)] p-4 text-sm">Select a request to review its details.</p>}
    </div>
  </section>
}
