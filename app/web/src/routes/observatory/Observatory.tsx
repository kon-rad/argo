import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAppTimezone } from '../../lib/useTimezone.js';
import { zoned } from '../../lib/time.js';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { request } from '../../lib/http.js';
import { demoWindow } from './demo.js';
import { loadDetail, loadSnapshot, type Snapshot } from './api.js';
import { eventLink, originStyle, readState, sceneAt, stepCursor, writeState, replayHref, type ViewState } from './model.js';
const MapActivity = lazy(() => import('./BrainActivity.js'));
const Workspace = lazy(() => import('./Workspace.js'));
const field = 'rounded border border-[var(--rule)] bg-[var(--paper)] px-2 py-1';

export default function Observatory({ mode = 'workspace' }: { mode?: 'map' | 'workspace' }) {
  const meta = useQuery({ queryKey: ['meta'], queryFn: api.meta });
  const [params, setParams] = useSearchParams();
  const [initialNow] = useState(Date.now);
  const state = readState(params, initialNow), stateKey = params.toString();
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [error, setError] = useState(''), [coverage, setCoverage] = useState<unknown>();
  const [detail, setDetail] = useState<{ event?: unknown; error?: string; detail?: { thinking?: { availability: string; summary?: string } } | string }>();
  const detailRequest = useRef<AbortController | null>(null);
  const [play, setPlay] = useState<0 | 1 | -1>(0), [live, setLive] = useState(false), [refresh, setRefresh] = useState(0);
  const [webgl, setWebgl] = useState(true);
  const { tz } = useAppTimezone();
  const update = (patch: Partial<ViewState>, replace = false) => {
    const next = writeState({ ...state, ...patch });
    if (mode === 'map') next.set('activity', '1');
    setParams(next, { replace });
  };
  const pinLayout = useCallback((version: string) => setParams(previous => { const next = new URLSearchParams(previous); next.set('layout', version); return next; }, { replace: true }), [setParams]);
  // Key includes only server filters. Local display filters never re-fetch transcript metadata.
  const requestKey = JSON.stringify([state.from, state.to, state.host, state.session, state.demo]);
  useEffect(() => {
    const abort = new AbortController(); setSnapshot(undefined); setError(''); setCoverage(undefined); setDetail(undefined);
    if (state.demo === '1') { setSnapshot({ window: demoWindow, export: 'synthetic', diagnostics: { synthetic: true, historicalCompleteness: 'unknown', liveExecutions: 'unsupported' } }); return; }
    void loadSnapshot(state, abort.signal).then(setSnapshot).catch(e => { if (!abort.signal.aborted) setError(String(e.message)); });
    void request('/observatory/coverage', { from: new Date(state.from).toISOString(), to: new Date(state.to).toISOString(), host: state.host, session: state.session }, { signal: abort.signal })
      .then(setCoverage).catch(e => { if (!abort.signal.aborted) setCoverage({ error: String(e.message) }); });
    return () => abort.abort();
    // State-dependent fetching is represented by requestKey.
  }, [requestKey, refresh]);
  // URL changes, back/forward and seek all restore the same pure state.
  const cursor = snapshot ? Math.max(snapshot.window.from, Math.min(snapshot.window.to - 1, state.cursor)) : state.cursor;
  const scene = useMemo(() => snapshot ? sceneAt(snapshot.window, cursor, state) : undefined, [snapshot, cursor, stateKey]);
  useEffect(() => {
    if (!play || !snapshot) return;
    const timer = setInterval(() => {
      if (document.hidden) return;
      const next = cursor + play * 250;
      if (next < snapshot.window.from || next >= snapshot.window.to) setPlay(0);
      update({ cursor: Math.max(snapshot.window.from, Math.min(snapshot.window.to - 1, next)) }, true);
    }, 250);
    return () => clearInterval(timer);
  }, [play, cursor, snapshot, stateKey]);
  useEffect(() => {
    if (!live || state.demo === '1') return;
    const timer = setInterval(() => {
      if (document.hidden) return;
      const to = Date.now(), duration = state.to - state.from;
      update({ from: to - duration, to, cursor: to - 1, event: undefined }, true);
    }, 15000);
    return () => clearInterval(timer);
  }, [live, requestKey]);
  const select = useCallback((id: string) => setParams(previous => { const next = new URLSearchParams(previous); next.set('event', id); return next; }), [setParams]);
  useEffect(() => { setDetail(undefined); detailRequest.current?.abort(); return () => detailRequest.current?.abort(); }, [state.event, snapshot]);
  const selected = scene?.events.find(e => e.id === state.event);
  const execution = scene?.active.find(i => i.id === state.event);
  const selectedNode = scene?.nodes.find(n => n.id === state.event);
  const showDetail = async () => {
    if (!selected || !snapshot) return;
    if (state.demo === '1') { setDetail({ event: selected, detail: 'Synthetic only, no recorded source exists' }); return; }
    detailRequest.current?.abort();
    const abort = new AbortController(); detailRequest.current = abort;
    try { const data = await loadDetail(selected.id, snapshot.export, abort.signal); if (!abort.signal.aborted) setDetail(data); } catch (e) { if (!abort.signal.aborted) setDetail({ error: (e as Error).message }); }
  };
  const seek = (next: number) => { setPlay(0); setLive(false); update({ cursor: next, event: undefined }, true); };
  return <main className="h-full overflow-auto p-4 space-y-3">
    <h1 className="text-lg font-semibold">{mode === 'map' ? 'Brain Map activity' : 'Observatory'}</h1>
    <nav aria-label="Replay views" className="flex gap-3"><Link to={replayHref('workspace', state)}>Workspace replay</Link>{meta.data?.modules?.includes('map') && <Link to={replayHref('map', state)}>Brain Map replay</Link>}</nav>
    <p className="text-sm">Recorded executions only. Historical coverage and human provenance may be unknown. Live process visibility unsupported.</p>
    <div className="flex flex-wrap gap-2">
      <button className={field} onClick={() => { setLive(false); setPlay(0); update({ from: demoWindow.from, to: demoWindow.to, cursor: demoWindow.from, demo: '1', event: undefined, host: undefined, session: undefined, ticket: undefined, runtime: undefined, persona: undefined, model: undefined, origin: undefined }); }}>Synthetic demo</button>
      <button className={field} onClick={() => { const to = Date.now(); setPlay(0); update({ from: to - 3600000, to, cursor: to - 1, demo: undefined }); }}>Last hour</button>
      <button className={field} onClick={() => { const to = Date.now(); update({ from: to - 86400000, to, cursor: to - 1, demo: undefined }); }}>Last 24 hours</button>
      <button className={field} onClick={() => setRefresh(n => n + 1)}>Restart window</button>
    </div>
    <form className="flex flex-wrap gap-2" onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); const from = Date.parse(String(data.get('from'))), to = Date.parse(String(data.get('to'))); if (Number.isFinite(from) && to > from && to - from <= 86400000) update({ from, to, cursor: from, demo: undefined }); else setError('Enter UTC instants spanning at most 24 hours'); }}>
      <label>From UTC <input key={`f${state.from}`} name="from" className={field} defaultValue={new Date(state.from).toISOString()} /></label>
      <label>To UTC <input key={`t${state.to}`} name="to" className={field} defaultValue={new Date(state.to).toISOString()} /></label><button className={field}>Load range</button>
    </form>
    <div className="flex flex-wrap gap-2" aria-label="Workspace filters">
      {(['host', 'session', 'ticket', 'runtime', 'persona', 'model'] as const).map(key => <label key={key}>{key} <input className={field} aria-label={key} value={state[key] ?? ''} onChange={e => { setPlay(0); update({ [key]: e.target.value || undefined }); }} /></label>)}
      <label>Origin <select className={field} value={state.origin ?? ''} onChange={e => update({ origin: e.target.value || undefined })}><option value="">all origins</option>{(['human', 'agent', 'automation', 'unknown'] as const).map(o => <option key={o} value={o}>{originStyle(o).glyph}</option>)}</select></label>
    </div>
    {state.note && <p><span>Note activity filter: {state.note}</span> · <button className="underline" onClick={() => update({ note: undefined })}>Clear note filter</button></p>}
    <p className="text-sm">◆ H amber: evidenced human · ● A cyan: agent · ■ grey: automation · ◇ grey hollow: unknown. Status never changes origin color.</p>
    {state.demo === '1' && <p role="status">SYNTHETIC DEMO. No production or historical completeness claim.</p>}
    {error && <p role="alert">{error}. Restart the window or narrow the range.</p>}
    {!snapshot && !error && <p role="status">Loading complete event window…</p>}
    {snapshot && scene && <>
      <div className="flex flex-wrap items-center gap-2" aria-label="Time controls">
        <button className={field} onClick={() => seek(stepCursor(snapshot.window, cursor, -1))}>Previous event</button>
        <button className={field} onClick={() => { setLive(false); setPlay(-1); }}>Reverse</button>
        <button className={field} onClick={() => setPlay(0)}>Pause</button>
        <button className={field} onClick={() => { setLive(false); setPlay(1); }}>Play</button>
        <button className={field} onClick={() => seek(stepCursor(snapshot.window, cursor, 1))}>Next event</button>
        <label><input type="checkbox" checked={live} disabled={state.demo === '1'} onChange={e => { setPlay(0); setLive(e.target.checked); }} />Live history refresh (15s)</label>
      </div>
      <label className="block">Seek: <output>{zoned(new Date(cursor).toISOString(), tz)} ({tz})</output>
        <input aria-label="Replay cursor" type="range" className="block w-full" min={snapshot.window.from} max={snapshot.window.to - 1} step="1" value={cursor} onChange={e => seek(Number(e.target.value))} /></label>
      <label><input type="checkbox" checked={webgl} onChange={e => setWebgl(e.target.checked)} />Show 3D {mode === 'map' ? 'map' : 'workspace'}</label>
      {mode === 'map' && <Suspense fallback={<p>Loading map activity…</p>}><MapActivity events={scene.events} selected={state.event} note={state.note} layout={state.layout} pin={pinLayout} onNote={note => update({ note })} onSelect={select} show3d={webgl} /></Suspense>}
      {mode === 'workspace' && webgl && <Suspense fallback={<p>Loading 3D renderer…</p>}><Workspace nodes={scene.nodes} links={scene.links} onSelect={select} /></Suspense>}
      <p>Origins filter event markers. Execution markers retain their recorded agent identity.</p>
      <p>{scene.active.length} active executions · {scene.nodes.length} nodes · {scene.links.length} edges · {scene.omittedNodes} nodes / {scene.omittedLinks} edges omitted at display budget</p>
      <ul aria-label="Active executions" className="space-y-1">{scene.active.map(i => <li key={i.id}><button className="underline" onClick={() => select(i.id)}>● A {i.persona ?? 'persona unknown'} · {i.host} · {i.runtime} · {i.id}</button> · {i.ticket ?? 'ticket unknown'} · {scene.nodes.find(n => n.id === i.id)?.label}</li>)}</ul>
      <ul aria-label="Workspace targets">{scene.nodes.filter(n => n.kind === 'ticket' || n.kind === 'file').map(n => <li key={n.id}><button className="underline" onClick={() => select(n.id)}>{n.kind}: {n.label}</button></li>)}</ul>
      {!scene.active.length && <p>No evidenced active executions at this cursor.</p>}
      <section aria-label="Evidence inspector" className="border border-[var(--rule)] p-3">
        <h2>Inspector</h2>
        {selectedNode && <p>{selectedNode.label}</p>}
        {execution && <pre className="whitespace-pre-wrap break-all">{JSON.stringify(execution, null, 2)}</pre>}
        {selected ? <>
          <p>{originStyle(selected.actor.kind).glyph} {selected.kind} · {selected.tool ?? ''}</p>
          <p>Provenance: {selected.actor.evidence} · sender {selected.actor.sender ?? 'unknown'} · channel {selected.actor.channel ?? 'unknown'}</p>
          <p>Source {selected.source.table}:{selected.source.id} part {selected.source.part}</p>
          <p>Outcome at cursor: {scene.tools[selected.occurrence ?? selected.parent ?? ''] ?? 'unknown'}</p>
          {selected.target && <p>{selected.target.operation} attempt: {selected.target.path}</p>}
          {selected.kind === 'thinking' && <p>Thinking: {typeof detail?.detail === 'object' && detail.detail.thinking ? detail.detail.thinking.availability : 'not checked; verify source detail'}. No reasoning reconstructed.</p>}
          {typeof detail?.detail === 'object' && detail.detail.thinking?.availability === 'authorized-summary' && <div aria-label="Authorized thinking summary" className="whitespace-pre-wrap">{detail.detail.thinking.summary}</div>}
          <button className={field} onClick={() => void showDetail()}>Verify source detail</button>
          {detail !== undefined && <><pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(detail, null, 2)}</pre>{detail.event && !detail.error && eventLink(selected) && state.demo !== '1' && <Link className="underline" to={eventLink(selected)!}>Open recorded session part</Link>}</>}
        </> : !execution && <p>Select an execution or recorded event. File targets require structured source evidence.</p>}
      </section>
      <section aria-label="Recorded event timeline"><h2>Events through cursor ({scene.events.length}; latest 200 shown)</h2>
        <ol className="max-h-80 overflow-auto">{scene.events.slice(-200).map(e => <li key={e.id}><button className="underline" onClick={() => select(e.id)}>{zoned(new Date(e.at!).toISOString(), tz)} {originStyle(e.actor.kind).glyph} {e.kind} {e.tool ?? ''}</button></li>)}</ol>
        <p>{snapshot.window.events.filter(e => e.at === null).length} untimed events excluded from replay. Narrow the range for earlier event detail.</p>
      </section>
      <details><summary>Coverage and limitations</summary><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify({ diagnostics: snapshot.diagnostics, coverage }, null, 2)}</pre></details>
    </>}
  </main>;
}
