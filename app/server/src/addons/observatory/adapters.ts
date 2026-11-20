import { vaultPath } from './paths.js';
import { expandSteps } from '../../archive/steps.js';
import { applyEvent, ordered, type BoundaryState, type EvidenceEvent, type ReplayWindow } from '@secondbrain/contracts/observatory';
export interface ArchiveRow {
  id: number; session_id: number; seq: number; ts: Date | null; role: string; kind: string; raw: unknown; text: string;
  host: string; source: string; external_id: string; harness: string; observed_at: Date | null;
}
export const instant = (v: Date | string | null): number | null => v === null ? null : new Date(v).getTime();
export function envelope(table: EvidenceEvent['source']['table'], id: string, at: number | null, kind: EvidenceEvent['kind']): EvidenceEvent {
  return { version: 1, id: `${table}:${id}`, at, observedAt: null, sequence: 0, part: 0, kind, session: null, execution: null,
    source: { table, id, part: '0' }, precision: 'unknown', confidence: 'recorded',
    actor: { kind: 'unknown', sender: null, channel: null, evidence: 'unrecorded' } };
}
/** Retain explicit file targets, never argument bodies or guessed shell targets. */
function fileTarget(tool: string | null, text: string, root?: string): EvidenceEvent['target'] {
  const operations: Record<string, 'read' | 'write' | 'edit'> = { read: 'read', read_file: 'read', Read: 'read', write_file: 'write', Write: 'write', edit_file: 'edit', Edit: 'edit' };
  const operation = tool && Object.hasOwn(operations, tool) ? operations[tool] : undefined;
  if (!operation || text.length > 1000000) return undefined;
  try {
    const input = JSON.parse(text) as Record<string, unknown>;
    const path = input.file_path ?? input.path;
    if (typeof path === 'string' && path.length > 0 && path.length <= 1024 && !/[\x00-\x1f]/.test(path)) {
      const relative = vaultPath(path, root);
      return { path, operation, ...(relative ? { vaultPath: relative } : {}) };
    }
  } catch { /* Non-JSON input is not structured path evidence. */ }
  return undefined;
}
/** Pair only within a numeric archive session, in recorded sequence order. A repeated ID starts a new occurrence. */
export function archiveEvents(rows: ArchiveRow[], root?: string): EvidenceEvent[] {
  const pending = new Map<string, EvidenceEvent[]>();
  const events: EvidenceEvent[] = [];
  for (const row of [...new Map(rows.map(row => [row.id, row])).values()].sort((a, b) => a.session_id - b.session_id || a.seq - b.seq || a.id - b.id)) {
    expandSteps(row).forEach((part, index) => {
      const e = envelope('archive_messages', String(row.id), instant(row.ts), part.step);
      e.id += `:${part.key}`; e.source.part = part.key; e.sequence = row.seq; e.part = index; e.session = `archive:${row.session_id}`;
      e.context = { host: row.host, runtime: row.harness, source: row.source, externalSession: row.external_id };
      // Archive updated_at is session freshness, not observation time for this particular message.
      if (['response', 'thinking', 'tool_call', 'tool_result'].includes(part.step)) e.actor = { kind: 'agent', sender: null, channel: null, evidence: 'archive-step' };
      if (part.step === 'thinking') e.thinking = 'available-in-source';
      if (part.toolName) e.tool = part.toolName;
      if (part.step === 'tool_call') e.target = fileTarget(part.toolName, part.text, root);
      const scope = `${row.session_id}:${part.toolCallId}`;
      if (part.step === 'tool_call') { e.occurrence = e.id; if (part.toolCallId) pending.set(scope, [...(pending.get(scope) ?? []), e]); }
      if (part.step === 'tool_result') {
        const candidates = part.toolCallId ? pending.get(scope) : undefined;
        const call = candidates?.length === 1 ? candidates[0] : undefined;
        // A result with a contradictory timestamp cannot complete a future call.
        if (call && call.at !== null && e.at !== null && call.at <= e.at) { e.parent = call.id; e.occurrence = call.id; pending.delete(scope); }
        e.outcome = part.isError === true ? 'error' : part.isError === false ? 'success' : 'unknown';
      }
      events.push(e);
    });
  }
  return ordered(events);
}
export function makeWindow(from: number, to: number, events: EvidenceEvent[], intervals: ReplayWindow['intervals']): ReplayWindow {
  const boundary: BoundaryState = { tickets: {}, tools: {}, provenance: {} };
  for (const e of ordered(events)) if (e.at !== null && e.at < from) applyEvent(boundary, e);
  return { version: 1, from, to, boundary, intervals, events: ordered(events).filter(e => e.at === null || (e.at >= from && e.at < to)) };
}
