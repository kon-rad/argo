import type { EvidenceEvent, ReplayWindow } from '@secondbrain/contracts/observatory';
/** Entirely synthetic, fixed UTC range. Never mixed with source evidence. */
const from = Date.parse('2026-01-01T00:00:00Z');
function event(id: string, offset: number, kind: EvidenceEvent['kind'], origin: EvidenceEvent['actor']['kind']): EvidenceEvent {
  return { version: 1, id, at: from + offset, observedAt: null, sequence: offset, part: 0, kind, session: 'archive:12', execution: 'run:lab:first',
    context: { host: 'lab', runtime: offset >= 12000 ? 'zen-agent' : 'codex', source: offset >= 12000 ? 'zen-agent' : 'codex', externalSession: 'demo-session' },
    actor: { kind: origin, sender: null, channel: 'synthetic', evidence: 'synthetic fixture only' },
    source: { table: 'archive_messages', id: String(offset), part: `${offset}:0` }, precision: 'millisecond', confidence: 'recorded' };
}
// Deliberately legacy input: replay must label this reported observation, never a verified transition.
const demoChange = { version: 1 as const, id: 'synthetic-capture', repository: 'a'.repeat(64), worktree: 'b'.repeat(64), path: 'Projects/demo.md', before: null, after: 'f'.repeat(64), level: 'captured-diff' as const, diff: { format: 'replacement' as const, truncated: false } };
export const demoWindow: ReplayWindow = {
  version: 1, from, to: from + 20000, boundary: { tickets: {}, tools: {} },
  intervals: [
    { id: 'run:lab:first', session: 'archive:12', start: from - 1000, end: from + 5000, host: 'lab', runtime: 'codex', persona: 'builder', ticket: 'demo-ticket', evidence: 'usage_runs' },
    { id: 'run:lab:parallel', session: 'archive:13', start: from + 1000, end: from + 7000, host: 'lab', runtime: 'codex', persona: 'builder', ticket: 'demo-ticket', evidence: 'usage_runs' },
    { id: 'run:lab:resumed', session: 'archive:12', start: from + 12000, end: from + 15000, host: 'lab', runtime: 'zen-agent', persona: 'builder', ticket: 'demo-ticket', evidence: 'usage_runs' },
  ],
  events: [
    { ...event('human', 0, 'prompt', 'human'), context: undefined, source: { table: 'org_messages', id: '1', part: '0' } },
    { ...event('ticket', 500, 'ticket', 'automation'), parent: 'human', ticket: 'demo-ticket', status: 'running', execution: null, source: { table: 'card_events', id: '2', part: '0' } },
    event('scheduler', 1000, 'prompt', 'automation'),
    { ...event('call', 2000, 'tool_call', 'agent'), occurrence: 'call', tool: 'read_file', source: { table: 'archive_messages', id: '2', part: '2:call' }, target: { path: 'src/demo.ts', operation: 'read' } },
    { ...event('result', 4000, 'tool_result', 'agent'), parent: 'call', outcome: 'success' },
    { ...event('thinking', 4500, 'thinking', 'agent'), thinking: 'available-in-source' },
    { ...event('unknown', 12000, 'prompt', 'unknown'), execution: 'run:lab:resumed' },
    { ...event('write-call', 12000, 'tool_call', 'agent'), execution: 'run:lab:resumed', parent: 'human', ticket: 'demo-ticket', occurrence: 'write-call', tool: 'write_file', target: { path: 'Projects/demo.md', vaultPath: 'Projects/demo.md', operation: 'write' }, writeEvidence: 'attempt' },
    { ...event('write-result', 12500, 'tool_result', 'agent'), execution: 'run:lab:resumed', parent: 'write-call', occurrence: 'write-call', outcome: 'success', ticket: 'demo-ticket', target: { path: 'Projects/demo.md', vaultPath: 'Projects/demo.md', operation: 'write' }, writeEvidence: 'tool-reported-success', change: demoChange },
    { ...event('commit-call', 13000, 'tool_call', 'agent'), execution: 'run:lab:resumed', occurrence: 'commit-call', tool: 'inspect_change_commit', ticket: 'demo-ticket' },
    { ...event('commit-result', 14000, 'tool_result', 'agent'), execution: 'run:lab:resumed', parent: 'commit-call', occurrence: 'commit-call', outcome: 'success', ticket: 'demo-ticket', change: { ...demoChange, level: 'commit', commit: { sha: 'c'.repeat(40), verification: 'local-object', authorship: 'unknown' } } },
    ...(['pr-observed', 'review-accepted', 'merge-recorded', 'merge-verified'] as const).map((stage, i) => ({ ...event(stage, 15500 + i * 1000, 'artifact', 'automation'), execution: null, context: undefined, session: null, ticket: 'demo-ticket', source: { table: 'review_attempts' as const, id: String(i + 1), part: stage }, artifact: { repository: 'example/engine', pr: 4, head: 'c'.repeat(40), base: 'd'.repeat(40), stage, verification: 'trusted-review-gate' as const, ...(stage.startsWith('merge') ? { merge: 'e'.repeat(40) } : {}) } })),
  ],
};
