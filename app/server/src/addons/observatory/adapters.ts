import { createHash } from 'node:crypto';
import { capturedChange, fileObservation, fileObservationMetadataPresent, sameChange } from '../../archive/changeEvidence.js';
import { vaultPath } from './paths.js';
import { expandSteps } from '../../archive/steps.js';
import { applyEvent, ordered, type BoundaryState, type EvidenceEvent, type ReplayWindow } from '@secondbrain/contracts/observatory';
export interface ArchiveRow {
  id: number; session_id: number; seq: number; ts: Date | null; role: string; kind: string; raw: unknown; text: string;
  change_evidence?: unknown; file_observation?: unknown;
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
function noteKey(path: string): string | undefined {
  // Accept canonical keys only; retain ambiguous, hidden and traversal paths unresolved.
  return !/[\\:]/.test(path) && path.split('/').every(part => part.length > 0 && !part.startsWith('.')) ? path : undefined;
}
/** Retain explicit file targets, never argument bodies or guessed shell targets. */
export function fileTarget(tool: string | null, text: string, root?: string, harness?: string): EvidenceEvent['target'] {
  const operations: Record<string, 'read' | 'write' | 'edit'> = { read: 'read', read_file: 'read', Read: 'read', read_note: 'read', write_note: 'write', write_file: 'write', Write: 'write', edit_file: 'edit', Edit: 'edit' };
  const operation = tool && Object.hasOwn(operations, tool) ? operations[tool] : undefined;
  if (!operation || text.length > 1000000) return undefined;
  try {
    const input = object(JSON.parse(text));
    const path = tool === 'read_note' || tool === 'write_note' ? input.path : input.file_path ?? input.path;
    if (typeof path === 'string' && path.length > 0 && path.length <= 1024 && !/[\x00-\x1f]/.test(path)) {
      // zen knowledgeTools.read_note sends a vault key to GET /api/file/source.
      // No write_note backend exists here, so its name cannot establish relative scope.
      const relative = tool === 'read_note' && harness === 'zen-agent'
        ? noteKey(path) : vaultPath(path, root);
      return { path, operation, ...(relative ? { vaultPath: relative } : {}) };
    }
  } catch { /* Non-JSON input is not structured path evidence. */ }
  return undefined;
}
export interface InspectChangeRequest { capture: string; commit: string }
/** Safe request metadata for bounded collectors; discard all unrelated argument fields. */
export function inspectChangeRequest(tool: string | null, text: string): InspectChangeRequest | undefined {
  if (tool !== 'inspect_change_commit' || text.length > 1000000) return undefined;
  try {
    const args = object(JSON.parse(text));
    if (typeof args.capture === 'string' && args.capture.length > 0 && args.capture.length <= 128 &&
      typeof args.commit === 'string' && /^[a-f0-9]{40}$/.test(args.commit)) return { capture: args.capture, commit: args.commit };
  } catch { /* Missing/invalid request bindings cannot establish commit attribution. */ }
  return undefined;
}
/** Presence must survive bounded projection even when validation fails. */
export function captureMetadataPresent(raw: unknown): boolean {
  return fileObservationMetadataPresent(raw);
}
export interface CapturedRequestBinding { present: boolean; request?: { path: string; resolvedPath: string } }
export interface RecordedResultPath { present: boolean; path?: string }
/** Explicit structured result metadata only; never parse text/arguments to guess a path. */
export function recordedResultPath(raw: unknown): RecordedResultPath {
  const r = object(raw);
  const containers = [object(object(r.message).details), object(r.details), object(object(object(r.payload).output).details)];
  let present = false, path: string | undefined;
  for (const details of containers) for (const key of ['path', 'file_path']) {
    if (!Object.hasOwn(details, key)) continue;
    present = true; const value = details[key];
    if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > 4096 || /[\x00-\x1f]/.test(value) || path !== undefined && path !== value) return { present: true };
    path = value;
  }
  return present ? { present: true, path } : { present: false };
}
/** Source-only runtime binding. Presence must survive projection even if malformed. */
export function capturedRequestBinding(raw: unknown): CapturedRequestBinding {
  const details = object(object(object(raw).message).details);
  if (!Object.hasOwn(details, 'captureRequest')) return { present: false };
  const request = object(details.captureRequest), path = request.path, resolvedPath = request.resolvedPath;
  if (typeof path !== 'string' || !path.length || path.length > 1024 || /[\x00-\x1f]/.test(path) ||
    typeof resolvedPath !== 'string' || Buffer.byteLength(resolvedPath) > 4096 || !resolvedPath.startsWith('/') ||
    /[\\\x00-\x1f]/.test(resolvedPath) || resolvedPath.split('/').slice(1).some(p => !p || p === '.' || p === '..')) return { present: true };
  return { present: true, request: { path, resolvedPath } };
}
function knownNamelessResult(row: ArchiveRow): boolean {
  const raw = object(row.raw);
  return (row.harness === 'codex' && raw.harness === 'codex' &&
    ['function_call_output', 'custom_tool_call_output'].includes(String(object(raw.payload).type))) ||
    (row.harness === 'claude-code' && raw.type === 'user') ||
    (row.harness === 'hermes' && raw.role === 'tool' && typeof raw.tool_call_id === 'string' && raw.tool_call_id.length > 0);
}
function absoluteCapturePath(path: string, change: NonNullable<EvidenceEvent['fileObservation']>): boolean {
  const suffix = `/${change.path}`;
  if (!path.startsWith('/') || !path.endsWith(suffix) || path.split('/').some(p => p === '.' || p === '..')) return false;
  const root = path.slice(0, -suffix.length) || '/';
  return createHash('sha256').update(root).digest('hex') === change.worktree;
}
/** Match explicit runtime resolution, or the conservative legacy contract when absent. */
export function capturePathMatches(path: string, change: NonNullable<EvidenceEvent['fileObservation']>, binding: CapturedRequestBinding): boolean {
  if (binding.present) return !!binding.request && binding.request.path === path && absoluteCapturePath(binding.request.resolvedPath, change);
  return path === change.path || absoluteCapturePath(path, change);
}
export function resultPathMatches(path: string, result: RecordedResultPath, binding: CapturedRequestBinding, change?: NonNullable<EvidenceEvent['fileObservation']>): boolean {
  if (!result.present) return true;
  if (!result.path) return false;
  if (result.path === path) return true;
  return !!change && binding.present && !!binding.request && capturePathMatches(path, change, binding) && result.path === binding.request.resolvedPath;
}
/** Compare the exact argument to capture identity, never basename/suffix alone. */
function capturedTarget(call: EvidenceEvent, change: NonNullable<EvidenceEvent['fileObservation']>, binding: CapturedRequestBinding, request?: InspectChangeRequest): boolean {
  if (call.tool === 'inspect_change_commit') return !binding.present && !!request && request.capture === change.id && request.commit === change.commitMatch?.sha;
  return !!call.target && capturePathMatches(call.target.path, change, binding);
}
/** Pair only within a numeric archive session, in recorded sequence order. A repeated ID starts a new occurrence. */
export function archiveEvents(rows: ArchiveRow[], root?: string): EvidenceEvent[] {
  const pending = new Map<string, EvidenceEvent[]>();
  const commitRequests = new Map<string, InspectChangeRequest>();
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
      if (part.step === 'tool_call') { e.target = fileTarget(part.toolName, part.text, root, row.harness); if (e.target && e.target.operation !== 'read') e.writeEvidence = 'attempt'; }
      const request = part.step === 'tool_call' ? inspectChangeRequest(part.toolName, part.text) : undefined;
      if (request) commitRequests.set(e.id, request);
      const scope = `${row.session_id}:${part.toolCallId}`;
      if (part.step === 'tool_call') { e.occurrence = e.id; if (part.toolCallId) pending.set(scope, [...(pending.get(scope) ?? []), e]); }
      if (part.step === 'tool_result') {
        const candidates = part.toolCallId ? pending.get(scope) : undefined;
        const candidate = candidates?.length === 1 ? candidates[0] : undefined;
        const captured = fileObservation(row.raw);
        const hasCapture = captureMetadataPresent(row.raw);
        const binding = capturedRequestBinding(row.raw);
        const resultPath = recordedResultPath(row.raw);
        // Codex, Claude and Hermes can omit result names by protocol; an explicitly contradictory name never pairs.
        const toolMatches = candidate && (part.toolName !== null ? candidate.tool === part.toolName : knownNamelessResult(row));
        const pathMatches = !candidate?.target || candidate.target.operation === 'read' || resultPathMatches(candidate.target.path, resultPath, binding, captured ?? undefined);
        const call = candidate && toolMatches && pathMatches &&
          (!(hasCapture || binding.present) || (captured && capturedTarget(candidate, captured, binding, commitRequests.get(candidate.id)))) ? candidate : undefined;
        // A result with a contradictory timestamp cannot complete a future call.
        if (call && call.at !== null && e.at !== null && call.at <= e.at) { e.parent = call.id; e.occurrence = call.id; pending.delete(scope); }
        e.outcome = part.isError === true ? 'error' : part.isError === false ? 'success' : 'unknown';
        // Capture metadata must also agree with the paired tool and path above.
        // Revalidate against the archived result. A stale or hand-edited projection cannot upgrade evidence.
        if (call && e.parent && captured && (sameChange(captured, row.file_observation) || captured.origin === 'legacy-reported' && sameChange(capturedChange(row.raw), row.change_evidence))) e.fileObservation = captured;
        if (call && e.parent && call.target) {
          e.target = call.target;
          if (call.target.operation !== 'read' && e.outcome === 'success') e.writeEvidence = 'tool-reported-success';
        }
        if (e.fileObservation && binding.present && binding.request && e.target && !e.target.vaultPath) {
          const scoped = vaultPath(binding.request.resolvedPath, root);
          if (scoped) e.target = { ...e.target, vaultPath: scoped };
        }
        // Commit-byte inspection is a content fact, never a write/map operation.
        if (e.tool === 'inspect_change_commit') { delete e.target; delete e.writeEvidence; }
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
