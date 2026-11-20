import type { BoundaryState, EvidenceEvent, FileObservation } from '@secondbrain/contracts/observatory';

const levels = ['attempt', 'tool-reported-success'] as const;
export type FileEvidenceLevel = typeof levels[number];
export interface BoundaryContext { boundary?: BoundaryState; from?: number }
/** Pairing is independent of success. Contradictory recorded fields cannot join files. */
export function pairedFileCall(event: EvidenceEvent, byId: ReadonlyMap<string, EvidenceEvent>): EvidenceEvent | undefined {
  if (event.kind !== 'tool_result' || !event.parent || event.at === null) return undefined;
  const parent = byId.get(event.parent);
  if (parent?.kind !== 'tool_call' || parent.at === null || parent.at > event.at) return undefined;
  if (event.tool && parent.tool && event.tool !== parent.tool ||
    event.target && parent.target && event.target.path !== parent.target.path ||
    event.context?.host && parent.context?.host && event.context.host !== parent.context.host ||
    event.session && parent.session && event.session !== parent.session ||
    event.execution && parent.execution && event.execution !== parent.execution) return undefined;
  return parent;
}
export function successfulFileResult(event: EvidenceEvent, byId: ReadonlyMap<string, EvidenceEvent>, context: BoundaryContext = {}): boolean {
  if (event.kind !== 'tool_result' || !event.parent || event.outcome !== 'success' || event.at === null) return false;
  const visibleParent = pairedFileCall(event, byId);
  const prior = context.boundary?.provenance?.[`tool:${event.parent}`];
  if (prior && (prior.execution && event.execution && prior.execution !== event.execution || prior.session && event.session && prior.session !== event.session || prior.host && event.context?.host && prior.host !== event.context.host)) return false;
  if (event.parent && byId.has(event.parent)) return !!visibleParent;
  const boundaryParent = context.from !== undefined && context.boundary?.tools[event.parent] === 'pending' &&
    prior?.event === event.parent && prior.at !== null && prior.at < context.from && prior.at <= event.at &&
    !(prior.execution && event.execution && prior.execution !== event.execution) &&
    !(prior.session && event.session && prior.session !== event.session) &&
    !(prior.host && event.context?.host && prior.host !== event.context.host) &&
    prior.source.table === 'archive_messages' && event.source.table === 'archive_messages' &&
    event.parent === `${prior.source.table}:${prior.source.id}:${prior.source.part}`;
  return !!visibleParent || !!boundaryParent;
}
/** Compatibility is observational: legacy change metadata never becomes a verified transition. */
export function fileObservationOf(event: EvidenceEvent): FileObservation | undefined {
  const observation = event.fileObservation;
  if (observation?.ownership === 'unknown' && ['runtime-observation', 'legacy-reported'].includes(observation.origin)) return observation;
  const legacy = event.change;
  return legacy ? { version: 1, id: legacy.id, repository: legacy.repository, worktree: legacy.worktree, path: legacy.path,
    observedBefore: legacy.before, observedAfter: legacy.after, ownership: 'unknown', origin: 'legacy-reported', diff: legacy.diff,
    ...(legacy.commit ? { commitMatch: legacy.commit } : {}) } : undefined;
}
export function fileEvidenceLevel(event: EvidenceEvent, byId: ReadonlyMap<string, EvidenceEvent>, context: BoundaryContext = {}): FileEvidenceLevel {
  if (event.tool === 'inspect_change_commit' || pairedFileCall(event, byId)?.tool === 'inspect_change_commit') return 'attempt';
  return successfulFileResult(event, byId, context) && event.writeEvidence === 'tool-reported-success' ? 'tool-reported-success' : 'attempt';
}
export const fileEvidenceRank = (level: FileEvidenceLevel): number => levels.indexOf(level);

/** Exact observed identity only, never proof of transition ownership. */
function observationKey(event: EvidenceEvent): string | undefined {
  const observation = fileObservationOf(event);
  return observation && event.context?.host ? JSON.stringify([event.context.host, event.session, observation.id, observation.repository, observation.worktree, observation.path, observation.observedBefore, observation.observedAfter]) : undefined;
}
/** Input is through-cursor order. A read-only Git match never invents a write target. */
export function fileTargets(events: EvidenceEvent[], context: BoundaryContext = {}): Map<string, NonNullable<EvidenceEvent['target']>> {
  const byId = new Map(events.map(event => [event.id, event]));
  const targets = new Map<string, NonNullable<EvidenceEvent['target']>>();
  const observations = new Map<string, { at: number; target: NonNullable<EvidenceEvent['target']> }>();
  for (const event of events) {
    const recordedParent = event.parent ? byId.get(event.parent) : undefined;
    const boundaryParent = event.parent ? context.boundary?.provenance?.[`tool:${event.parent}`] : undefined;
    const execution = recordedParent?.execution ?? boundaryParent?.execution;
    if (event.kind === 'tool_result' && event.execution && execution && event.execution !== execution) continue;
    const parent = pairedFileCall(event, byId);
    if (event.tool === 'inspect_change_commit' || parent?.tool === 'inspect_change_commit') continue;
    const observation = fileObservationOf(event);
    const key = successfulFileResult(event, byId, context) ? observationKey(event) : undefined;
    const previous = key ? observations.get(key) : undefined;
    const inherited = previous && event.at !== null && previous.at <= event.at ? previous.target : undefined;
    const target = event.target ?? (parent ? targets.get(parent.id) : undefined) ?? inherited;
    if (target) targets.set(event.id, target);
    if (key && target?.vaultPath && observation && event.at !== null) observations.set(key, { at: event.at, target });
  }
  return targets;
}

/** Associate a read-only content fact with prior explicit note scope without creating a write target. */
export function observationNotes(events: EvidenceEvent[], context: BoundaryContext = {}, targets = fileTargets(events, context)): Map<string, string> {
  const byId = new Map(events.map(event => [event.id, event]));
  const notes = new Map<string, string>(), prior = new Map<string, { at: number; note: string }>();
  for (const event of events) {
    if (!successfulFileResult(event, byId, context) || event.at === null) continue;
    const key = observationKey(event); if (!key) continue;
    const target = targets.get(event.id), previous = prior.get(key);
    const note = target?.vaultPath ?? (previous && previous.at <= event.at ? previous.note : undefined);
    if (note) { notes.set(event.id, note); prior.set(key, { at: event.at, note }); }
  }
  return notes;
}
