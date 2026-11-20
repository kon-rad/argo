import { useCallback, useEffect, useState } from 'react';

interface Job {
  id: string; title: string; brief: string; status: string; priceAtomic: string;
  cardId: string | null; artifactSha256: string | null; summary: string | null;
  paymentTx: string | null; pendingPaymentTx: string | null; swarmRef: string | null;
  uploadState: string;
}
const button = 'rounded border border-[var(--rule)] px-3 py-2 text-sm disabled:opacity-50';
const input = 'block w-full rounded border border-[var(--rule)] bg-[var(--paper)] px-2 py-2 text-sm';
const base = '/api/desk/market/operator/jobs';

/** Private owner controls; client projections never contain staging paths. */
export function MarketDesk({ request = fetch }: { request?: typeof fetch }) {
  const [jobs, setJobs] = useState<Job[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(window.location.search).get('marketJob'));
  const [artifactRef, setArtifactRef] = useState(''), [summary, setSummary] = useState(''), [recoveryRef, setRecoveryRef] = useState('');
  const load = useCallback(async () => {
    const response = await request(base, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error(response.status === 503 ? 'Commission service is not configured.' : 'Cannot load commissions.');
    const data = await response.json(); setJobs(data.jobs);
  }, [request]);
  useEffect(() => { void load().catch(cause => setError(cause.message)); }, [load]);
  const job = jobs.find(j => j.id === selected);
  const act = async (action: string, body?: Record<string, string>) => {
    if (!job) return; setBusy(true); setError('');
    try {
      const response = await request(`${base}/${encodeURIComponent(job.id)}/${action}`, {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
      });
      if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error?.message ?? data.message ?? 'Commission action failed.'); }
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Commission action failed.'); }
    finally { setBusy(false); }
  };
  return <section aria-label="Cybazaar commissions" className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="text-lg font-semibold">Cybazaar commissions</h2><p className="text-sm">Approve the board task, inspect the finished MP4, then release its summary for payment.</p></div><button className={button} disabled={busy} onClick={() => void load().catch(c => setError(c.message))}>Refresh commissions</button></div>
    {error && <p role="alert" className="rounded border border-[var(--warn)] p-3">{error}</p>}
    <div className="grid gap-4 lg:grid-cols-[minmax(14rem,1fr)_minmax(0,2fr)]">
      <div className="space-y-2">{jobs.map(item => <button key={item.id} className={`${button} block w-full text-left`} aria-pressed={selected === item.id} onClick={() => { setSelected(item.id); setArtifactRef(''); setSummary(''); setRecoveryRef(''); }}><b>{item.title}</b><span className="block text-xs">{item.status} · {item.priceAtomic} atomic USDC</span></button>)}{!jobs.length && !error && <p>No commission requests.</p>}</div>
      {job ? <article className="min-w-0 space-y-3 rounded border border-[var(--rule)] p-3">
        <h3 className="font-semibold">{job.title}</h3><p className="text-xs">{job.id} · {job.status}</p>
        <section><h4 className="text-sm font-medium">Client brief (untrusted input)</h4><p className="whitespace-pre-wrap break-words text-sm">{job.brief}</p></section>
        {job.cardId && <a className="text-sm underline" href={`/board/${encodeURIComponent(job.cardId)}`}>Open execution card</a>}
        {job.status === 'triage' && <div><button className={button} disabled={busy} onClick={() => void act('approve')}>Approve board task</button></div>}
        {['active', 'review'].includes(job.status) && <form className="space-y-2" onSubmit={e => { e.preventDefault(); void act('stage', { artifactRef, summary }); }}>
          <label className="block text-sm">Finished MP4 in the configured staging folder<input className={input} value={artifactRef} onChange={e => setArtifactRef(e.target.value)} required placeholder="job-result.mp4" /></label>
          <label className="block text-sm">Client-visible summary<textarea className={input} value={summary} onChange={e => setSummary(e.target.value)} required maxLength={4000} /></label>
          <button className={button} disabled={busy}>Load finished artifact for review</button>
        </form>}
        {job.artifactSha256 && ['review', 'released', 'paid'].includes(job.status) && <section className="space-y-2">
          <h4 className="font-medium">Private reviewed delivery</h4>
          <video key={job.artifactSha256} controls preload="metadata" className="max-h-96 w-full" src={`${base}/${encodeURIComponent(job.id)}/artifact?hash=${encodeURIComponent(job.artifactSha256)}`} />
          <p className="break-all text-xs">SHA-256: {job.artifactSha256}</p><p className="whitespace-pre-wrap text-sm">{job.summary}</p>
          {job.status === 'review' && <button className={button} disabled={busy} onClick={() => void act('release', { artifactSha256: job.artifactSha256!, summary: job.summary! })}>Release reviewed summary</button>}
        </section>}
        {job.status === 'released' && <p className="text-sm">{job.paymentTx ? 'Payment verified; delivery is being reconciled. Do not request another transfer.' : job.pendingPaymentTx ? 'A submitted payment is pending independent verification.' : 'Summary released. Waiting for client payment; the MP4 is private.'}</p>}
        {job.paymentTx && !job.swarmRef && job.uploadState === 'uploading' && <form className="space-y-2" onSubmit={e => { e.preventDefault(); void act('reconcile-delivery', { reference: recoveryRef }); }}><p className="text-sm">An upload response is unknown. Recover its exact reference without uploading again.</p><label className="block text-sm">Verified Swarm reference<input className={input} value={recoveryRef} onChange={e => setRecoveryRef(e.target.value)} placeholder="swarm://…" required /></label><button className={button} disabled={busy}>Reconcile existing delivery</button></form>}
        {job.status === 'paid' && <p className="text-sm">Payment and delivery confirmed.</p>}
        {!['paid', 'cancelled'].includes(job.status) && !job.paymentTx && !job.pendingPaymentTx && <button className={button} disabled={busy} onClick={() => void act('cancel')}>Cancel commission</button>}
      </article> : <p>Select a commission to review its task and delivery.</p>}
    </div>
  </section>;
}
