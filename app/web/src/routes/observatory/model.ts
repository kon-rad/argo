import { ordered, replay, type EvidenceEvent, type ReplayWindow } from '@secondbrain/contracts/observatory';
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
/** Derive every frame from evidence through cursor. No wall clock, inferred activity or continuous forces. */
export function sceneAt(window: ReplayWindow, cursor: number, filters: Filters) {
  const state = replay(window, cursor);
  const through = ordered(window.events).filter(e => e.at !== null && e.at <= cursor);
  const active = state.active.filter(i => (!filters.host || i.host === filters.host) && (!filters.session || i.session === `archive:${filters.session}`) &&
    (!filters.ticket || i.ticket === filters.ticket) && (!filters.runtime || i.runtime === filters.runtime) && (!filters.persona || i.persona === filters.persona) &&
    (!filters.model || through.some(e => e.execution === i.id && e.usage?.model === filters.model)));
  const ids = new Set(active.map(i => i.id));
  const events = through.filter(e => (!filters.host || e.context?.host === filters.host || active.some(i => i.id === e.execution && i.host === filters.host)) && (!filters.session || e.session === `archive:${filters.session}`) &&
    (!filters.ticket || e.ticket === filters.ticket || active.some(i => i.id === e.execution && i.ticket === filters.ticket)) &&
    (!filters.runtime || e.context?.runtime === filters.runtime || active.some(i => i.id === e.execution && i.runtime === filters.runtime)) &&
    (!filters.persona || active.some(i => i.id === e.execution && i.persona === filters.persona)) &&
    (!filters.model || e.usage?.model === filters.model || active.some(i => i.id === e.execution)) && (!filters.origin || e.actor.kind === filters.origin));
  const targets = new Map(through.filter(e => e.target).map(e => [e.id, e.target!]));
  const filteredEvents = filters.note ? events.filter(e => (e.target ?? targets.get(e.parent ?? ''))?.vaultPath === filters.note) : events;
  const nodes: SceneNode[] = []; const links: SceneLink[] = [];
  const add = (id: string, label: string, kind: SceneNode['kind'], origin: Origin, x: number, y: number, z: number) => {
    if (!nodes.some(n => n.id === id)) nodes.push({ id, label, kind, origin, fx: x, fy: y, fz: z });
  };
  // All machine positions are deterministic, including when neighbouring machines disappear.
  const position = (host: string) => { const h = hash(host); return { x: (h % 7 - 3) * 180, z: (Math.floor(h / 7) % 7 - 3) * 180 }; };
  for (const i of active) {
    const p = position(i.host), a = hash(i.id) / 4294967296 * Math.PI * 2;
    add(`machine:${i.host}`, i.host, 'machine', 'unknown', p.x, -40, p.z);
    const model = [...through].reverse().find(e => e.execution === i.id && e.usage)?.usage?.model ?? 'model unknown';
    add(i.id, `${i.persona ?? 'persona unknown'} · ${i.runtime} · ${model} · ${i.id}`, 'execution', 'agent', p.x + Math.cos(a) * 65, 10, p.z + Math.sin(a) * 65);
    links.push({ source: i.id, target: `machine:${i.host}` });
    if (i.ticket) { add(`ticket:${i.ticket}`, `${i.ticket}: ${state.tickets[i.ticket] ?? 'historical state unknown'}`, 'ticket', 'unknown', p.x, 100, p.z); links.push({ source: i.id, target: `ticket:${i.ticket}` }); }
  }
  // A short trail represents recorded events only. Ended executions retain no attached nodes/edges.
  for (const e of filteredEvents.filter(e => e.execution && ids.has(e.execution) && cursor - e.at! <= 2000).slice(-200)) {
    const owner = nodes.find(n => n.id === e.execution)!;
    add(e.id, `${originStyle(e.actor.kind).glyph} ${e.kind} ${e.tool ?? ''}`, 'event', e.actor.kind, owner.fx + (hash(e.id) % 60) - 30, 55, owner.fz + 20);
    links.push({ source: e.execution!, target: e.id, result: e.kind === 'tool_result' });
    const target = e.target ?? (e.parent ? targets.get(e.parent ?? '') : undefined);
    if (target) { const id = `file:${target.path}`; add(id, `${target.operation}: ${target.path} (attempt)`, 'file', e.actor.kind, owner.fx + 85, 70, owner.fz); links.push({ source: e.id, target: id }); }
  }
  const limitedNodes = nodes.slice(0, 500), shown = new Set(limitedNodes.map(n => n.id));
  const limitedLinks = links.filter(l => shown.has(l.source) && shown.has(l.target)).slice(0, 1500);
  return { ...state, active, events: filteredEvents, nodes: limitedNodes, links: limitedLinks, omittedNodes: nodes.length - limitedNodes.length, omittedLinks: links.length - limitedLinks.length };
}
