import type { EvidenceEvent, ReplayWindow } from '@secondbrain/contracts/observatory';
/** Entirely synthetic, fixed UTC range. Never mixed with source evidence. */
const from = Date.parse('2026-01-01T00:00:00Z');
function event(id: string, offset: number, kind: EvidenceEvent['kind'], origin: EvidenceEvent['actor']['kind']): EvidenceEvent {
  return { version: 1, id, at: from + offset, observedAt: null, sequence: offset, part: 0, kind, session: 'archive:12', execution: 'run:lab:first',
    context: { host: 'lab', runtime: 'codex', source: 'codex', externalSession: 'demo-session' },
    actor: { kind: origin, sender: null, channel: 'synthetic', evidence: 'synthetic fixture only' },
    source: { table: 'archive_messages', id: String(offset), part: `${offset}:0` }, precision: 'millisecond', confidence: 'recorded' };
}
export const demoWindow: ReplayWindow = {
  version: 1, from, to: from + 20000, boundary: { tickets: {}, tools: {} },
  intervals: [
    { id: 'run:lab:first', session: 'archive:12', start: from - 1000, end: from + 5000, host: 'lab', runtime: 'codex', persona: 'builder', ticket: 'demo-ticket', evidence: 'usage_runs' },
    { id: 'run:lab:parallel', session: 'archive:13', start: from + 1000, end: from + 7000, host: 'lab', runtime: 'codex', persona: 'builder', ticket: 'demo-ticket', evidence: 'usage_runs' },
    { id: 'run:lab:resumed', session: 'archive:12', start: from + 12000, end: from + 15000, host: 'lab', runtime: 'codex', persona: 'builder', ticket: 'demo-ticket', evidence: 'usage_runs' },
  ],
  events: [
    { ...event('human', 0, 'prompt', 'human'), context: undefined, source: { table: 'org_messages', id: '1', part: '0' } },
    event('scheduler', 1000, 'prompt', 'automation'),
    { ...event('call', 2000, 'tool_call', 'agent'), occurrence: 'call', tool: 'read_file', source: { table: 'archive_messages', id: '2', part: '2:call' }, target: { path: 'src/demo.ts', operation: 'read' } },
    { ...event('result', 4000, 'tool_result', 'agent'), parent: 'call', outcome: 'success' },
    { ...event('thinking', 4500, 'thinking', 'agent'), thinking: 'available-in-source' },
    { ...event('unknown', 12000, 'prompt', 'unknown'), execution: 'run:lab:resumed' },
  ],
};
