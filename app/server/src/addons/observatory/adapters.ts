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
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
/** Explicit source metadata only. Roles, handles and channel names cannot establish origin. */
export function recordedSender(raw: unknown): EvidenceEvent['actor'] {
  const sender = object(object(raw).sender);
  const kind = sender.kind === 'human' || sender.kind === 'agent' || sender.kind === 'automation' ? sender.kind : 'unknown';
  return { kind, sender: typeof sender.id === 'string' ? sender.id.slice(0, 256) : null,
    channel: typeof sender.channel === 'string' ? sender.channel.slice(0, 256) : null,
    evidence: kind === 'unknown' ? 'unrecorded-sender-kind' : 'archive-recorded-sender' };
}
export type ThinkingDetail = { availability: 'authorized-summary'; summary: string } | { availability: 'hidden' | 'unavailable' };
/** Codex explicitly separates public summary_text from encrypted/internal reasoning. Never return thinking bodies. */
export function thinkingDetail(raw: unknown): ThinkingDetail {
  const r = object(raw), p = object(r.payload);
  if (r.harness === 'codex' && p.type === 'reasoning') {
    const summary = Array.isArray(p.summary) ? p.summary.flatMap(b => { const block = object(b); return block.type === 'summary_text' && typeof block.text === 'string' ? [block.text] : []; }).join('\n').slice(0, 20000) : '';
    if (summary.trim()) return { availability: 'authorized-summary', summary };
    if (p.encrypted_content) return { availability: 'hidden' };
    return { availability: 'unavailable' };
  }
  const content = object(r.message).content;
  if (Array.isArray(content) && content.some(b => object(b).type === 'redacted_thinking' || object(b).redacted === true)) return { availability: 'hidden' };
  // A raw reasoning body is not a summary the workspace may display.
  return { availability: 'unavailable' };
}
/** Retain explicit file targets, never argument bodies or guessed shell targets. */
function fileTarget(tool: string | null, text: string): EvidenceEvent['target'] {
  const operations: Record<string, 'read' | 'write' | 'edit'> = { read: 'read', read_file: 'read', Read: 'read', write_file: 'write', Write: 'write', edit_file: 'edit', Edit: 'edit' };
  const operation = tool && Object.hasOwn(operations, tool) ? operations[tool] : undefined;
  if (!operation || text.length > 1000000) return undefined;
  try {
    const input = JSON.parse(text) as Record<string, unknown>;
    const path = input.file_path ?? input.path;
    if (typeof path === 'string' && path.length > 0 && path.length <= 1024 && !/[\x00-\x1f]/.test(path)) return { path, operation };
  } catch { /* Non-JSON input is not structured path evidence. */ }
  return undefined;
}
/** Pair only within a numeric archive session, in recorded sequence order. A repeated ID starts a new occurrence. */
export function archiveEvents(rows: ArchiveRow[]): EvidenceEvent[] {
  const pending = new Map<string, EvidenceEvent[]>();
  const events: EvidenceEvent[] = [];
  for (const row of [...new Map(rows.map(row => [row.id, row])).values()].sort((a, b) => a.session_id - b.session_id || a.seq - b.seq || a.id - b.id)) {
    expandSteps(row).forEach((part, index) => {
      const e = envelope('archive_messages', String(row.id), instant(row.ts), part.step);
      e.id += `:${part.key}`; e.source.part = part.key; e.sequence = row.seq; e.part = index; e.session = `archive:${row.session_id}`;
      e.context = { host: row.host, runtime: row.harness, source: row.source, externalSession: row.external_id };
      // Archive updated_at is session freshness, not observation time for this particular message.
      if (['response', 'thinking', 'tool_call', 'tool_result'].includes(part.step)) e.actor = { kind: 'agent', sender: null, channel: null, evidence: 'archive-step' };
      if (part.step === 'prompt') e.actor = recordedSender(row.raw);
      if (part.step === 'thinking') e.thinking = 'available-in-source';
      if (part.toolName) e.tool = part.toolName;
      if (part.step === 'tool_call') e.target = fileTarget(part.toolName, part.text);
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
