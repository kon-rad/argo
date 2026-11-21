import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import DataTable from '../../components/DataTable.js';
import { api } from '../../lib/api.js';
import { zoned } from '../../lib/time.js';
import { useAppTimezone } from '../../lib/useTimezone.js';
import type { ApplyResult, Assignment, HistoryEntry, Preview, Receipt, RuntimeProfile, RuntimeStatus, Target } from './runtimeApi.js';

const control = 'min-h-11 rounded border border-[var(--rule)] bg-[var(--paper)] px-3 text-sm focus-visible:outline-[var(--accent)] disabled:opacity-50';
const panel = 'space-y-2 rounded border border-[var(--rule)] bg-[var(--paper)] p-3';
const link = 'text-[var(--accent)] underline';
const labels = { 'org-agent': 'Org agent', 'cron-job': 'Cron job', 'telegram-gateway': 'Telegram gateway', 'telegram-poller': 'Telegram poller', 'default-route': 'Default route' };
const key = (t: Target) => `${t.kind}:${t.id}`;
const assignment = (a: Assignment) => [a.runtime, a.model ?? 'no model specified', a.provider].filter(Boolean).join(' / ');
const statusText = (s: string) => s === 'org-applied' ? 'applied to org assignments' : s.replaceAll('-', ' ');
const table = 'w-full text-left text-sm [&_th]:p-2 [&_td]:p-2 [&_td]:align-top [&_tr]:border-b [&_tr]:border-[var(--rule)] [overflow-wrap:anywhere]';
function Stamp({ at, tz }: { at: string; tz: string }) {
  return <time className="block font-mono text-xs text-[var(--ink-dim)]" dateTime={at}>{zoned(at, tz)}</time>;
}
function ReceiptDetail({ receipt, tz }: { receipt: Receipt; tz: string }) {
  return <><span>v{receipt.version} · {receipt.status}</span><small className="block font-mono">{assignment(receipt.assignment)}</small>
    {receipt.observed_at && <Stamp at={receipt.observed_at} tz={tz} />}</>;
}
function versionTitle(entry: HistoryEntry, profiles: RuntimeProfile[]) {
  if (entry.reverted_version !== null) return `Revert of version ${entry.reverted_version}`;
  const p = profiles.find(p => p.id === entry.profile_id && p.version === entry.profile_version);
  return `${p?.definition.name ?? entry.profile_id} · profile v${entry.profile_version}`;
}

function CoverageLedger({ data, preview, agent, tz }: { data: RuntimeStatus; preview?: Preview; agent: string | null; tz: string }) {
  const changes = new Map(preview?.changes.map(c => [key(c.target), c]));
  const profile = data.profileRevisions.find(p => p.id === preview?.profileId && p.version === preview.profileVersion);
  // The roster can change between loading status and requesting a preview.
  // Render the server's reviewed inventory even if a new target has no status row yet.
  const inventory = new Map(data.targets.map(t => [key(t), t]));
  const targets = preview ? [...preview.changes.map(c => c.target), ...preview.uncovered] : data.targets;
  return <DataTable label="Coverage ledger" phone="cards" className={table}>
    <thead><tr>{['Target', 'Configured', 'Effective now', 'Last observed', ...(preview ? ['Proposed'] : []), 'Readiness', 'Latest receipt'].map(h => <th scope="col" key={h}>{h}</th>)}</tr></thead>
    <tbody>{targets.map(t => {
      const current = inventory.get(key(t));
      const change = changes.get(key(t));
      const receipt = data.receipts.find(r => r.kind === t.kind && r.target_id === t.id);
      const selected = t.kind === 'org-agent' && t.id === agent;
      return <tr key={key(t)} className={selected ? 'bg-[var(--paper-sunk)]' : undefined} aria-current={selected || undefined}>
        <td><small className="block text-[var(--ink-dim)]">{labels[t.kind]}</small>
          {t.kind === 'org-agent' ? <Link className={`${link} max-md:inline-flex max-md:min-h-11 max-md:items-center`} to={`/org/agents/${encodeURIComponent(t.id)}`}>{t.id}</Link> : t.id}</td>
        <td className="font-mono">{current ? assignment(current.configured) : 'Unknown'}</td>
        <td className="font-mono">{current?.adapter ? assignment(current.effective) : 'Unverified'}</td>
        <td>{current?.lastObserved ? <><span className="font-mono">{current.lastObserved.runtime ?? 'Unknown runtime'} / {current.lastObserved.model ?? 'unknown model'}</span>
          {current.lastObserved.started_at ? <Stamp at={current.lastObserved.started_at} tz={tz} /> : <small className="block">Time unknown</small>}</> : 'No observed run'}</td>
        {preview && <td>{change ? <><span className="font-mono">{assignment(change.to)}</span>
          <small className="block">From {assignment(change.from)}</small>
          {profile?.definition.exceptions[key(t)] && <small>Profile exception</small>}</> : 'Outside scope'}</td>}
        <td>{change?.problem ? <strong className="text-[var(--warn)]">{change.problem}</strong> : <>
          {current?.adapter ?? 'No verified adapter'}<small className="block">{current?.health ?? 'Unknown'}</small></>}</td>
        <td>{receipt ? <ReceiptDetail receipt={receipt} tz={tz} /> : 'No receipt'}</td>
      </tr>;
    })}</tbody>
  </DataTable>;
}

