import type { BoundaryState, EvidenceEvent } from '@secondbrain/contracts/observatory';

const levels = ['attempt', 'tool-reported-success', 'captured-hashes', 'captured-diff', 'commit'] as const;
export type FileEvidenceLevel = typeof levels[number];
export interface BoundaryContext { boundary?: BoundaryState; from?: number }
export function fileEvidenceLevel(event: EvidenceEvent, byId: ReadonlyMap<string, EvidenceEvent>, context: BoundaryContext = {}): FileEvidenceLevel {
  if (event.kind !== 'tool_result' || !event.parent || event.outcome === 'error' || event.at === null) return 'attempt';
  const parent = byId.get(event.parent);
  const visibleParent = parent?.kind === 'tool_call' && parent.at !== null && parent.at <= event.at;
  const prior = context.boundary?.provenance?.[`tool:${event.parent}`];
  const boundaryParent = context.from !== undefined && context.boundary?.tools[event.parent] === 'pending' &&
    prior?.event === event.parent && prior.at !== null && prior.at < context.from && prior.at <= event.at &&
    prior.source.table === 'archive_messages' && event.source.table === 'archive_messages' &&
    event.parent === `${prior.source.table}:${prior.source.id}:${prior.source.part}`;
  if (!visibleParent && !boundaryParent) return 'attempt';
  return event.change?.level ?? event.writeEvidence ?? 'attempt';
}
export const fileEvidenceRank = (level: FileEvidenceLevel): number => levels.indexOf(level);

/** Exact recorded capture identity only; never borrow scope by pathname or suffix. */
function captureKey(event: EvidenceEvent): string | undefined {
  const change = event.change;
  return change && event.context?.host ? JSON.stringify([event.context.host, event.session, change.id, change.repository, change.worktree, change.path]) : undefined;
}
/** Input is the recorded through-cursor order. No later event can establish earlier vault scope. */
export function fileTargets(events: EvidenceEvent[], context: BoundaryContext = {}): Map<string, NonNullable<EvidenceEvent['target']>> {
  const byId = new Map(events.map(event => [event.id, event]));
  const targets = new Map<string, NonNullable<EvidenceEvent['target']>>();
  const captures = new Map<string, { at: number; target: NonNullable<EvidenceEvent['target']> }>();
  for (const event of events) {
    const level = fileEvidenceLevel(event, byId, context);
    const key = level !== 'attempt' ? captureKey(event) : undefined;
    const previous = key ? captures.get(key) : undefined;
    const inherited = previous && event.at !== null && previous.at <= event.at ? previous.target : undefined;
    const parent = event.parent ? byId.get(event.parent) : undefined;
    const pairedTarget = parent?.kind === 'tool_call' && parent.at !== null && event.at !== null && parent.at <= event.at ? targets.get(parent.id) : undefined;
    let target = event.target ?? pairedTarget ?? inherited ??
      (level !== 'attempt' && event.change ? { path: event.change.path, operation: 'edit' as const } : undefined);
    // The adapter's commit fallback has a repository path but no vault scope.
    // Restore only independently recorded scope for this exact earlier capture identity.
    if (target && !target.vaultPath && inherited?.vaultPath &&
      (target.path === event.change?.path || target.path === inherited.path)) target = { ...target, vaultPath: inherited.vaultPath };
    if (target) targets.set(event.id, target);
    if (key && target?.vaultPath && event.at !== null) captures.set(key, { at: event.at, target });
  }
  return targets;
}
