import type { EvidenceEvent } from '@secondbrain/contracts/observatory';
import type { MapGraph, MapNodeData } from '../../lib/mapData.js';
export function operationStyle(operation: 'read' | 'write' | 'edit', origin: EvidenceEvent['actor']['kind'] = 'unknown') {
  const color = { human: '#fbbf24', agent: '#22d3ee', automation: '#9ca3af', unknown: '#9ca3af' }[origin];
  return { glyph: operation === 'read' ? '○ R' : '▲ W', color };
}
export interface NoteActivity { event: EvidenceEvent; node?: MapNodeData; reason?: string }
/** No basename, suffix, case-folding or inferred move resolution. Raw paths retain their evidence. */
export function mapActivity(graph: MapGraph, events: EvidenceEvent[]): NoteActivity[] {
  const refs = new Map<string, MapNodeData[]>();
  for (const node of graph.nodes) if (node.kind === 'note' && node.ref) refs.set(node.ref, [...(refs.get(node.ref) ?? []), node]);
  return events.filter(e => (e.kind === 'tool_call' || (e.kind === 'tool_result' && e.change)) && e.target).map(event => {
    const path = event.target!.vaultPath;
    const candidates = path ? refs.get(path) ?? [] : [];
    return { event, node: candidates.length === 1 ? candidates[0] : undefined,
      reason: !path ? 'Repository/path target; vault scope unknown' : candidates.length === 0 ? 'Unresolved: missing, moved, deleted or absent from this layout' : candidates.length > 1 ? 'Unresolved: ambiguous exact reference' : undefined };
  });
}
