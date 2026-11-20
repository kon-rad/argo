import { fileEvidenceLevel, fileEvidenceRank, fileTargets } from './fileEvidence.js';
import { ordered, applyEvent, type EvidenceEvent, type ReplayWindow } from '@secondbrain/contracts/observatory';
import { sessionLink } from '../usage/AgentSessions.js';
export type Origin = EvidenceEvent['actor']['kind'];
export interface Filters { host?: string; session?: string; ticket?: string; runtime?: string; persona?: string; model?: string; origin?: string; note?: string }
export interface ViewState extends Filters { from: number; to: number; cursor: number; event?: string; demo?: string; layout?: string }
const filterKeys = ['host', 'session', 'ticket', 'runtime', 'persona', 'model', 'origin', 'event', 'demo', 'note', 'layout'] as const;
export function readState(params: URLSearchParams, now: number): ViewState {
  const num = (key: string, fallback: number) => { const raw = params.get(key); const n = Number(raw); return raw && Number.isSafeInteger(n) && n >= 0 && n <= 8640000000000000 ? n : fallback; };
  let to = num('to', now), from = num('from', to - 3600000);
  if (to <= from || to - from > 86400000 || from < 0) { to = now; from = Math.max(0, now - 3600000); }
  const state: ViewState = { from, to, cursor: Math.max(from, Math.min(to - 1, num('cursor', to - 1))) };
  for (const key of filterKeys) if (params.get(key)) state[key] = params.get(key)!;
  return state;
}
export function writeState(state: ViewState): URLSearchParams {
  const params = new URLSearchParams({ from: String(state.from), to: String(state.to), cursor: String(state.cursor) });
  for (const key of filterKeys) if (state[key]) params.set(key, state[key]!);
  return params;
}
/** Both spatial modes carry the entire replay contract, including hidden selections. */
export function replayHref(mode: 'map' | 'workspace', state: ViewState): string {
  const params = writeState(state);
  if (mode === 'map') params.set('activity', '1');
  return `${mode === 'map' ? '/map' : '/observatory'}?${params}`;
}
export function originStyle(origin: Origin) {
  return { human: { color: '#fbbf24', shape: 'diamond', glyph: '◆ H' }, agent: { color: '#22d3ee', shape: 'sphere', glyph: '● A' },
    automation: { color: '#9ca3af', shape: 'box', glyph: '■ automatic' }, unknown: { color: '#9ca3af', shape: 'hollow', glyph: '◇ unknown' } }[origin];
}
export function eventLink(event: EvidenceEvent): string | null {
  if (event.source.table !== 'archive_messages' || !event.context) return null;
  return `${sessionLink({ host: event.context.host, external_id: event.context.externalSession, source: event.context.source })}&part=${encodeURIComponent(event.source.part)}`;
}
export function stepCursor(window: ReplayWindow, cursor: number, direction: -1 | 1): number {
  const times = [...new Set(ordered(window.events).flatMap(e => e.at === null ? [] : [e.at]))];
  return direction === 1 ? times.find(t => t > cursor) ?? window.to - 1 : times.reverse().find(t => t < cursor) ?? window.from;
}
export interface SceneNode { id: string; label: string; kind: 'machine' | 'execution' | 'ticket' | 'event' | 'file'; origin: Origin; fx: number; fy: number; fz: number }
export interface SceneLink { source: string; target: string; result?: boolean }
function hash(id: string): number { let n = 2166136261; for (const ch of id) n = Math.imul(n ^ ch.charCodeAt(0), 16777619); return n >>> 0; }
// A loaded snapshot is immutable. Keep one sorted index per live window, reclaimed with it.
const indexes = new WeakMap<ReplayWindow, { events: EvidenceEvent[]; intervals: Map<string, ReplayWindow['intervals'][number]> }>();
/** Derive every frame from evidence through cursor. No wall clock or inferred activity. */
export function sceneAt(window: ReplayWindow, cursor: number, filters: Filters) {
  if (!Number.isFinite(cursor) || cursor < window.from || cursor >= window.to) throw new RangeError('cursor outside window');
  let index = indexes.get(window);
  if (!index) { index = { events: ordered(window.events).filter(e => e.at !== null && e.at >= window.from), intervals: new Map(window.intervals.map(i => [i.id, i])) }; indexes.set(window, index); }
  let lo = 0, hi = index.events.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (index.events[mid]!.at! <= cursor) lo = mid + 1; else hi = mid; }
  const through = index.events.slice(0, lo), byId = new Map(through.map(e => [e.id, e]));
  const models = new Map<string, Set<string>>(), latestModel = new Map<string, string>();
  const state = { tickets: { ...window.boundary.tickets }, tools: { ...window.boundary.tools }, provenance: { ...window.boundary.provenance } };
  for (const e of through) {
    applyEvent(state, e);
    if (e.execution && e.usage) { let values = models.get(e.execution); if (!values) models.set(e.execution, values = new Set()); values.add(e.usage.model); latestModel.set(e.execution, e.usage.model); }
  }
  const matches = (i: ReplayWindow['intervals'][number]) => (!filters.host || i.host === filters.host) && (!filters.session || i.session === `archive:${filters.session}`) &&
    (!filters.ticket || i.ticket === filters.ticket) && (!filters.runtime || i.runtime === filters.runtime) && (!filters.persona || i.persona === filters.persona) &&
    (!filters.model || models.get(i.id)?.has(filters.model));
  const active = window.intervals.filter(i => i.start <= cursor && cursor < i.end && matches(i)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(({ end: _end, ...i }) => i);
  const ids = new Set(active.map(i => i.id));
  const events = through.filter(e => {
    const i = e.execution ? index.intervals.get(e.execution) : undefined;
    return (!filters.host || e.context?.host === filters.host || i?.host === filters.host) && (!filters.session || e.session === `archive:${filters.session}`) &&
      (!filters.ticket || e.ticket === filters.ticket || i?.ticket === filters.ticket) && (!filters.runtime || e.context?.runtime === filters.runtime || i?.runtime === filters.runtime) &&
      (!filters.persona || i?.persona === filters.persona) && (!filters.model || e.usage?.model === filters.model || (e.execution && models.get(e.execution)?.has(filters.model))) &&
      (!filters.origin || e.actor.kind === filters.origin);
  });
  const evidenceContext = { boundary: window.boundary, from: window.from };
  const targets = fileTargets(through, evidenceContext);
  const filteredEvents = filters.note ? events.filter(e => targets.get(e.id)?.vaultPath === filters.note) : events;
  const nodes: SceneNode[] = []; const links: SceneLink[] = []; const nodeMap = new Map<string, SceneNode>();
  const fileRanks = new Map<string, number>();
  const add = (id: string, label: string, kind: SceneNode['kind'], origin: Origin, x: number, y: number, z: number) => {
    if (!nodeMap.has(id)) { const n = { id, label, kind, origin, fx: x, fy: y, fz: z }; nodeMap.set(id, n); nodes.push(n); }
  };
  // All machine positions are deterministic, including when neighbouring machines disappear.
  const position = (host: string) => { const h = hash(host); return { x: (h % 7 - 3) * 180, z: (Math.floor(h / 7) % 7 - 3) * 180 }; };
  for (const i of active) {
    const p = position(i.host), a = hash(i.id) / 4294967296 * Math.PI * 2;
    add(`machine:${i.host}`, i.host, 'machine', 'unknown', p.x, -40, p.z);
    const model = latestModel.get(i.id) ?? 'model unknown';
    add(i.id, `${i.persona ?? 'persona unknown'} · ${i.runtime} · ${model} · ${i.id}`, 'execution', 'agent', p.x + Math.cos(a) * 65, 10, p.z + Math.sin(a) * 65);
    links.push({ source: i.id, target: `machine:${i.host}` });
    if (i.ticket) { add(`ticket:${i.ticket}`, `${i.ticket}: ${state.tickets[i.ticket] ?? 'historical state unknown'}`, 'ticket', 'unknown', p.x, 100, p.z); links.push({ source: i.id, target: `ticket:${i.ticket}` }); }
  }
  // A short trail represents recorded events only. Ended executions retain no attached nodes/edges.
  for (const e of filteredEvents.filter(e => e.execution && ids.has(e.execution) && cursor - e.at! <= 2000).slice(-200)) {
    const owner = nodeMap.get(e.execution!)!;
    add(e.id, `${originStyle(e.actor.kind).glyph} ${e.kind} ${e.tool ?? ''}`, 'event', e.actor.kind, owner.fx + (hash(e.id) % 60) - 30, 55, owner.fz + 20);
    links.push({ source: e.execution!, target: e.id, result: e.kind === 'tool_result' });
    const target = targets.get(e.id);
    if (target) {
      const level = fileEvidenceLevel(e, byId, evidenceContext), rank = fileEvidenceRank(level);
      const change = rank >= fileEvidenceRank('captured-hashes') ? e.change : undefined;
      const id = `file:${e.context?.host ?? e.execution ?? e.session ?? e.id}:${change ? `${change.repository}:${change.worktree}` : e.execution ?? e.session ?? e.id}:${change?.path ?? target.path}`;
      const label = `${target.operation}: ${target.path} (${level})`;
      add(id, label, 'file', e.actor.kind, owner.fx + 85, 70, owner.fz);
      if (rank > (fileRanks.get(id) ?? -1)) { nodeMap.get(id)!.label = label; fileRanks.set(id, rank); }
      links.push({ source: e.id, target: id });
    }
  }
  // A recorded human input is an event, not proof of an executing agent/session.
  // Keep its own short pulse visible even when no execution can be established.
  for (const e of filteredEvents.filter(e => e.actor.kind === 'human' && !e.execution && cursor - e.at! <= 2000).slice(-200)) {
    const x = hash(e.actor.sender ?? e.id) % 200 - 100;
    add(e.id, `${originStyle('human').glyph} ${e.kind}: ${e.actor.sender ?? 'recorded sender'}`, 'event', 'human', x, -90, 0);
    if (e.ticket) {
      const ticket = `ticket:${e.ticket}`;
      add(ticket, `${e.ticket}: ${state.tickets[e.ticket] ?? 'historical state unknown'}`, 'ticket', 'unknown', x, 30, 0);
      links.push({ source: e.id, target: ticket });
    }
  }
  const limitedNodes = nodes.slice(0, 500), shown = new Set(limitedNodes.map(n => n.id));
  const limitedLinks = links.filter(l => shown.has(l.source) && shown.has(l.target)).slice(0, 1500);
  return { ...state, active, events: filteredEvents, contextEvents: through, evidenceContext, nodes: limitedNodes, links: limitedLinks, omittedNodes: nodes.length - limitedNodes.length, omittedLinks: links.length - limitedLinks.length };
}
