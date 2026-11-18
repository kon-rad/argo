/** Versioned, content-free evidence contract. Pure replay: no clock, IO or model calls. */
export type SourceTable = 'archive_messages' | 'usage_calls' | 'usage_runs' | 'card_events' | 'org_messages';
export interface EvidenceEvent {
  version: 1; id: string; at: number | null; observedAt: number | null; sequence: number; part: number;
  kind: 'prompt' | 'response' | 'thinking' | 'tool_call' | 'tool_result' | 'system' | 'meta' | 'usage' | 'ticket' | 'message';
  session: string | null; execution: string | null;
  context?: { host: string; runtime: string; source: string; externalSession: string };
  actor: { kind: 'human' | 'agent' | 'automation' | 'unknown'; sender: string | null; channel: string | null; evidence: string };
  source: { table: SourceTable; id: string; part: string }; precision: 'millisecond' | 'unknown'; confidence: 'recorded';
  parent?: string; occurrence?: string; tool?: string; outcome?: 'success' | 'error' | 'unknown';
  ticket?: string; status?: string; thinking?: 'available-in-source';
  usage?: { model: string; input: number; output: number; reasoning: number };
}
export interface ExecutionInterval {
  id: string; session: string | null; start: number; end: number; host: string; runtime: string;
  persona: string | null; ticket: string | null; evidence: 'usage_runs';
}
export interface BoundaryState {
  tickets: Record<string, string>; tools: Record<string, string>;
  provenance?: Record<string, { event: string; source: EvidenceEvent['source']; at: number | null }>;
}
export interface ReplayWindow {
  version: 1; from: number; to: number; intervals: ExecutionInterval[]; boundary: BoundaryState; events: EvidenceEvent[];
}
const lexical = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export const compareEvents = (a: EvidenceEvent, b: EvidenceEvent): number =>
  (a.at ?? Infinity) - (b.at ?? Infinity) || lexical(a.session ?? '', b.session ?? '') || a.sequence - b.sequence || a.part - b.part || lexical(a.id, b.id);
export function ordered(events: EvidenceEvent[]): EvidenceEvent[] {
  return [...new Map(events.map(e => [e.id, e])).values()].sort(compareEvents);
}
export function applyEvent(state: BoundaryState, event: EvidenceEvent): void {
  const record = (key: string) => { if (state.provenance) state.provenance[key] = { event: event.id, source: { ...event.source }, at: event.at }; };
  if (event.kind === 'ticket' && event.ticket && event.status) { state.tickets[event.ticket] = event.status; record(`ticket:${event.ticket}`); }
  if (event.kind === 'tool_call' && event.occurrence) { state.tools[event.occurrence] = 'pending'; record(`tool:${event.occurrence}`); }
  if (event.kind === 'tool_result' && event.parent) { state.tools[event.parent] = event.outcome ?? 'unknown'; record(`tool:${event.parent}`); }
}
export function replay(window: ReplayWindow, cursor: number): BoundaryState & { active: Omit<ExecutionInterval, 'end'>[] } {
  if (!Number.isFinite(cursor) || cursor < window.from || cursor >= window.to) throw new RangeError('cursor outside window');
  const state: BoundaryState = { tickets: { ...window.boundary.tickets }, tools: { ...window.boundary.tools }, provenance: structuredClone(window.boundary.provenance ?? {}) };
  const events = ordered(window.events).filter(e => e.at !== null && e.at >= window.from);
  let lo = 0, hi = events.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (events[mid]!.at! <= cursor) lo = mid + 1; else hi = mid; }
  for (let i = 0; i < lo; i++) applyEvent(state, events[i]!);
  return { ...state, active: window.intervals.filter(i => i.start <= cursor && cursor < i.end).sort((a, b) => lexical(a.id, b.id)).map(({ end: _end, ...visible }) => visible) };
}
