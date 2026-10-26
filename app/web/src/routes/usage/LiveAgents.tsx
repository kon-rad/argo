import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type LiveAgent, type LiveMachine } from '../../lib/api.js';
import { formatTokens } from './format.js';
import { sessionLink } from './AgentSessions.js';

export const LIVE_POLL_MS = 5000;

/** `3 m 12 s`, `2 h 05 m`, `4 d 3 h`. */
export function elapsedText(sec: number | null): string {
  if (sec === null) return '';
  const d = Math.floor(sec / 86400); const h = Math.floor((sec % 86400) / 3600); const m = Math.floor((sec % 3600) / 60); const s = sec % 60;
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${String(m).padStart(2, '0')} m`;
  return m ? `${m} m ${String(s).padStart(2, '0')} s` : `${s} s`;
}

/** The count in the Usage header; polls on the same cadence as the page. */
export function useLiveCount(): number | null {
  const q = useQuery({ queryKey: ['usage-live'], queryFn: () => api.usageLive(), refetchInterval: LIVE_POLL_MS });
  return q.data ? q.data.total : null;
}

const CSS = `
@keyframes live-pulse { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--live) 55%, transparent); } 70% { box-shadow: 0 0 0 7px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
@keyframes live-sweep { 0% { transform: translateX(-100%); } 100% { transform: translateX(350%); } }
@keyframes live-tick { 0% { color: var(--live); } 100% { color: inherit; } }
.live-root { --live: #1f9d63; }
.live-dot { width: 8px; height: 8px; border-radius: 9999px; background: var(--live); animation: live-pulse 1.6s ease-out infinite; }
.live-dot.idle { background: var(--ink-faint); animation: none; }
.live-bar { position: relative; height: 3px; overflow: hidden; border-radius: 2px; background: var(--paper-sunk); }
.live-bar::after { content: ''; position: absolute; inset: 0 auto 0 0; width: 30%; background: var(--live); border-radius: 2px; animation: live-sweep 1.8s ease-in-out infinite; }
.live-bar.idle::after { animation: none; opacity: 0.2; }
.live-tick { animation: live-tick 1.2s ease-out; }
@media (prefers-reduced-motion: reduce) { .live-dot, .live-bar::after, .live-tick { animation: none; } }
`;

/** Re-keys its text when the value changes so the tick animation replays. */
function Counter({ value, title }: { value: string; title?: string }) {
  const prev = useRef(value);
  const [n, setN] = useState(0);
  useEffect(() => { if (prev.current !== value) { prev.current = value; setN((x) => x + 1); } }, [value]);
  return <span key={n} className={n ? 'live-tick' : ''} title={title}>{value}</span>;
}

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-[var(--ink-dim)]">{label}</div>
      <div className="truncate text-sm tabular-nums"><Counter value={value} title={title} /></div>
    </div>
  );
}

function Card({ a, onStop, stopping }: { a: LiveAgent; onStop: (a: LiveAgent, force: boolean) => void; stopping: boolean }) {
  const [confirm, setConfirm] = useState(false);
  const active = a.source === 'process' || (a.lastActivityAt !== null && Date.now() - Date.parse(a.lastActivityAt) < 60_000);
  const tokens = a.tokens ? formatTokens(a.tokens.input + a.tokens.output) : '-';
  return (
    <article className="flex flex-col gap-2 rounded border border-[var(--rule)] bg-[var(--paper)] p-3" data-testid="live-card">
      <header className="flex items-center gap-2">
        <span className={`live-dot ${active ? '' : 'idle'}`} aria-label={active ? 'active' : 'quiet'} />
        <span className="truncate font-medium">{a.name}</span>
        <span className="ml-auto shrink-0 rounded bg-[var(--paper-sunk)] px-1.5 text-xs text-[var(--ink-dim)]">{a.harness}</span>
      </header>
      <div className={`live-bar ${active ? '' : 'idle'}`} />
      <div className="min-h-[2.5rem] text-sm">
        {a.task?.cardId ? <Link className="font-mono text-xs underline" to={`/board/${a.task.cardId}`}>{a.task.cardId}</Link> : null}
        {a.task?.label ? <span className={a.task.cardId ? 'ml-1' : ''}>{a.task.label}</span> : null}
        {!a.task?.label && !a.task?.cardId ? <span className="text-[var(--ink-dim)]">{a.task?.reason ?? 'no task attached'}</span> : null}
      </div>
      <div className="truncate text-xs text-[var(--ink-dim)]" title={a.model ?? ''}>{a.model ?? 'model unknown'}</div>
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Turns" value={a.turns === null ? '-' : String(a.turns)} />
        <Stat label="Tokens" value={tokens} title={a.tokens ? `in ${a.tokens.input.toLocaleString()} · out ${a.tokens.output.toLocaleString()}` : undefined} />
        <Stat label="Running" value={elapsedText(a.elapsedSec) || '-'} />
      </div>
      <footer className="flex items-center gap-2 text-xs">
        {a.log ? <Link className="underline" to={sessionLink({ host: a.log.host, external_id: a.log.externalId, source: a.log.source })}>Logs</Link>
          : <span className="text-[var(--ink-faint)]" title="This run has no synced session to open yet.">No logs yet</span>}
        <span className="ml-auto flex items-center gap-1">
          {a.stoppable ? (confirm ? (
            <>
              <button type="button" disabled={stopping} className="rounded border border-[var(--rule)] px-1.5 py-0.5 hover:bg-[var(--paper-sunk)]" onClick={() => { onStop(a, false); setConfirm(false); }}>Stop</button>
              <button type="button" disabled={stopping} className="rounded border border-red-600 px-1.5 py-0.5 text-red-600 hover:bg-[var(--paper-sunk)]" onClick={() => { onStop(a, true); setConfirm(false); }}>Kill</button>
              <button type="button" className="px-1 text-[var(--ink-dim)]" onClick={() => setConfirm(false)}>Cancel</button>
            </>
          ) : <button type="button" className="rounded border border-[var(--rule)] px-1.5 py-0.5 hover:bg-[var(--paper-sunk)]" onClick={() => setConfirm(true)}>Stop…</button>)
            : <span className="text-[var(--ink-faint)]" title="Only processes on the server running this app can be stopped from here. Stop this one on its own machine.">stop on its machine</span>}
        </span>
      </footer>
    </article>
  );
}

function Machine({ m, onStop, stopping }: { m: LiveMachine; onStop: (a: LiveAgent, force: boolean) => void; stopping: boolean }) {
  return (
    <section aria-label={m.display}>
      <h2 className="text-sm font-semibold">{m.display} <span className="font-normal text-[var(--ink-dim)]">· {m.agents.length} running{m.kind ? ` · ${m.kind}` : ''}</span></h2>
      {m.agents.length === 0 ? <p className="py-2 text-xs text-[var(--ink-faint)]">Nothing running.</p> : (
        <div className="mt-2 grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(17rem, 1fr))' }}>
          {m.agents.map((a) => <Card key={a.id} a={a} onStop={onStop} stopping={stopping} />)}
        </div>
      )}
    </section>
  );
}

export default function LiveAgents() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['usage-live'], queryFn: () => api.usageLive(), refetchInterval: LIVE_POLL_MS });
  const stop = useMutation({
    mutationFn: ({ a, force }: { a: LiveAgent; force: boolean }) => api.usageLiveStop(a.pid!, force, a.startedAt),
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['usage-live'] }); },
  });
  return (
    <div className="live-root h-full overflow-auto p-4">
      <style>{CSS}</style>
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3">
        <Link className="text-sm underline" to="/usage">Usage</Link>
        <h1 className="text-lg font-semibold">Running now <span className="font-normal text-[var(--ink-dim)]">({q.data?.total ?? '…'})</span></h1>
        <span className="text-xs text-[var(--ink-dim)]">
          {q.data ? `Updated ${new Date(q.data.at).toLocaleTimeString()}, every ${LIVE_POLL_MS / 1000} s. Other machines show sessions active in the last 3 minutes, as of their last sync.` : 'Loading...'}
        </span>
      </div>
      {q.isError && <p className="text-sm text-red-600">The live list did not load.</p>}
      {stop.isError && <p className="text-sm text-red-600" role="alert">{(stop.error as Error).message}</p>}
      {stop.isSuccess && <p className="text-xs text-[var(--ink-dim)]">Sent {stop.data.signal} to pid {stop.data.pid}.</p>}
      <div className="space-y-6">
        {(q.data?.machines ?? []).map((m) => <Machine key={m.slug} m={m} stopping={stop.isPending} onStop={(a, force) => stop.mutate({ a, force })} />)}
      </div>
    </div>
  );
}