export default function RuntimeSettings() {
  const client = useQueryClient();
  const status = useQuery({ queryKey: ['org', 'runtime'], queryFn: api.runtimeStatus, refetchInterval: 15000 });
  const meta = useQuery({ queryKey: ['meta'], queryFn: api.meta, staleTime: Infinity });
  const usageEnabled = !!meta.data?.modules?.includes('usage');
  const usage = useQuery({ queryKey: ['usage-config'], queryFn: api.usageConfig, enabled: usageEnabled });
  const { tz } = useAppTimezone();
  const [params] = useSearchParams();
  const [profileChoice, setProfile] = useState('');
  const [scope, setScope] = useState('fleet');
  const [review, setReview] = useState<{ preview: Preview; inventory: RuntimeStatus } | null>(null);
  const [expired, setExpired] = useState(false);
  const [revert, setRevert] = useState<number | null>(null);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const previewButton = useRef<HTMLButtonElement>(null);
  const preview = review?.preview;
  useEffect(() => {
    if (!preview) return;
    reviewHeading.current?.focus();
    const remaining = Date.parse(preview.expiresAt) - Date.now();
    setExpired(!(remaining > 0));
    if (remaining > 0) {
      const timeout = window.setTimeout(() => setExpired(true), remaining);
      return () => window.clearTimeout(timeout);
    }
  }, [preview]);
  const data = status.data;
  const profileId = profileChoice || data?.profiles[0]?.id || '';
  const agents = data?.targets.filter(t => t.kind === 'org-agent').map(({ kind, id }) => ({ kind, id })) ?? [];
  const generate = useMutation({
    mutationFn: async () => {
      if (!data || (scope === 'org' && !agents.length)) throw new Error('No org agents in scope');
      return { preview: await api.runtimePreview(profileId, scope === 'org' ? agents : []), inventory: data };
    },
    onSuccess: setReview,
  });
  const write = useMutation({
    mutationFn: (action: { token: string } | { version: number }) =>
      'token' in action ? api.runtimeApply(action.token) : api.runtimeRevert(action.version),
    onSuccess: setResult,
    onSettled: async () => {
      setReview(null);
      setRevert(null);
      await client.invalidateQueries({ queryKey: ['org'] });
      previewButton.current?.focus();
    },
  });
  function clearReview() {
    setReview(null);
    setExpired(false);
    setResult(null);
    setRevert(null);
    write.reset();
    generate.reset();
  }
  if (!data) return <p className="p-4" role={status.error ? 'alert' : 'status'}>{status.error?.message ?? 'Loading runtime settings…'}</p>;
  const latest = data.history.find(h => h.version === data.desiredVersion);
  const busy = generate.isPending || write.isPending;
  const blocked = preview?.changes.filter(c => c.problem).length ?? 0;
  return <div className="h-full space-y-4 overflow-y-auto p-4 text-sm">
    <header className="space-y-1">
      <h1 className="text-lg font-semibold tracking-tight">Runtime settings</h1>
      {latest ? <><p>Desired version {latest.version} · {versionTitle(latest, data.profileRevisions)} · {statusText(latest.status)}</p>
        <Stamp at={latest.created_at} tz={tz} /></> : <p>{data.desiredVersion ? `Desired version ${data.desiredVersion}` : 'No profile applied yet.'}</p>}
      <div className="flex flex-wrap gap-3">
        {usageEnabled && usage.data?.sections.includes('sessions') && <Link className={link} to="/usage?view=sessions">Observed runs in Usage</Link>}
        {usageEnabled && usage.data?.sections.includes('running') && <Link className={link} to="/usage?view=running">Running now</Link>}
      </div>
    </header>
    <div role="status" aria-live="polite">
      {result && <p>Version {result.version} · {statusText(result.status)} · {result.changes.length} in scope · {result.uncovered.length} outside scope</p>}
    </div>
    {(write.error || generate.error || status.error) && <p role="alert">{(write.error ?? generate.error ?? status.error)?.message}</p>}
    <section className={panel} aria-label="Profile selection">
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid min-w-0 gap-1">Profile
          <select className={control} value={profileId} disabled={busy || !data.profiles.length} onChange={e => { clearReview(); setProfile(e.target.value); }}>
            {data.profiles.map(p => <option key={p.id} value={p.id}>{p.definition.name} · v{p.version}</option>)}
          </select></label>
        <label className="grid gap-1">Scope
          <select className={control} value={scope} disabled={busy} onChange={e => { clearReview(); setScope(e.target.value); }}>
            <option value="fleet">Whole fleet</option><option value="org" disabled={!agents.length}>All org agents</option>
          </select></label>
        <button ref={previewButton} className={control} disabled={busy || !profileId || !data.targets.length || (scope === 'org' && !agents.length)}
          onClick={() => { clearReview(); generate.mutate(); }}>{generate.isPending ? 'Preparing preview…' : 'Preview change'}</button>
      </div>
      {!data.profiles.length && <p>Create a named profile with <code>cli-org runtime</code> to preview changes.</p>}
    </section>
    <section className={panel}>
      <h2 ref={reviewHeading} tabIndex={-1} className="font-semibold tracking-tight">{preview ? 'Review change' : 'Coverage ledger'}</h2>
      {preview && <>
        <p>{preview.profileId} · profile v{preview.profileVersion}</p>
        <p>{preview.changes.length} in scope · {blocked} blocked · {preview.uncovered.length} outside scope</p>
        <p>Preview expires <time dateTime={preview.expiresAt}>{zoned(preview.expiresAt, tz, { seconds: true })}</time></p>
        {expired && <p role="alert">Preview expired. Preview the change again.</p>}
        {preview.inFlight.length > 0 && <details><summary>In-flight runs keeping their starting configuration ({preview.inFlight.length})</summary>
          <ul>{preview.inFlight.map(r => <li key={r.id}>#{r.id} · {r.agent_name ?? 'Unknown agent'} · {r.runtime ?? 'unknown runtime'}</li>)}</ul></details>}
      </>}
      <CoverageLedger data={review?.inventory ?? data} preview={preview} agent={params.get('agent')} tz={tz} />
      {preview && <div className="flex flex-wrap gap-2">
        <button className={control} disabled={busy || expired || !!blocked || !preview.changes.length} onClick={() => {
          if (Date.parse(preview.expiresAt) > Date.now()) write.mutate({ token: preview.token }); else setExpired(true);
        }}>{scope === 'fleet' ? 'Apply whole fleet' : 'Apply to future wakes'}</button>
        <button className={control} disabled={busy} onClick={() => { clearReview(); previewButton.current?.focus(); }}>Cancel</button>
      </div>}
    </section>
    <section className={panel}>
      <h2 className="font-semibold tracking-tight">History</h2>
      {!data.history.length && <p>No recorded changes.</p>}
      {data.history.map(h => <article className="space-y-1 border-t border-[var(--rule)] pt-2" key={h.version}>
        <h3 className="font-medium">Version {h.version} · {versionTitle(h, data.profileRevisions)}</h3>
        <p>{statusText(h.status)} · {h.changes.length} in scope · {h.uncovered.length} outside scope · {h.applied_by}</p>
        <Stamp at={h.created_at} tz={tz} />
        <details><summary>Targets and receipts for version {h.version}</summary>
          <ul>{h.changes.map(c => {
            const r = data.receipts.find(r => r.version === h.version && r.kind === c.target.kind && r.target_id === c.target.id);
            return <li key={key(c.target)}>{key(c.target)} · {assignment(c.from)} → {assignment(c.to)} · {r ? <ReceiptDetail receipt={r} tz={tz} /> : 'No receipt'}</li>;
          })}{h.uncovered.map(t => <li key={key(t)}>{key(t)} · Outside scope</li>)}</ul>
        </details>
        {revert === h.version ? <div className="space-y-1"><p>Restore the previous assignments for the {h.changes.length} targets in version {h.version}?</p>
          <button className={control} disabled={busy} onClick={() => write.mutate({ version: h.version })}>Confirm revert of version {h.version}</button>{' '}
          <button className={control} disabled={busy} onClick={() => setRevert(null)}>Cancel revert</button></div>
          : <button className={control} disabled={busy} onClick={() => { clearReview(); setRevert(h.version); }}>Revert version {h.version}</button>}
      </article>)}
    </section>
  </div>;
}
