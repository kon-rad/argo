import { fileEvidenceLevel, type BoundaryContext } from './fileEvidence.js';
import { lazy, Suspense, useEffect, useMemo, useRef, useState, Component, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { FullMapHandle } from '../../components/map/FullMap.js';
import type { EvidenceEvent } from '@secondbrain/contracts/observatory';
import { mapApi, type MapMetric } from '../../lib/mapData.js';
import { mapActivity, operationStyle } from './mapActivity.js';
const FullMap = lazy(() => import('../../components/map/FullMap.js').then(m => ({ default: m.FullMap })));
class MapRendererBoundary extends Component<{ children: ReactNode; onFailure: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onFailure(); }
  render() { return this.state.failed ? null : this.props.children; }
}
const metrics: MapMetric[] = [];
const layers = { notes: true, links: true, structure: true, metrics: false };
export default function MapActivity({ events, contextEvents = events, evidenceContext, selected, note, layout, pin, onNote, onSelect, show3d }: {
  events: EvidenceEvent[]; contextEvents?: EvidenceEvent[]; evidenceContext?: BoundaryContext; selected?: string; note?: string; layout?: string; pin: (version: string) => void;
  onNote: (path?: string) => void; onSelect: (id: string) => void; show3d: boolean;
}) {
  const mapRef = useRef<FullMapHandle>(null);
  const rendererHost = useRef<HTMLDivElement>(null);
  const [rendererFailed, setRendererFailed] = useState(false);
  const cache = useQueryClient();
  const graph = useQuery({ queryKey: ['observatory-layout', layout], queryFn: () => mapApi.graph(layout), staleTime: Infinity, refetchOnWindowFocus: false });
  useEffect(() => { if (!show3d) setRendererFailed(false); }, [show3d]);
  useEffect(() => {
    const host = rendererHost.current;
    if (!host) return;
    const lost = (event: Event) => { event.preventDefault(); setRendererFailed(true); };
    host.addEventListener('webglcontextlost', lost, true);
    return () => host.removeEventListener('webglcontextlost', lost, true);
  }, [show3d, rendererFailed, graph.data?.version]);
  useEffect(() => {
    if (graph.data && !layout) {
      cache.setQueryData(['observatory-layout', String(graph.data.version)], graph.data);
      pin(String(graph.data.version));
    }
  }, [graph.data, layout, pin, cache]);
  const activity = useMemo(() => graph.data ? mapActivity(graph.data, events, contextEvents, evidenceContext) : [], [graph.data, events, contextEvents, evidenceContext]);
  const eventIndex = useMemo(() => new Map(contextEvents.map(event => [event.id, event])), [contextEvents]);
  const selectedExecution = events.some(e => e.execution === selected);
  const marked = useMemo(() => activity.filter(a => !selectedExecution || a.event.execution === selected), [activity, selectedExecution, selected]);
  const visible = marked.slice(-200);
  const omitted = marked.length - visible.length;
  const onPick = (id: string | null) => onNote(graph.data?.nodes.find(n => n.id === id && n.kind === 'note')?.ref ?? undefined);
  if (graph.isError) return <p role="alert">Map unavailable: {(graph.error as Error).message}. Pinned layouts are never silently replaced.</p>;
  if (!graph.data) return <p role="status">Loading pinned map layout…</p>;
  const data = graph.data;
  return <section aria-label="Brain Map activity">
    <p>Activity at selected time on map layout v{data.version}, built {data.builtAt}. Current topology is context only. It does not establish that these notes or links existed historically.</p>
    <p>○ R circle: read attempt · ▲ W triangle: write/edit attempt. Colors preserve sender origin: amber human, cyan agent, grey unattributed/automation. A tool result does not prove changed bytes. {selectedExecution ? 'Showing notes touched by selected execution.' : ''}</p>
    {show3d && rendererFailed && <p role="status">3D map unavailable. Use the recorded note activity below, or turn 3D off and on to retry.</p>}
    {show3d && !rendererFailed && <div ref={rendererHost} style={{ height: 420 }}><MapRendererBoundary onFailure={() => setRendererFailed(true)}><Suspense fallback={<p>Loading map renderer…</p>}><FullMap ref={mapRef} renderOnDemand graph={data} metrics={metrics} layers={layers} selected={data.nodes.find(n => n.kind === 'note' && n.ref === note)?.id ?? null} onSelect={onPick} activity={marked} /></Suspense></MapRendererBoundary></div>}
    {omitted > 0 && <p role="status">Showing the latest {visible.length} of {marked.length} path operations. {omitted} earlier operations are omitted from this list; seek earlier or filter a note to inspect them. The map retains all recorded operations.</p>}
    <ul aria-label="Note activity">{visible.map(a => <li key={a.event.id}>
      <button className="underline" onClick={() => onSelect(a.event.id)}>{operationStyle(a.event.target!.operation).glyph} {a.event.target!.operation} {fileEvidenceLevel(a.event, eventIndex, evidenceContext)}: {a.event.target!.path}</button>
      {a.node ? <> · <button className="underline" onClick={() => onNote(a.node!.ref!)}>Filter note {a.node.ref}</button> · <button className="underline" onClick={() => mapRef.current?.focus(a.node!.id)}>Focus note {a.node.ref}</button></> : <> · {a.reason}</>}
      <span> · Evidence {a.event.source.table}:{a.event.source.id} part {a.event.source.part}</span>
    </li>)}</ul>
    <p>{marked.length} evidenced path operations through cursor. Missing/deleted/moved paths are unresolved; no move inferred.</p>
  </section>;
}
